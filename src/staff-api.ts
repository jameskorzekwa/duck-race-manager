import type { StaffActor } from "./auth.ts";
import {
  canViewParticipantPii,
  hasAnyRole,
  normalizeOperationalRoles,
  requireAnyRole,
  type OperationalRole,
} from "./authorization.ts";
import { publicDuckName } from "./duck-name-filter.ts";
import { winnerByTagCandidate, winnerByTagIneligible } from "./heat-operations.ts";
import { isLookupCode, normalizeLookupCode } from "./participant-qr.ts";
import { isCommandId } from "./registration.ts";
import {
  cognitoStaffProvisioner,
  type StaffIdentityProvisioner,
} from "./staff-access.ts";
import type { Env } from "./types.ts";
import {
  heatNotificationStatement,
  publishPendingParticipantNotifications,
} from "./email-notifications.ts";
import { heatHasNeverStartedSql, unstartedRoundOneHeatExistsSql } from "./walk-up-admission.ts";

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
} as const;

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers });

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > 8_192) return null;
  try {
    const body = await request.text();
    if (body.length > 8_192) return null;
    const parsed = JSON.parse(body) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const validEntityId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const hashValue = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

interface StaffProfileRow {
  id: string;
  email: string;
  display_name: string | null;
  is_system_admin: number;
  role_revision: number;
  roles_csv: string;
  created_at: string;
  requested_account_type?: "ADMIN" | "STAFF";
  requested_roles_json?: string;
}

const rolesFromCsv = (value: string | undefined): OperationalRole[] => {
  const roles = value === undefined || value === "" ? [] : value.split(",");
  return normalizeOperationalRoles(roles) ?? [];
};

const staffProfileResponse = (
  profile: StaffProfileRow,
  accountType: "ADMIN" | "STAFF" = profile.is_system_admin === 1 ? "ADMIN" : "STAFF",
  roles: OperationalRole[] = rolesFromCsv(profile.roles_csv),
): Record<string, unknown> => ({
  id: profile.id,
  email: profile.email,
  displayName: profile.display_name,
  role: accountType,
  roles: accountType === "ADMIN" ? [] : roles,
  roleRevision: profile.role_revision ?? 0,
  createdAt: profile.created_at,
});

const listStaffProfiles = async (env: Env, actor: StaffActor): Promise<Response> => {
  if (!actor.isSystemAdmin) return json({ error: "Administrator permission required." }, 403);
  const profiles = await env.DB.prepare(
    `SELECT p.id, p.email, p.display_name, p.is_system_admin, p.role_revision,
            p.created_at, COALESCE(GROUP_CONCAT(a.role, ','), '') AS roles_csv
       FROM staff_profiles p
       LEFT JOIN staff_role_assignments a
         ON a.staff_profile_id = p.id AND a.revoked_at IS NULL
      GROUP BY p.id
      ORDER BY p.is_system_admin DESC, COALESCE(p.display_name, p.email) COLLATE NOCASE, p.email COLLATE NOCASE
      LIMIT 200`,
  ).all<StaffProfileRow>();
  return json({ staff: profiles.results.map((profile) => staffProfileResponse(profile)) });
};

const addStaffProfile = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  provisioner: StaffIdentityProvisioner,
): Promise<Response> => {
  if (!actor.isSystemAdmin) return json({ error: "Administrator permission required." }, 403);
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase() : "";
  const displayName = typeof payload?.displayName === "string"
    ? payload.displayName.trim().replace(/\s+/g, " ")
    : "";
  const role = payload?.role;
  const roles = role === "STAFF"
    ? normalizeOperationalRoles(payload?.roles, true)
    : normalizeOperationalRoles(payload?.roles ?? []);
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || displayName.length === 0 || displayName.length > 100
    || (role !== "STAFF" && role !== "ADMIN")
    || roles === null || (role === "ADMIN" && roles.length !== 0)
  ) {
    return json({ error: "Command, valid email, display name, account type, and operational roles are required." }, 400);
  }
  const rolesJson = JSON.stringify(roles);

  const replay = await env.DB.prepare(
    `SELECT p.id, p.email, p.display_name, p.is_system_admin, p.role_revision,
            p.created_at, '' AS roles_csv,
            c.requested_account_type, c.requested_roles_json
       FROM staff_access_commands c
       JOIN staff_profiles p ON p.id = c.target_staff_profile_id
      WHERE c.id = ? AND c.command_type = 'ADD_STAFF'
      LIMIT 1`,
  ).bind(commandId).first<StaffProfileRow>();
  if (replay !== null) {
    if (
      replay.email !== email || replay.display_name !== displayName
      || replay.requested_account_type !== role || replay.requested_roles_json !== rolesJson
    ) {
      return json({ error: "This command identifier was already used for another staff account." }, 409);
    }
    return json({ staff: staffProfileResponse(replay, role, roles), replayed: true });
  }

  const existingProfile = await env.DB.prepare(
    "SELECT id FROM staff_profiles WHERE email = ? COLLATE NOCASE LIMIT 1",
  ).bind(email).first<{ id: string }>();
  if (existingProfile !== null) return json({ error: "That email already has staff access." }, 409);

  let identity;
  try {
    identity = await provisioner.create(email, displayName, env);
  } catch {
    return json({ error: "Cognito could not provision this staff account. Try again." }, 502);
  }

  const now = new Date().toISOString();
  const profileId = crypto.randomUUID();
  try {
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT INTO staff_profiles
          (id, cognito_sub, email, display_name, is_system_admin, created_by_staff_profile_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(profileId, identity.cognitoSub, email, displayName, role === "ADMIN" ? 1 : 0, actor.id),
      env.DB.prepare(
        `INSERT INTO staff_access_commands
          (id, command_type, target_staff_profile_id, requested_by_staff_profile_id,
           requested_at, completed_at, requested_account_type, requested_roles_json)
         VALUES (?, 'ADD_STAFF', ?, ?, ?, ?, ?, ?)`,
      ).bind(commandId, profileId, actor.id, now, now, role, rolesJson),
      env.DB.prepare(
        `INSERT INTO staff_access_audit_events
          (id, command_id, actor_staff_profile_id, target_staff_profile_id, action, occurred_at, details_json)
         VALUES (?, ?, ?, ?, 'STAFF_ACCESS_GRANTED', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        commandId,
        actor.id,
        profileId,
        now,
        JSON.stringify({ accountType: role, roles }),
      ),
    ];
    for (const operationalRole of roles) {
      statements.push(env.DB.prepare(
        `INSERT INTO staff_role_assignments
          (id, staff_profile_id, role, assigned_at, assigned_by_staff_profile_id, source_access_command_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(crypto.randomUUID(), profileId, operationalRole, now, actor.id, commandId));
    }
    await env.DB.batch(statements);
  } catch {
    if (identity.created) {
      try {
        await provisioner.delete(identity.username, env);
      } catch {
        // The Cognito identity remains unauthorized without a staff profile.
      }
    }
    return json({ error: "Staff access conflicted with another update. Refresh and try again." }, 409);
  }

  return json({
    staff: staffProfileResponse({
      id: profileId,
      email,
      display_name: displayName,
      is_system_admin: role === "ADMIN" ? 1 : 0,
      role_revision: 0,
      roles_csv: roles.join(","),
      created_at: now,
    }, role, roles),
    replayed: false,
  }, 201);
};

interface StaffDuckRow {
  duck_id: string;
  visible_number: number;
  inventory_status: string;
  duck_revision: number;
  tag_status: string;
  event_duck_id: string | null;
  event_name: string | null;
  event_status: string | null;
  assignment_id: string | null;
  assignment_valid_to: string | null;
  event_id: string | null;
  race_entry_id: string | null;
  registration_id: string | null;
  duck_name: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  email_notifications_enabled: number;
  phone: string | null;
  lookup_code: string | null;
  registration_status: string | null;
}

const getStaffDuck = async (token: string, env: Env, actor: StaffActor): Promise<Response> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return json({ error: "Duck not found." }, 404);
  const duck = await env.DB.prepare(
    `SELECT d.id AS duck_id, d.visible_number, d.inventory_status,
             d.revision AS duck_revision, dt.status AS tag_status,
             ed.id AS event_duck_id,
            e.name AS event_name, e.status AS event_status,
            da.id AS assignment_id, da.valid_to AS assignment_valid_to,
            ed.event_id, da.race_entry_id, re.duck_name,
            r.id AS registration_id,
            r.first_name, r.last_name, r.email, r.phone, r.lookup_code,
            r.email_notifications_enabled,
            r.status AS registration_status
       FROM duck_tags dt
       JOIN ducks d ON d.id = dt.duck_id
        LEFT JOIN event_ducks ed ON ed.id = (
          SELECT ed2.id
            FROM event_ducks ed2
           WHERE ed2.duck_id = d.id AND ed2.released_at IS NULL
          ORDER BY ed2.reserved_at DESC
          LIMIT 1
       )
       LEFT JOIN events e ON e.id = ed.event_id
       LEFT JOIN duck_assignments da ON da.id = (
          SELECT da2.id
            FROM duck_assignments da2
           WHERE da2.event_duck_id = ed.id AND da2.valid_to IS NULL
           ORDER BY da2.valid_from DESC
          LIMIT 1
       )
       LEFT JOIN race_entries re ON re.id = da.race_entry_id
       LEFT JOIN registrations r ON r.id = re.registration_id
      WHERE dt.token = ?
      ORDER BY CASE dt.status WHEN 'ACTIVE' THEN 0 ELSE 1 END
      LIMIT 1`,
  ).bind(token).first<StaffDuckRow>();
  if (duck === null) return json({ error: "Duck not found." }, 404);

  const includePii = canViewParticipantPii(actor);
  const canReplace = hasAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
  // Both racing rounds publish their result by scanning the ducks that
  // finished, so this page carries the action in both of them. Round one offers
  // one winner; the final offers the places its podium still has open.
  const resultTaker = hasAnyRole(actor, ["RESULT_TAKER", "RACE_DIRECTOR"])
    && duck.assignment_id !== null
    && (duck.event_status === "ROUND_ONE" || duck.event_status === "FINAL");
  const winnerAction = resultTaker ? await winnerByTagCandidate(env, token) : null;
  // A duck paired to a racer who later withdrew or was disqualified is still in
  // its heat bag and still in the water, so it can still reach the line first.
  // The scan station must therefore name that outcome plainly instead of
  // silently offering no winner button at all.
  const winnerIneligible = resultTaker && winnerAction === null
    ? await winnerByTagIneligible(env, token)
    : null;
  const assignment = duck.assignment_id === null ? null : {
    id: duck.assignment_id,
    active: duck.assignment_valid_to === null,
    eventId: duck.event_id,
    raceEntryId: duck.race_entry_id,
    participant: includePii ? {
      // The registration identifier and the stored duck name ship only to the
      // roles that may clear that name, which is the same
      // REGISTRATION/RACE_DIRECTOR set `canViewParticipantPii` describes and the
      // same set the clear endpoint enforces. A duck manager keeps the narrow
      // projection and is offered no moderation control.
      registrationId: duck.registration_id,
      duckName: duck.duck_name,
      duckNamePubliclyHidden: duck.duck_name !== null && publicDuckName(duck.duck_name) === null,
      firstName: duck.first_name,
      lastName: duck.last_name,
      email: duck.email,
      phone: duck.phone,
      lookupCode: duck.lookup_code,
      registrationStatus: duck.registration_status,
    } : {
      registrationStatus: duck.registration_status,
    },
  };
  return json({
    permissions: {
      pair: hasAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]),
      replace: canReplace,
    },
    duck: {
      id: duck.duck_id,
      visibleNumber: duck.visible_number,
      inventoryStatus: duck.inventory_status,
      revision: duck.duck_revision,
      tagStatus: duck.tag_status,
      reservationId: duck.event_duck_id,
    },
    pairingRequired: hasAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"])
      && duck.assignment_id === null
      && duck.tag_status === "ACTIVE"
      && ["AVAILABLE", "RESERVED_FOR_EVENT"].includes(duck.inventory_status),
    emergencyReplacementEligible: canReplace
      && duck.assignment_id === null
      && duck.tag_status === "ACTIVE"
      && ["AVAILABLE", "RESERVED_FOR_EVENT"].includes(duck.inventory_status),
    event: duck.event_id === null ? null : {
      id: duck.event_id,
      name: duck.event_name,
      status: duck.event_status,
    },
    assignment,
    winnerAction,
    winnerIneligible,
  });
};

interface ReplacementCandidateRow {
  event_id: string;
  event_status: "ROUND_ONE" | "FINAL";
  event_revision: number;
  registration_id: string;
  registration_revision: number;
  race_entry_id: string;
  race_entry_revision: number;
  first_name: string;
  last_name: string;
  assignment_id: string;
  current_duck_id: string;
  current_duck_number: number;
  current_duck_revision: number;
  round_one_heat_id: string | null;
  round_one_heat_number: number | null;
  round_one_heat_status: string | null;
  round_one_heat_revision: number | null;
  round_one_slot_number: number | null;
  final_heat_id: string | null;
  final_heat_number: number | null;
  final_heat_status: string | null;
  final_heat_revision: number | null;
  final_slot_number: number | null;
  round_one_place: number | null;
  final_place: number | null;
}

const replacementCandidateSelect = `
  SELECT e.id AS event_id, e.status AS event_status, e.revision AS event_revision,
         r.id AS registration_id, r.revision AS registration_revision,
         re.id AS race_entry_id, re.revision AS race_entry_revision,
         r.first_name, r.last_name,
         da.id AS assignment_id, d.id AS current_duck_id,
         d.visible_number AS current_duck_number, d.revision AS current_duck_revision,
         roh.id AS round_one_heat_id, roh.heat_number AS round_one_heat_number,
         roh.status AS round_one_heat_status, roh.revision AS round_one_heat_revision,
         rohe.slot_number AS round_one_slot_number,
         fh.id AS final_heat_id, fh.heat_number AS final_heat_number,
         fh.status AS final_heat_status, fh.revision AS final_heat_revision,
         fhe.slot_number AS final_slot_number,
         rohr.place AS round_one_place, fhr.place AS final_place
    FROM events e
    JOIN registrations r ON r.event_id = e.id AND r.status = 'ACTIVE'
    JOIN race_entries re ON re.registration_id = r.id
    JOIN duck_assignments da ON da.race_entry_id = re.id AND da.valid_to IS NULL
    JOIN ducks d ON d.id = da.duck_id
    LEFT JOIN heat_entries rohe ON rohe.race_entry_id = re.id AND rohe.round = 'ROUND_ONE'
    LEFT JOIN heats roh ON roh.id = rohe.heat_id
    LEFT JOIN heat_results rohr ON rohr.heat_id = roh.id AND rohr.race_entry_id = re.id
    LEFT JOIN heat_entries fhe ON fhe.race_entry_id = re.id AND fhe.round = 'FINAL'
    LEFT JOIN heats fh ON fh.id = fhe.heat_id
    LEFT JOIN heat_results fhr ON fhr.heat_id = fh.id AND fhr.race_entry_id = re.id`;

const replacementHeat = (row: ReplacementCandidateRow, round: "ROUND_ONE" | "FINAL") => {
  const final = round === "FINAL";
  const id = final ? row.final_heat_id : row.round_one_heat_id;
  const number = final ? row.final_heat_number : row.round_one_heat_number;
  const status = final ? row.final_heat_status : row.round_one_heat_status;
  const revision = final ? row.final_heat_revision : row.round_one_heat_revision;
  const slotNumber = final ? row.final_slot_number : row.round_one_slot_number;
  const place = final ? row.final_place : row.round_one_place;
  return id === null ? null : { id, round, number, status, revision, slotNumber, place };
};

const replacementCandidateJson = (row: ReplacementCandidateRow) => ({
  registrationId: row.registration_id,
  registrationRevision: row.registration_revision,
  raceEntryId: row.race_entry_id,
  raceEntryRevision: row.race_entry_revision,
  participant: { firstName: row.first_name, lastName: row.last_name },
  currentAssignment: {
    id: row.assignment_id,
    duckId: row.current_duck_id,
    duckNumber: row.current_duck_number,
    duckRevision: row.current_duck_revision,
  },
  event: { id: row.event_id, status: row.event_status, revision: row.event_revision },
  currentHeat: replacementHeat(row, row.event_status),
  roundOneHeat: replacementHeat(row, "ROUND_ONE"),
  finalHeat: replacementHeat(row, "FINAL"),
});

const searchReplacementCandidates = async (url: URL, env: Env): Promise<Response> => {
  const eventId = url.searchParams.get("eventId")?.trim() ?? "";
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (!validEntityId(eventId) || query.length > 80) {
    return json({ error: "An event and a search of at most 80 characters are required." }, 400);
  }
  const like = `%${escapeLike(query)}%`;
  const rows = await env.DB.prepare(
    `${replacementCandidateSelect}
      WHERE e.id = ? AND e.status IN ('ROUND_ONE', 'FINAL')
        AND ((e.status = 'ROUND_ONE' AND roh.id IS NOT NULL)
          OR (e.status = 'FINAL' AND fh.id IS NOT NULL))
        AND (
          ? = ''
          OR r.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR r.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR (r.first_name || ' ' || r.last_name) LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR CAST(d.visible_number AS TEXT) = ?
        )
      ORDER BY r.last_name COLLATE NOCASE, r.first_name COLLATE NOCASE, d.visible_number
      LIMIT ?`,
  ).bind(eventId, query, like, like, like, query, REGISTRATION_SEARCH_LIMIT + 1)
    .all<ReplacementCandidateRow>();
  const truncated = rows.results.length > REGISTRATION_SEARCH_LIMIT;
  return json({
    candidates: rows.results.slice(0, REGISTRATION_SEARCH_LIMIT).map(replacementCandidateJson),
    truncated,
    limit: REGISTRATION_SEARCH_LIMIT,
  });
};

interface ReplacementDuckRow {
  duck_id: string;
  visible_number: number;
  inventory_status: string;
  physical_condition: string;
  revision: number;
  event_duck_id: string | null;
  event_duck_event_id: string | null;
  assignment_id: string | null;
}

interface ReplacementCommandRow {
  event_id: string;
  command_type: string;
  result_id: string | null;
  request_fingerprint: string | null;
}

interface ReplacementResultRow {
  assignment_id: string;
  first_name: string;
  last_name: string;
  race_entry_id: string;
  new_duck_number: number;
  old_duck_number: number;
  event_status: "ROUND_ONE" | "FINAL";
  round_one_heat_number: number | null;
  round_one_slot_number: number | null;
  final_heat_number: number | null;
  final_slot_number: number | null;
}

const replacementResult = async (
  env: Env,
  commandId: string,
  fingerprint: string,
  replayed: boolean,
): Promise<Response | null> => {
  const row = await env.DB.prepare(
    `SELECT da.id AS assignment_id, r.first_name, r.last_name, da.race_entry_id,
            new_d.visible_number AS new_duck_number,
            old_d.visible_number AS old_duck_number, e.status AS event_status,
            roh.heat_number AS round_one_heat_number, rohe.slot_number AS round_one_slot_number,
            fh.heat_number AS final_heat_number, fhe.slot_number AS final_slot_number
       FROM race_commands c
       JOIN events e ON e.id = c.event_id
       JOIN duck_assignments da ON da.id = c.result_id
       JOIN ducks new_d ON new_d.id = da.duck_id
       JOIN race_entries re ON re.id = da.race_entry_id
       JOIN registrations r ON r.id = re.registration_id
       JOIN duck_inventory_events old_event
         ON old_event.source_command_id = c.id AND old_event.action = 'DUCK_UNASSIGNED'
       JOIN ducks old_d ON old_d.id = old_event.duck_id
       LEFT JOIN heat_entries rohe ON rohe.race_entry_id = re.id AND rohe.round = 'ROUND_ONE'
       LEFT JOIN heats roh ON roh.id = rohe.heat_id
       LEFT JOIN heat_entries fhe ON fhe.race_entry_id = re.id AND fhe.round = 'FINAL'
       LEFT JOIN heats fh ON fh.id = fhe.heat_id
      WHERE c.id = ? AND c.command_type = 'EMERGENCY_REPLACE_DUCK'
        AND c.request_fingerprint = ?
      LIMIT 1`,
  ).bind(commandId, fingerprint).first<ReplacementResultRow>();
  if (row === null) return null;
  return json({
    assignmentId: row.assignment_id,
    replayed,
    participant: { firstName: row.first_name, lastName: row.last_name, raceEntryId: row.race_entry_id },
    oldDuck: { visibleNumber: row.old_duck_number },
    newDuck: { visibleNumber: row.new_duck_number },
    roundOneHeat: row.round_one_heat_number === null ? null : {
      round: "ROUND_ONE", number: row.round_one_heat_number, slotNumber: row.round_one_slot_number,
    },
    finalHeat: row.final_heat_number === null ? null : {
      round: "FINAL", number: row.final_heat_number, slotNumber: row.final_slot_number,
    },
    eventStatus: row.event_status,
  }, replayed ? 200 : 201);
};

const replaceDuck = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  token: string,
): Promise<Response> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return json({ error: "Duck not found." }, 404);
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  const eventId = payload.eventId;
  const raceEntryId = payload.raceEntryId;
  const expectedAssignmentId = payload.expectedAssignmentId;
  const expectedReplacementReservationId = payload.expectedReplacementReservationId;
  const expectedEventStatus = payload.expectedEventStatus;
  const expectedEventRevision = payload.expectedEventRevision;
  const expectedHeatId = payload.expectedHeatId;
  const expectedHeatRevision = payload.expectedHeatRevision;
  const expectedRegistrationRevision = payload.expectedRegistrationRevision;
  const expectedRaceEntryRevision = payload.expectedRaceEntryRevision;
  const expectedCurrentDuckRevision = payload.expectedCurrentDuckRevision;
  const expectedReplacementDuckRevision = payload.expectedReplacementDuckRevision;
  const incidentType = payload.incidentType;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEntityId(eventId) || !validEntityId(raceEntryId)
    || !validEntityId(expectedAssignmentId) || !validEntityId(expectedHeatId)
    || (expectedReplacementReservationId !== null && !validEntityId(expectedReplacementReservationId))
    || !validRevision(expectedEventRevision)
    || !validRevision(expectedHeatRevision)
    || !validRevision(expectedRegistrationRevision)
    || !validRevision(expectedRaceEntryRevision)
    || !validRevision(expectedCurrentDuckRevision)
    || !validRevision(expectedReplacementDuckRevision)
    || (expectedEventStatus !== "ROUND_ONE" && expectedEventStatus !== "FINAL")
    || (incidentType !== "LOST" && incidentType !== "DAMAGED")
  ) {
    return json({
      error: "Command, event, current pairing, revisions, heat context, and lost-or-damaged reason are required.",
    }, 400);
  }

  const requestMaterial = {
    eventId,
    raceEntryId,
    expectedAssignmentId,
    expectedReplacementReservationId,
    expectedEventStatus,
    expectedEventRevision,
    expectedHeatId,
    expectedHeatRevision,
    expectedRegistrationRevision,
    expectedRaceEntryRevision,
    expectedCurrentDuckRevision,
    expectedReplacementDuckRevision,
    incidentType,
    replacementTagFingerprint: await hashValue(token),
  };
  const fingerprint = await hashValue(JSON.stringify(requestMaterial));
  const existing = await env.DB.prepare(
    `SELECT event_id, command_type, result_id, request_fingerprint
       FROM race_commands WHERE id = ? LIMIT 1`,
  ).bind(commandId).first<ReplacementCommandRow>();
  if (existing !== null) {
    if (
      existing.event_id !== eventId
      || existing.command_type !== "EMERGENCY_REPLACE_DUCK"
      || existing.request_fingerprint !== fingerprint
      || existing.result_id === null
    ) return json({ error: "This command identifier was already used for another operation." }, 409);
    return await replacementResult(env, commandId, fingerprint, true)
      ?? json({ error: "The saved replacement result is no longer available." }, 409);
  }

  const replacement = await env.DB.prepare(
    `SELECT d.id AS duck_id, d.visible_number, d.inventory_status,
            d.physical_condition, d.revision,
            ed.id AS event_duck_id, ed.event_id AS event_duck_event_id,
            da.id AS assignment_id
       FROM duck_tags dt
       JOIN ducks d ON d.id = dt.duck_id
       LEFT JOIN event_ducks ed ON ed.duck_id = d.id AND ed.released_at IS NULL
       LEFT JOIN duck_assignments da ON da.duck_id = d.id AND da.valid_to IS NULL
      WHERE dt.token = ? AND dt.status = 'ACTIVE'
      LIMIT 1`,
  ).bind(token).first<ReplacementDuckRow>();
  if (replacement === null) return json({ error: "This tag is not an active race duck." }, 404);
  if (replacement.revision !== expectedReplacementDuckRevision
    || replacement.event_duck_id !== expectedReplacementReservationId) {
    return json({ error: "The replacement duck changed. Refresh and try again." }, 409);
  }
  if (replacement.assignment_id !== null) return json({ error: "The replacement duck is already paired." }, 409);
  if (
    replacement.physical_condition !== "GOOD"
    || !["AVAILABLE", "RESERVED_FOR_EVENT"].includes(replacement.inventory_status)
  ) return json({ error: "The replacement duck is not physically eligible for pairing." }, 409);
  if (replacement.event_duck_event_id !== null && replacement.event_duck_event_id !== eventId) {
    return json({ error: "The replacement duck is reserved for another event." }, 409);
  }

  const candidate = await env.DB.prepare(
    `${replacementCandidateSelect}
      WHERE e.id = ? AND re.id = ? AND e.status IN ('ROUND_ONE', 'FINAL')
        AND ((e.status = 'ROUND_ONE' AND roh.id IS NOT NULL)
          OR (e.status = 'FINAL' AND fh.id IS NOT NULL))
      LIMIT 1`,
  ).bind(eventId, raceEntryId).first<ReplacementCandidateRow>();
  if (candidate === null) return json({ error: "That participant is not eligible for an emergency replacement." }, 404);
  const currentHeat = replacementHeat(candidate, candidate.event_status);
  if (
    currentHeat === null
    || candidate.assignment_id !== expectedAssignmentId
    || candidate.event_status !== expectedEventStatus
    || candidate.event_revision !== expectedEventRevision
    || candidate.registration_revision !== expectedRegistrationRevision
    || candidate.race_entry_revision !== expectedRaceEntryRevision
    || candidate.current_duck_revision !== expectedCurrentDuckRevision
    || currentHeat.id !== expectedHeatId
    || currentHeat.revision !== expectedHeatRevision
  ) return json({ error: "The participant's pairing or race context changed. Refresh and try again." }, 409);
  if (candidate.current_duck_id === replacement.duck_id) {
    return json({ error: "The replacement must be a different unpaired duck." }, 409);
  }

  const now = new Date().toISOString();
  const assignmentId = crypto.randomUUID();
  const eventDuckId = expectedReplacementReservationId ?? crypto.randomUUID();
  const oldStatus = incidentType === "LOST" ? "MISSING" : "DAMAGED";
  const reason = incidentType === "LOST"
    ? "Emergency replacement: old duck lost"
    : "Emergency replacement: old duck damaged";
  const commandExistsSql = `EXISTS (
    SELECT 1 FROM race_commands c
     WHERE c.id = ? AND c.event_id = ?
       AND c.command_type = 'EMERGENCY_REPLACE_DUCK' AND c.request_fingerprint = ?
  )`;
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at,
       actor_staff_profile_id, reason, request_fingerprint)
     SELECT ?, e.id, 'EMERGENCY_REPLACE_DUCK', ?, ?, ?, ?, ?, ?
       FROM events e
       JOIN race_entries re ON re.id = ? AND re.event_id = e.id AND re.revision = ?
       JOIN registrations r ON r.id = re.registration_id AND r.status = 'ACTIVE' AND r.revision = ?
       JOIN duck_assignments old_da
         ON old_da.race_entry_id = re.id AND old_da.valid_to IS NULL AND old_da.id = ?
       JOIN ducks old_d ON old_d.id = old_da.duck_id AND old_d.revision = ?
       JOIN ducks new_d ON new_d.id = ? AND new_d.revision = ?
       JOIN duck_tags dt ON dt.duck_id = new_d.id AND dt.token = ? AND dt.status = 'ACTIVE'
       JOIN heat_entries he ON he.race_entry_id = re.id AND he.heat_id = ?
       JOIN heats h ON h.id = he.heat_id AND h.event_id = e.id AND h.revision = ?
      WHERE e.id = ? AND e.status = ? AND e.status IN ('ROUND_ONE', 'FINAL') AND e.revision = ?
        AND h.round = e.status
        AND old_d.id <> new_d.id
        AND new_d.physical_condition = 'GOOD'
        AND new_d.inventory_status IN ('AVAILABLE', 'RESERVED_FOR_EVENT')
        AND NOT EXISTS (SELECT 1 FROM duck_assignments da WHERE da.duck_id = new_d.id AND da.valid_to IS NULL)
        AND COALESCE((SELECT ed.id FROM event_ducks ed
                       WHERE ed.duck_id = new_d.id AND ed.released_at IS NULL LIMIT 1), '')
            = COALESCE(?, '')
        AND NOT EXISTS (SELECT 1 FROM event_ducks ed
                         WHERE ed.duck_id = new_d.id AND ed.released_at IS NULL AND ed.event_id <> e.id)`,
  ).bind(
    commandId, assignmentId, now, now, actor.id, reason, fingerprint,
    raceEntryId, expectedRaceEntryRevision,
    expectedRegistrationRevision, expectedAssignmentId,
    expectedCurrentDuckRevision, replacement.duck_id,
    expectedReplacementDuckRevision, token, expectedHeatId,
    expectedHeatRevision, eventId, expectedEventStatus,
    expectedEventRevision, expectedReplacementReservationId,
  )];
  if (expectedReplacementReservationId === null) {
    statements.push(env.DB.prepare(
      `INSERT INTO event_ducks
        (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
       SELECT ?, ?, ?, ?, ? WHERE ${commandExistsSql}`,
    ).bind(eventDuckId, eventId, replacement.duck_id, now, actor.id, commandId, eventId, fingerprint));
  }
  statements.push(
    env.DB.prepare(
      `UPDATE duck_assignments
          SET valid_to = ?, end_reason = 'EMERGENCY_REPLACED', ended_by_staff_profile_id = ?
        WHERE id = ? AND event_id = ? AND valid_to IS NULL AND ${commandExistsSql}`,
    ).bind(now, actor.id, expectedAssignmentId, eventId, commandId, eventId, fingerprint),
    env.DB.prepare(
      `UPDATE ducks
          SET inventory_status = ?, inventory_status_changed_at = ?,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND ${commandExistsSql}`,
    ).bind(oldStatus, now, now, candidate.current_duck_id, expectedCurrentDuckRevision,
      commandId, eventId, fingerprint),
    env.DB.prepare(
      `INSERT INTO duck_assignments
        (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
         assigned_by_staff_profile_id, source_command_id)
       SELECT ?, ?, ?, ed.id, ?, ?, ?, ?
         FROM event_ducks ed
        WHERE ed.id = ? AND ed.event_id = ? AND ed.duck_id = ? AND ed.released_at IS NULL
          AND ${commandExistsSql}`,
    ).bind(assignmentId, eventId, raceEntryId, replacement.duck_id, now, actor.id, commandId,
      eventDuckId, eventId, replacement.duck_id, commandId, eventId, fingerprint),
    env.DB.prepare(
      `UPDATE ducks
          SET inventory_status = 'IN_USE', inventory_status_changed_at = ?,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ? AND ${commandExistsSql}`,
    ).bind(now, now, replacement.duck_id, expectedReplacementDuckRevision,
      commandId, eventId, fingerprint),
    env.DB.prepare(
      `UPDATE registrations SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND status = 'ACTIVE' AND ${commandExistsSql}`,
    ).bind(now, candidate.registration_id, expectedRegistrationRevision,
      commandId, eventId, fingerprint),
    env.DB.prepare(
      `UPDATE race_entries SET revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND ${commandExistsSql}`,
    ).bind(now, raceEntryId, expectedRaceEntryRevision, commandId, eventId, fingerprint),
    env.DB.prepare(
      `UPDATE final_podium_selections SET duck_assignment_id = ?
        WHERE event_id = ? AND race_entry_id = ? AND duck_assignment_id = ?
          AND ${commandExistsSql}`,
    ).bind(assignmentId, eventId, raceEntryId, expectedAssignmentId, commandId, eventId, fingerprint),
    env.DB.prepare(
      `INSERT INTO duck_inventory_events
        (id, event_id, duck_id, action, actor_staff_profile_id,
         source_command_id, occurred_at, details_json)
       SELECT ?, ?, ?, 'DUCK_UNASSIGNED', ?, ?, ?, ? WHERE ${commandExistsSql}`,
    ).bind(crypto.randomUUID(), eventId, candidate.current_duck_id, actor.id, commandId, now,
      JSON.stringify({ assignment_id: expectedAssignmentId, replacement_duck_id: replacement.duck_id, incident_type: incidentType }),
      commandId, eventId, fingerprint),
    env.DB.prepare(
      `INSERT INTO duck_inventory_events
        (id, event_id, duck_id, action, actor_staff_profile_id,
         source_command_id, occurred_at, details_json)
       SELECT ?, ?, ?, 'DUCK_REASSIGNED', ?, ?, ?, ? WHERE ${commandExistsSql}`,
    ).bind(crypto.randomUUID(), eventId, replacement.duck_id, actor.id, commandId, now,
      JSON.stringify({ assignment_id: assignmentId, replaced_assignment_id: expectedAssignmentId, replaced_duck_id: candidate.current_duck_id }),
      commandId, eventId, fingerprint),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_id, command_id, action, subject_type, subject_id,
         actor_type, occurred_at, details_json)
       SELECT ?, ?, ?, 'EMERGENCY_DUCK_REPLACED', 'DUCK_ASSIGNMENT',
              CASE WHEN
                EXISTS (SELECT 1 FROM duck_assignments da
                         WHERE da.id = ? AND da.race_entry_id = ? AND da.duck_id = ? AND da.valid_to IS NULL)
                AND EXISTS (SELECT 1 FROM duck_assignments da
                            WHERE da.id = ? AND da.valid_to IS NOT NULL AND da.end_reason = 'EMERGENCY_REPLACED')
                AND EXISTS (SELECT 1 FROM ducks d WHERE d.id = ? AND d.inventory_status = ? AND d.revision = ?)
                AND EXISTS (SELECT 1 FROM ducks d WHERE d.id = ? AND d.inventory_status = 'IN_USE' AND d.revision = ?)
                AND EXISTS (SELECT 1 FROM registrations r WHERE r.id = ? AND r.revision = ?)
                AND EXISTS (SELECT 1 FROM race_entries re WHERE re.id = ? AND re.revision = ?)
              THEN ? END,
              'STAFF', ?, ?
        WHERE ${commandExistsSql}`,
    ).bind(
      crypto.randomUUID(), eventId, commandId,
      assignmentId, raceEntryId, replacement.duck_id,
      expectedAssignmentId,
      candidate.current_duck_id, oldStatus, expectedCurrentDuckRevision + 1,
      replacement.duck_id, expectedReplacementDuckRevision + 1,
      candidate.registration_id, expectedRegistrationRevision + 1,
      raceEntryId, expectedRaceEntryRevision + 1,
      assignmentId, now, JSON.stringify({
      staff_profile_id: actor.id,
      race_entry_id: raceEntryId,
      replaced_assignment_id: expectedAssignmentId,
      replaced_duck_id: candidate.current_duck_id,
      replacement_duck_id: replacement.duck_id,
      incident_type: incidentType,
    }), commandId, eventId, fingerprint),
  );

  let replayed = false;
  try {
    await env.DB.batch(statements);
  } catch {
    replayed = true;
  }
  const committed = await env.DB.prepare(
    `SELECT event_id, command_type, result_id, request_fingerprint
       FROM race_commands WHERE id = ? LIMIT 1`,
  ).bind(commandId).first<ReplacementCommandRow>();
  if (
    committed === null
    || committed.event_id !== eventId
    || committed.command_type !== "EMERGENCY_REPLACE_DUCK"
    || committed.request_fingerprint !== fingerprint
    || (committed.result_id !== assignmentId && !replayed)
  ) return json({ error: "Replacement conflicted with another update. Refresh and try again." }, 409);
  const result = await replacementResult(env, commandId, fingerprint, replayed);
  return result ?? json({ error: "Replacement conflicted with another update. Refresh and try again." }, 409);
};

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

/**
 * Rows the scan-first pairing list returns before it asks staff to narrow.
 * The list is a working queue, not a report, so it stays bounded rather than
 * streaming every registration of a large event into a phone.
 */
export const REGISTRATION_SEARCH_LIMIT = 100;

const searchRegistrations = async (url: URL, env: Env): Promise<Response> => {
  const eventId = url.searchParams.get("eventId")?.trim() ?? "";
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (eventId.length === 0 || query.length > 80) {
    return json({ error: "An event and a search of at most 80 characters are required." }, 400);
  }

  const exactCode = normalizeLookupCode(query);
  const like = `%${escapeLike(query)}%`;
  // This endpoint feeds one screen: a staff member holding a duck that needs a
  // participant. An empty query is therefore a listing of everyone still
  // waiting for a duck, and typing narrows that same list; `? = ''` turns the
  // match group off for the listing without a second statement. A participant
  // who already holds a duck is excluded here, in SQL, so no browser filter and
  // no future caller can surface one.
  const results = await env.DB.prepare(
    `SELECT r.id AS registration_id, re.id AS race_entry_id,
            r.first_name, r.last_name, r.email, r.phone,
            r.lookup_code, r.status,
            d.visible_number
       FROM registrations r
       JOIN race_entries re ON re.registration_id = r.id
       LEFT JOIN duck_assignments da
         ON da.race_entry_id = re.id AND da.valid_to IS NULL
       LEFT JOIN ducks d ON d.id = da.duck_id
      WHERE r.event_id = ?
        AND da.id IS NULL
        AND (
           ? = ''
           OR r.lookup_code = ? COLLATE NOCASE
           OR r.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
           OR r.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
           OR (r.first_name || ' ' || r.last_name) LIKE ? ESCAPE '\\' COLLATE NOCASE
           OR COALESCE(r.email, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
           OR COALESCE(r.phone, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
         )
      ORDER BY CASE WHEN r.lookup_code = ? COLLATE NOCASE THEN 0 ELSE 1 END,
               r.last_name COLLATE NOCASE,
               r.first_name COLLATE NOCASE,
               r.submitted_at
      LIMIT ?`,
  ).bind(
    eventId,
    query,
    exactCode,
    like,
    like,
    like,
    like,
    like,
    exactCode,
    REGISTRATION_SEARCH_LIMIT + 1,
  ).all<{
    registration_id: string;
    race_entry_id: string;
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
    lookup_code: string;
    status: string;
    visible_number: number | null;
  }>();

  // Belt and braces on top of `da.id IS NULL`: a row that still reports a duck
  // number never reaches the response, whatever the join returned.
  const unpaired = results.results.filter((row) => row.visible_number === null);
  const truncated = unpaired.length > REGISTRATION_SEARCH_LIMIT;
  const registrations = unpaired.slice(0, REGISTRATION_SEARCH_LIMIT).map((row) => ({
    registrationId: row.registration_id,
    raceEntryId: row.race_entry_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    lookupCode: row.lookup_code,
    status: row.status,
    assignedDuckNumber: row.visible_number,
  }));

  // A query that is exactly one participant's lookup code identifies a single
  // person with no ambiguity, so the staff console pairs it directly instead of
  // rendering a one-item list to click through. Anything else, including a
  // partial code, stays a normal search. This only reports the match; the
  // pairing command still performs every authorization and state check. Because
  // the list is unpaired-only, an already-paired code reports nothing here and
  // the console says so instead of firing a command that would be rejected.
  const exactMatch = isLookupCode(exactCode)
    ? registrations.find((registration) => registration.lookupCode.toUpperCase() === exactCode) ?? null
    : null;

  return json({ registrations, exactMatch, truncated, limit: REGISTRATION_SEARCH_LIMIT });
};

interface PairingContext {
  event_id: string;
  round_one_heat_capacity: number;
  final_heat_capacity: number;
  registration_id: string;
  registration_status: string;
  registration_revision: number;
  race_entry_id: string;
  race_entry_revision: number;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  lookup_code: string;
}

const pairingResponse = (
  assignmentId: string,
  duckNumber: number,
  context: PairingContext,
  heat: { round: string; number: number } | null,
  replayed: boolean,
): Response => json({
  assignmentId,
  replayed,
  duck: { visibleNumber: duckNumber },
  participant: {
    firstName: context.first_name,
    lastName: context.last_name,
    email: context.email,
    phone: context.phone,
    lookupCode: context.lookup_code,
  },
  heat: heat === null ? null : { round: heat.round, number: heat.number },
  heatAssignmentPending: heat === null,
}, replayed ? 200 : 201);

const pairDuck = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  token: string,
): Promise<Response> => {
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  const eventId = payload.eventId;
  const lookupCodeValue = payload.lookupCode;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || typeof eventId !== "string" || eventId.length === 0 || eventId.length > 128
    || typeof lookupCodeValue !== "string"
  ) {
    return json({ error: "Command, event, and participant lookup code are required." }, 400);
  }
  const lookupCode = normalizeLookupCode(lookupCodeValue);
  if (!isLookupCode(lookupCode)) {
    return json({ error: "Enter a valid participant lookup code." }, 400);
  }

  const replay = await env.DB.prepare(
    `SELECT da.id AS assignment_id, d.visible_number,
            e.id AS event_id, e.round_one_heat_capacity,
            e.final_heat_capacity,
            r.id AS registration_id, r.status AS registration_status,
            r.revision AS registration_revision,
            re.id AS race_entry_id, re.revision AS race_entry_revision,
            r.first_name, r.last_name, r.email, r.phone, r.lookup_code,
            h.round AS heat_round, h.heat_number
       FROM race_commands c
        JOIN duck_assignments da ON da.id = c.result_id
        JOIN ducks d ON d.id = da.duck_id
        JOIN duck_tags dt ON dt.duck_id = d.id AND dt.token = ?
        JOIN events e ON e.id = da.event_id
       JOIN race_entries re ON re.id = da.race_entry_id
       JOIN registrations r ON r.id = re.registration_id
        LEFT JOIN heat_entries he ON he.id = (
          SELECT he2.id
            FROM heat_entries he2
            JOIN heats h2 ON h2.id = he2.heat_id
           WHERE he2.race_entry_id = re.id
           ORDER BY CASE h2.round WHEN 'FINAL' THEN 0 ELSE 1 END, h2.heat_number
           LIMIT 1
        )
        LEFT JOIN heats h ON h.id = he.heat_id
      WHERE c.id = ? AND c.command_type = 'ASSIGN_DUCK'
        AND c.event_id = ?
        AND r.lookup_code = ? COLLATE NOCASE
      LIMIT 1`,
  ).bind(token, commandId, eventId, lookupCode).first<PairingContext & {
    assignment_id: string;
    visible_number: number;
    heat_round: string | null;
    heat_number: number | null;
  }>();
  if (replay !== null) {
    return pairingResponse(
      replay.assignment_id,
      replay.visible_number,
      replay,
      replay.heat_number === null || replay.heat_round === null
        ? null
        : { round: replay.heat_round, number: replay.heat_number },
      true,
    );
  }

  const duck = await env.DB.prepare(
    `SELECT d.id, d.visible_number, d.inventory_status, d.revision,
            da.id AS active_assignment_id
       FROM duck_tags dt
       JOIN ducks d ON d.id = dt.duck_id
       LEFT JOIN duck_assignments da
         ON da.duck_id = d.id AND da.valid_to IS NULL
      WHERE dt.token = ? AND dt.status = 'ACTIVE'
      LIMIT 1`,
  ).bind(token).first<{
    id: string;
    visible_number: number;
    inventory_status: string;
    revision: number;
    active_assignment_id: string | null;
  }>();
  if (duck === null) return json({ error: "This tag is not an active race duck." }, 404);
  if (duck.active_assignment_id !== null) return json({ error: "This duck is already paired." }, 409);

  // Pairing is allowed once racing has started, because a duck can be deleted
  // mid-race and its participant then has to be given another one. It is the
  // same command either way: the participant is SUBMITTED with no open
  // assignment, which is exactly the state deleting their duck left them in.
  const context = await env.DB.prepare(
    `SELECT e.id AS event_id, e.round_one_heat_capacity,
            e.final_heat_capacity,
            e.status AS event_status,
            r.id AS registration_id, r.status AS registration_status,
            r.revision AS registration_revision,
            re.id AS race_entry_id, re.revision AS race_entry_revision,
            r.first_name, r.last_name, r.email, r.phone, r.lookup_code,
            (
              SELECT h.round || ':' || h.heat_number
                FROM heat_entries he
                JOIN heats h ON h.id = he.heat_id
               WHERE he.race_entry_id = re.id
               ORDER BY CASE h.round WHEN 'FINAL' THEN 0 ELSE 1 END, h.heat_number
               LIMIT 1
             ) AS existing_heat,
            (
              SELECT h.id
                FROM heat_entries he
                JOIN heats h ON h.id = he.heat_id
               WHERE he.race_entry_id = re.id
               ORDER BY CASE h.round WHEN 'FINAL' THEN 0 ELSE 1 END, h.heat_number
               LIMIT 1
             ) AS existing_heat_id
       FROM registrations r
       JOIN race_entries re ON re.registration_id = r.id
       JOIN events e ON e.id = r.event_id
       LEFT JOIN duck_assignments da
         ON da.race_entry_id = re.id AND da.valid_to IS NULL
      WHERE r.event_id = ?
        AND r.lookup_code = ? COLLATE NOCASE
        AND r.status = 'SUBMITTED'
        AND da.id IS NULL
        AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')
      LIMIT 1`,
  ).bind(eventId, lookupCode).first<PairingContext & {
    event_status: string;
    existing_heat: string | null;
    existing_heat_id: string | null;
  }>();
  if (context === null) {
    return json({ error: "No unpaired participant matches that code in this event." }, 404);
  }
  // During FINAL, pairing is a repair and nothing else. During ROUND_ONE a
  // newly admitted walk-up may still be placed, but only into a heat that has
  // never started; the guarded insert and migration trigger enforce that again
  // inside the transaction.
  if (context.event_status === "FINAL" && context.existing_heat === null) {
    return json({
      error: "Racing has started, so a new racer cannot be added. This code has no place in any heat.",
    }, 409);
  }

  const reservation = await env.DB.prepare(
    `SELECT id, event_id
       FROM event_ducks
      WHERE duck_id = ? AND released_at IS NULL
      LIMIT 1`,
  ).bind(duck.id).first<{ id: string; event_id: string }>();
  if (reservation !== null && reservation.event_id !== eventId) {
    return json({ error: "This duck is reserved for another event." }, 409);
  }
  const eligibleInventoryStatuses = reservation === null
    ? ["AVAILABLE"]
    : ["AVAILABLE", "RESERVED_FOR_EVENT"];
  if (!eligibleInventoryStatuses.includes(duck.inventory_status)) {
    return json({ error: "This duck is not available for pairing." }, 409);
  }

  const now = new Date().toISOString();
  const assignmentId = crypto.randomUUID();
  const eventDuckId = reservation?.id ?? crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at)
       VALUES (?, ?, 'ASSIGN_DUCK', ?, ?, ?)`,
    ).bind(commandId, eventId, assignmentId, now, now),
  ];
  if (reservation === null) {
    statements.push(env.DB.prepare(
      `INSERT INTO event_ducks
        (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(eventDuckId, eventId, duck.id, now, actor.id));
  }
  statements.push(env.DB.prepare(
    `INSERT INTO duck_assignments
      (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
       assigned_by_staff_profile_id, source_command_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(assignmentId, eventId, context.race_entry_id, eventDuckId, duck.id, now, actor.id, commandId));
  statements.push(env.DB.prepare(
    `UPDATE registrations
        SET status = 'ACTIVE', status_changed_at = ?, updated_at = ?, revision = revision + 1
      WHERE id = ?`,
  ).bind(now, now, context.registration_id));
  statements.push(env.DB.prepare(
    `UPDATE ducks
        SET inventory_status = 'IN_USE', inventory_status_changed_at = ?,
            updated_at = ?, revision = revision + 1
      WHERE id = ?`,
  ).bind(now, now, duck.id));

  // Assigning a heat while pairing is the only heat model. The retired
  // post-close balanced planner is gone, so an event row that still carries the
  // retired mode value is paired into heats exactly like every other event
  // rather than being left with no route to a heat at all.
  //
  // A participant who already holds a heat place keeps it. That is what makes
  // replacing a deleted duck mid-race possible at all: the heat roster names the
  // race entry, and the duck is resolved through whichever assignment is
  // currently open, so a new assignment is the whole repair.
  let heat: { round: string; number: number } | null = null;
  let assignedHeatId: string | null = null;
  if (typeof context.existing_heat === "string") {
    const [round, number] = context.existing_heat.split(":");
    heat = { round, number: Number(number) };
    assignedHeatId = context.existing_heat_id;
  } else {
    const roundOneWalkUp = context.event_status === "ROUND_ONE";
    const existingHeat = await env.DB.prepare(
      `SELECT h.id, h.heat_number, COUNT(he.id) AS entry_count
         FROM heats h
         LEFT JOIN heat_entries he ON he.heat_id = h.id
        WHERE h.event_id = ? AND h.round = 'ROUND_ONE'
          AND ${roundOneWalkUp
            ? heatHasNeverStartedSql("h")
            : "h.status IN ('PLANNED', 'LOADING', 'READY')"}
        GROUP BY h.id
       HAVING COUNT(he.id) < ?
        ORDER BY h.heat_number
        LIMIT 1`,
    ).bind(eventId, context.round_one_heat_capacity).first<{
      id: string;
      heat_number: number;
      entry_count: number;
    }>();
    let heatId: string;
    if (existingHeat === null) {
      let roundOneStillOpen = false;
      if (roundOneWalkUp) {
        const unstarted = await env.DB.prepare(
          `SELECT 1 AS available FROM events e
            WHERE e.id = ? AND ${unstartedRoundOneHeatExistsSql("e.id")}
            LIMIT 1`,
        ).bind(eventId).first<{ available: number }>();
        if (unstarted === null) {
          return json({
            error: "Walk-up registration has closed because every Round One heat has started.",
          }, 409);
        }
        roundOneStillOpen = true;
      }
      const last = await env.DB.prepare(
        `SELECT COALESCE(MAX(heat_number), 0) AS last_number,
                COUNT(*) AS heat_count
           FROM heats
           WHERE event_id = ? AND round = 'ROUND_ONE'`,
      ).bind(eventId).first<{ last_number: number; heat_count: number }>();
      if ((last?.heat_count ?? 0) >= context.final_heat_capacity) {
        return json({ error: "Pairing would create more round-one heats than the final can hold." }, 409);
      }
      heatId = crypto.randomUUID();
      heat = { round: "ROUND_ONE", number: (last?.last_number ?? 0) + 1 };
      // Guarded creation: before the round this is the existing PLANNED next-
      // heat rule. During the walk-up window the same fill rule may create a
      // locked LOADING heat only while another never-started heat still proves
      // admission is open. If a concurrent final start wins, this insert
      // produces no row and the dependent heat-entry foreign key rolls the
      // whole pairing command back.
      if (roundOneStillOpen) {
        statements.push(env.DB.prepare(
          `INSERT INTO heats
            (id, event_id, round, heat_number, status, target_size,
             roster_locked_at, roster_locked_by_staff_profile_id, source_command_id)
           SELECT ?, e.id, 'ROUND_ONE', ?, 'LOADING', e.round_one_heat_capacity,
                  ?, ?, ?
             FROM events e
            WHERE e.id = ? AND e.status = 'ROUND_ONE'
              AND ${unstartedRoundOneHeatExistsSql("e.id")}
              AND (SELECT COUNT(*) FROM heats h
                    WHERE h.event_id = e.id AND h.round = 'ROUND_ONE') < e.final_heat_capacity`,
        ).bind(heatId, heat.number, now, actor.id, commandId, eventId));
      } else {
        statements.push(env.DB.prepare(
          `INSERT INTO heats
            (id, event_id, round, heat_number, status, target_size, source_command_id)
           SELECT ?, e.id, 'ROUND_ONE', ?, 'PLANNED', e.round_one_heat_capacity, ?
             FROM events e
            WHERE e.id = ?
              AND (SELECT COUNT(*) FROM heats h
                    WHERE h.event_id = e.id AND h.round = 'ROUND_ONE') < e.final_heat_capacity`,
        ).bind(heatId, heat.number, commandId, eventId));
      }
    } else {
      heatId = existingHeat.id;
      heat = { round: "ROUND_ONE", number: existingHeat.heat_number };
    }
    assignedHeatId = heatId;
    // Guarded slot: the slot number is recomputed inside the atomic batch and
    // becomes NULL when the heat is already full, so the NOT NULL constraint
    // aborts the transaction instead of overfilling a heat that a concurrent
    // pairing filled after this request's preflight read.
    statements.push(env.DB.prepare(
      `INSERT INTO heat_entries
        (id, event_id, heat_id, race_entry_id, round, slot_number,
         assignment_source, assigned_at, source_command_id)
       SELECT ?, e.id, ?, ?, 'ROUND_ONE',
              CASE WHEN (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = ?) < e.round_one_heat_capacity
                   THEN (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = ?) + 1
                   END,
              'PAIRING', ?, ?
         FROM events e
        WHERE e.id = ?`,
    ).bind(
      crypto.randomUUID(),
      heatId,
      context.race_entry_id,
      heatId,
      heatId,
      now,
      commandId,
      eventId,
    ));
    if (roundOneWalkUp) {
      // A start-line client that loaded this roster before the walk-up was
      // paired must lose its stale revision. This update commits in the same
      // transaction as the new slot, so a refreshed start always sees the
      // admitted racer and the old start request receives 409.
      statements.push(env.DB.prepare(
        `UPDATE heats
            SET revision = revision + 1, source_command_id = ?, updated_at = ?
          WHERE id = ? AND event_id = ? AND round = 'ROUND_ONE'
            AND ${heatHasNeverStartedSql("heats")}
            AND EXISTS (
              SELECT 1 FROM heat_entries he
               WHERE he.heat_id = heats.id AND he.race_entry_id = ?
                 AND he.source_command_id = ?
            )`,
      ).bind(commandId, now, heatId, eventId, context.race_entry_id, commandId));
    }
  }

  // The notification row is part of the same authoritative command as the
  // assignment and heat slot. Contact details never enter the queue payload;
  // the consumer rechecks the current address, consent, assignment, and heat.
  // Re-pairing into an existing slot is harmless because the schema permits one
  // HEAT_ASSIGNED message for this participant and heat.
  if (assignedHeatId !== null) {
    statements.push(heatNotificationStatement(
      env,
      eventId,
      assignedHeatId,
      "HEAT_ASSIGNED",
      `round-one-assignment:${assignedHeatId}`,
      commandId,
      now,
      context.race_entry_id,
    ));
  }

  statements.push(env.DB.prepare(
    `INSERT INTO audit_events
      (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
     VALUES (?, ?, ?, 'DUCK_ASSIGNED', 'DUCK_ASSIGNMENT', ?, 'STAFF', ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    eventId,
    commandId,
    assignmentId,
    now,
    JSON.stringify({
      staff_profile_id: actor.id,
      registration_id: context.registration_id,
      race_entry_id: context.race_entry_id,
      duck_id: duck.id,
      heat_number: heat?.number ?? null,
    }),
  ));

  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: "Pairing conflicted with another update. Refresh and try again." }, 409);
  }

  await publishPendingParticipantNotifications(env);

  return pairingResponse(
    assignmentId,
    duck.visible_number,
    context,
    heat,
    false,
  );
};


export const handleStaffApi = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  provisioner: StaffIdentityProvisioner = cognitoStaffProvisioner,
): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === "/api/v1/staff/profiles" && request.method === "GET") {
    return listStaffProfiles(env, actor);
  }
  if (url.pathname === "/api/v1/staff/profiles" && request.method === "POST") {
    return addStaffProfile(request, env, actor, provisioner);
  }

  if (url.pathname === "/api/v1/staff/registrations/search" && request.method === "GET") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return searchRegistrations(url, env);
  }

  if (url.pathname === "/api/v1/staff/registrations/replacement-search" && request.method === "GET") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return searchReplacementCandidates(url, env);
  }

  const assignmentMatch = url.pathname.match(/^\/api\/v1\/staff\/ducks\/([A-Za-z0-9_-]+)\/assignments$/);
  if (assignmentMatch !== null && request.method === "POST") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return pairDuck(request, env, actor, assignmentMatch[1]);
  }

  const replacementMatch = url.pathname.match(/^\/api\/v1\/staff\/ducks\/([A-Za-z0-9_-]+)\/replacement$/);
  if (replacementMatch !== null && request.method === "POST") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return replaceDuck(request, env, actor, replacementMatch[1]);
  }

  const duckMatch = url.pathname.match(/^\/api\/v1\/staff\/ducks\/([A-Za-z0-9_-]+)$/);
  if (duckMatch !== null && request.method === "GET") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "DUCK_MANAGER", "RESULT_TAKER", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return getStaffDuck(duckMatch[1], env, actor);
  }

  return json({ error: "Not found." }, 404);
};
