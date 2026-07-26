import type { StaffActor } from "./auth.ts";
import {
  canViewParticipantPii,
  hasAnyRole,
  normalizeOperationalRoles,
  requireAnyRole,
  type OperationalRole,
} from "./authorization.ts";
import { isCommandId } from "./registration.ts";
import {
  cognitoStaffProvisioner,
  type StaffIdentityProvisioner,
} from "./staff-access.ts";
import type { Env } from "./types.ts";

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
  event_name: string | null;
  event_status: string | null;
  assignment_id: string | null;
  assignment_valid_to: string | null;
  event_id: string | null;
  race_entry_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  lookup_code: string | null;
  registration_status: string | null;
  disposition: string | null;
}

const getStaffDuck = async (token: string, env: Env, actor: StaffActor): Promise<Response> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return json({ error: "Duck not found." }, 404);
  const duck = await env.DB.prepare(
    `SELECT d.id AS duck_id, d.visible_number, d.inventory_status,
            d.revision AS duck_revision, dt.status AS tag_status,
            e.name AS event_name, e.status AS event_status,
            da.id AS assignment_id, da.valid_to AS assignment_valid_to,
            ed.event_id, da.race_entry_id,
            r.first_name, r.last_name, r.email, r.phone, r.lookup_code,
            r.status AS registration_status, ded.disposition
       FROM duck_tags dt
       JOIN ducks d ON d.id = dt.duck_id
       LEFT JOIN event_ducks ed ON ed.id = (
         SELECT ed2.id
           FROM event_ducks ed2
          WHERE ed2.duck_id = d.id
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
       LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
      WHERE dt.token = ?
      ORDER BY CASE dt.status WHEN 'ACTIVE' THEN 0 ELSE 1 END
      LIMIT 1`,
  ).bind(token).first<StaffDuckRow>();
  if (duck === null) return json({ error: "Duck not found." }, 404);

  const includePii = canViewParticipantPii(actor);
  const returnOnly = hasAnyRole(actor, ["RETURN_STEWARD"])
    && !hasAnyRole(actor, ["REGISTRATION", "DUCK_MANAGER", "RACE_DIRECTOR"]);
  const assignment = duck.assignment_id === null ? null : returnOnly
    ? { active: duck.assignment_valid_to === null }
    : {
      id: duck.assignment_id,
      active: duck.assignment_valid_to === null,
      eventId: duck.event_id,
      raceEntryId: duck.race_entry_id,
      participant: includePii ? {
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
      recordDisposition: hasAnyRole(actor, ["RETURN_STEWARD", "RACE_DIRECTOR"]),
    },
    duck: {
      id: duck.duck_id,
      visibleNumber: duck.visible_number,
      inventoryStatus: duck.inventory_status,
      revision: duck.duck_revision,
      tagStatus: duck.tag_status,
    },
    pairingRequired: hasAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"])
      && duck.assignment_id === null
      && duck.disposition === null
      && duck.tag_status === "ACTIVE"
      && ["AVAILABLE", "RESERVED_FOR_EVENT"].includes(duck.inventory_status),
    event: duck.event_id === null ? null : {
      id: duck.event_id,
      name: duck.event_name,
      status: duck.event_status,
    },
    disposition: duck.disposition,
    assignment,
  });
};

const dispositionInventoryStatus = {
  RETURNED: "AVAILABLE",
  KEPT: "KEPT",
  MISSING: "MISSING",
  DAMAGED: "DAMAGED",
  QUARANTINED: "QUARANTINED",
  RETIRED: "RETIRED",
  UNACCOUNTED_FOR: "UNACCOUNTED_FOR",
} as const;

type DuckDisposition = keyof typeof dispositionInventoryStatus;

interface ExistingCommand {
  event_id: string;
  command_type: string;
  result_id: string | null;
}

const findCommand = (commandId: string, env: Env): Promise<ExistingCommand | null> =>
  env.DB.prepare(
    "SELECT event_id, command_type, result_id FROM race_commands WHERE id = ?",
  ).bind(commandId).first<ExistingCommand>();

interface DispositionResultRow {
  disposition_id: string;
  disposition: DuckDisposition;
  visible_number: number;
  inventory_status: string;
  event_status: string;
}

const dispositionResponse = (row: DispositionResultRow, replayed: boolean): Response => json({
  dispositionId: row.disposition_id,
  disposition: row.disposition,
  inventoryStatus: row.inventory_status,
  eventStatus: row.event_status,
  duck: { visibleNumber: row.visible_number },
  replayed,
}, replayed ? 200 : 201);

const recordDuckDisposition = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  selector: { token: string } | { visibleNumber: number; eventId: string },
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = "eventId" in selector ? selector.eventId : payload?.eventId;
  const disposition = payload?.disposition;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || typeof eventId !== "string" || eventId.length === 0 || eventId.length > 128
    || typeof disposition !== "string" || !(disposition in dispositionInventoryStatus)
  ) {
    return json({ error: "Command, event, and physical disposition are required." }, 400);
  }

  const existingCommand = await findCommand(commandId, env);
  if (existingCommand !== null) {
    if (existingCommand.event_id !== eventId || existingCommand.command_type !== "RECORD_DUCK_DISPOSITION") {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = "token" in selector
      ? await env.DB.prepare(
        `SELECT ded.id AS disposition_id, ded.disposition, d.visible_number,
                d.inventory_status, e.status AS event_status
           FROM duck_event_dispositions ded
           JOIN event_ducks ed ON ed.id = ded.event_duck_id
           JOIN ducks d ON d.id = ed.duck_id
           JOIN duck_tags dt ON dt.duck_id = d.id AND dt.token = ?
           JOIN events e ON e.id = ded.event_id
          WHERE ded.id = ? AND ded.event_id = ?
          LIMIT 1`,
      ).bind(selector.token, existingCommand.result_id, eventId).first<DispositionResultRow>()
      : await env.DB.prepare(
        `SELECT ded.id AS disposition_id, ded.disposition, d.visible_number,
                d.inventory_status, e.status AS event_status
           FROM duck_event_dispositions ded
           JOIN event_ducks ed ON ed.id = ded.event_duck_id
           JOIN ducks d ON d.id = ed.duck_id
           JOIN events e ON e.id = ded.event_id
          WHERE ded.id = ? AND ded.event_id = ? AND d.visible_number = ?
          LIMIT 1`,
      ).bind(existingCommand.result_id, eventId, selector.visibleNumber).first<DispositionResultRow>();
    return replay === null
      ? json({ error: "The saved command does not match this duck." }, 409)
      : dispositionResponse(replay, true);
  }

  const contextQuery = `SELECT d.id AS duck_id, d.visible_number, ed.id AS event_duck_id,
            e.status AS event_status, ded.id AS disposition_id,
            da.id AS active_assignment_id
       FROM ducks d
       JOIN event_ducks ed ON ed.duck_id = d.id AND ed.event_id = ?
       JOIN events e ON e.id = ed.event_id
       LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
       LEFT JOIN duck_assignments da
         ON da.event_duck_id = ed.id AND da.valid_to IS NULL`;
  const context = await ("token" in selector
    ? env.DB.prepare(
      `${contextQuery}
       JOIN duck_tags dt ON dt.duck_id = d.id
      WHERE dt.token = ? AND dt.status = 'ACTIVE'
      LIMIT 1`,
    ).bind(eventId, selector.token)
    : env.DB.prepare(
      `${contextQuery}
      WHERE d.visible_number = ?
      LIMIT 1`,
    ).bind(eventId, selector.visibleNumber)
  ).first<{
    duck_id: string;
    visible_number: number;
    event_duck_id: string;
    event_status: string;
    disposition_id: string | null;
    active_assignment_id: string | null;
  }>();
  if (context === null) return json({ error: "This duck is not reserved for that event." }, 404);
  if (!["COMPLETED", "RETURN_PROCESSING"].includes(context.event_status)) {
    return json({ error: "Duck returns can be recorded only after racing is complete." }, 409);
  }

  const now = new Date().toISOString();
  const dispositionId = context.disposition_id ?? crypto.randomUUID();
  const inventoryStatus = dispositionInventoryStatus[disposition as DuckDisposition];
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at)
       SELECT ?, ?, 'RECORD_DUCK_DISPOSITION', ?, ?, ?
         FROM events
        WHERE id = ? AND status IN ('COMPLETED', 'RETURN_PROCESSING')`,
    ).bind(commandId, eventId, dispositionId, now, now, eventId),
  ];
  if (context.disposition_id === null) {
    statements.push(env.DB.prepare(
      `INSERT INTO duck_event_dispositions
        (id, event_id, event_duck_id, disposition, recorded_by_staff_profile_id,
         source_command_id, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(dispositionId, eventId, context.event_duck_id, disposition, actor.id, commandId, now));
  } else {
    statements.push(env.DB.prepare(
      `UPDATE duck_event_dispositions
          SET disposition = ?, recorded_by_staff_profile_id = ?,
              source_command_id = ?, recorded_at = ?
        WHERE id = ? AND event_id = ?`,
    ).bind(disposition, actor.id, commandId, now, dispositionId, eventId));
  }
  if (context.active_assignment_id !== null) {
    statements.push(env.DB.prepare(
      `UPDATE duck_assignments
          SET valid_to = ?, end_reason = ?, ended_by_staff_profile_id = ?
        WHERE id = ? AND valid_to IS NULL`,
    ).bind(now, disposition, actor.id, context.active_assignment_id));
  }
  statements.push(
    env.DB.prepare(
      `UPDATE event_ducks
          SET released_at = COALESCE(released_at, ?), release_reason = ?,
              released_by_staff_profile_id = ?
        WHERE id = ? AND event_id = ?`,
    ).bind(now, disposition, actor.id, context.event_duck_id, eventId),
    env.DB.prepare(
      `UPDATE ducks
          SET inventory_status = ?, inventory_status_changed_at = ?,
              updated_at = ?, revision = revision + 1
        WHERE id = ?`,
    ).bind(inventoryStatus, now, now, context.duck_id),
    env.DB.prepare(
      `UPDATE events
          SET status = 'RETURN_PROCESSING', updated_at = ?
        WHERE id = ? AND status = 'COMPLETED'`,
    ).bind(now, eventId),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_id, command_id, action, subject_type, subject_id,
         actor_type, occurred_at, details_json)
       VALUES (?, ?, ?, ?, 'EVENT_DUCK', ?, 'STAFF', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      eventId,
      commandId,
      context.disposition_id === null ? "DUCK_DISPOSITION_RECORDED" : "DUCK_DISPOSITION_CORRECTED",
      context.event_duck_id,
      now,
      JSON.stringify({
        staff_profile_id: actor.id,
        duck_id: context.duck_id,
        disposition,
        inventory_status: inventoryStatus,
      }),
    ),
  );

  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: "The disposition conflicted with another update. Refresh and try again." }, 409);
  }

  return dispositionResponse({
    disposition_id: dispositionId,
    disposition: disposition as DuckDisposition,
    visible_number: context.visible_number,
    inventory_status: inventoryStatus,
    event_status: "RETURN_PROCESSING",
  }, false);
};

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

const searchRegistrations = async (url: URL, env: Env): Promise<Response> => {
  const eventId = url.searchParams.get("eventId")?.trim() ?? "";
  const query = url.searchParams.get("q")?.trim() ?? "";
  if (eventId.length === 0 || query.length < 2 || query.length > 80) {
    return json({ error: "Event and at least two search characters are required." }, 400);
  }

  const exactCode = query.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const like = `%${escapeLike(query)}%`;
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
        AND (
           r.lookup_code = ? COLLATE NOCASE
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
      LIMIT 20`,
  ).bind(eventId, exactCode, like, like, like, like, like, exactCode).all<{
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

  return json({
    registrations: results.results.map((row) => ({
      registrationId: row.registration_id,
      raceEntryId: row.race_entry_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      phone: row.phone,
      lookupCode: row.lookup_code,
      status: row.status,
      assignedDuckNumber: row.visible_number,
    })),
  });
};

interface PairingContext {
  event_id: string;
  heat_assignment_mode: string;
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
  heat: { number: number } | null,
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
  heat: heat === null ? null : { round: "ROUND_ONE", number: heat.number },
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
  const lookupCode = lookupCodeValue.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!/^[A-HJ-NP-Z2-9]{8}$/.test(lookupCode)) {
    return json({ error: "Enter a valid participant lookup code." }, 400);
  }

  const replay = await env.DB.prepare(
    `SELECT da.id AS assignment_id, d.visible_number,
            e.id AS event_id, e.heat_assignment_mode, e.round_one_heat_capacity,
            e.final_heat_capacity,
            r.id AS registration_id, r.status AS registration_status,
            r.revision AS registration_revision,
            re.id AS race_entry_id, re.revision AS race_entry_revision,
            r.first_name, r.last_name, r.email, r.phone, r.lookup_code,
            h.heat_number
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
           WHERE he2.race_entry_id = re.id AND h2.round = 'ROUND_ONE'
           ORDER BY h2.heat_number
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
    heat_number: number | null;
  }>();
  if (replay !== null) {
    return pairingResponse(
      replay.assignment_id,
      replay.visible_number,
      replay,
      replay.heat_number === null ? null : { number: replay.heat_number },
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

  const context = await env.DB.prepare(
    `SELECT e.id AS event_id, e.heat_assignment_mode, e.round_one_heat_capacity,
            e.final_heat_capacity,
            r.id AS registration_id, r.status AS registration_status,
            r.revision AS registration_revision,
            re.id AS race_entry_id, re.revision AS race_entry_revision,
            r.first_name, r.last_name, r.email, r.phone, r.lookup_code
       FROM registrations r
       JOIN race_entries re ON re.registration_id = r.id
       JOIN events e ON e.id = r.event_id
       LEFT JOIN duck_assignments da
         ON da.race_entry_id = re.id AND da.valid_to IS NULL
      WHERE r.event_id = ?
        AND r.lookup_code = ? COLLATE NOCASE
        AND r.status = 'SUBMITTED'
        AND da.id IS NULL
        AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED')
      LIMIT 1`,
  ).bind(eventId, lookupCode).first<PairingContext>();
  if (context === null) {
    return json({ error: "No unpaired participant matches that code in this event." }, 404);
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

  let heat: { id: string; number: number; slot: number; isNew: boolean } | null = null;
  if (context.heat_assignment_mode === "IMMEDIATE_FIXED") {
    const existingHeat = await env.DB.prepare(
      `SELECT h.id, h.heat_number, COUNT(he.id) AS entry_count
         FROM heats h
         LEFT JOIN heat_entries he ON he.heat_id = h.id
        WHERE h.event_id = ? AND h.round = 'ROUND_ONE'
          AND h.status IN ('PLANNED', 'LOADING', 'READY')
        GROUP BY h.id
       HAVING COUNT(he.id) < ?
        ORDER BY h.heat_number
        LIMIT 1`,
    ).bind(eventId, context.round_one_heat_capacity).first<{
      id: string;
      heat_number: number;
      entry_count: number;
    }>();
    if (existingHeat === null) {
      const last = await env.DB.prepare(
        `SELECT COALESCE(MAX(heat_number), 0) AS last_number,
                COUNT(*) AS heat_count
           FROM heats
           WHERE event_id = ? AND round = 'ROUND_ONE'`,
      ).bind(eventId).first<{ last_number: number; heat_count: number }>();
      if ((last?.heat_count ?? 0) >= context.final_heat_capacity) {
        return json({ error: "Pairing would create more round-one heats than the final can hold." }, 409);
      }
      heat = {
        id: crypto.randomUUID(),
        number: (last?.last_number ?? 0) + 1,
        slot: 1,
        isNew: true,
      };
      statements.push(env.DB.prepare(
        `INSERT INTO heats
          (id, event_id, round, heat_number, status, target_size)
         VALUES (?, ?, 'ROUND_ONE', ?, 'PLANNED', ?)`,
      ).bind(heat.id, eventId, heat.number, context.round_one_heat_capacity));
    } else {
      heat = {
        id: existingHeat.id,
        number: existingHeat.heat_number,
        slot: existingHeat.entry_count + 1,
        isNew: false,
      };
    }
    statements.push(env.DB.prepare(
      `INSERT INTO heat_entries
        (id, event_id, heat_id, race_entry_id, round, slot_number, assignment_source, assigned_at)
       VALUES (?, ?, ?, ?, 'ROUND_ONE', ?, 'PAIRING', ?)`,
    ).bind(crypto.randomUUID(), eventId, heat.id, context.race_entry_id, heat.slot, now));
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

  return pairingResponse(
    assignmentId,
    duck.visible_number,
    context,
    heat === null ? null : { number: heat.number },
    false,
  );
};

const dispositionCounts = async (eventId: string, env: Env): Promise<Record<string, number>> => {
  const rows = await env.DB.prepare(
    `SELECT disposition, COUNT(*) AS disposition_count
       FROM duck_event_dispositions
      WHERE event_id = ?
      GROUP BY disposition
      ORDER BY disposition`,
  ).bind(eventId).all<{ disposition: string; disposition_count: number }>();
  return Object.fromEntries(rows.results.map((row) => [row.disposition, row.disposition_count]));
};

const returnReview = async (env: Env): Promise<Response> => {
  const event = await env.DB.prepare(
    `SELECT id, name, status
       FROM events
      WHERE status IN ('COMPLETED', 'RETURN_PROCESSING', 'ARCHIVED')
      ORDER BY CASE status WHEN 'RETURN_PROCESSING' THEN 0 WHEN 'COMPLETED' THEN 1 ELSE 2 END
      LIMIT 1`,
  ).first<{ id: string; name: string; status: string }>();
  if (event === null) return json({ event: null });

  const summary = await env.DB.prepare(
    `SELECT COUNT(*) AS total_count,
            SUM(CASE WHEN ded.id IS NULL THEN 1 ELSE 0 END) AS unresolved_count,
            SUM(CASE WHEN ed.released_at IS NULL AND ded.id IS NOT NULL THEN 1 ELSE 0 END) AS unreleased_count
       FROM event_ducks ed
       LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
      WHERE ed.event_id = ?`,
  ).bind(event.id).first<{
    total_count: number;
    unresolved_count: number;
    unreleased_count: number;
  }>();
  const blockingHeat = await env.DB.prepare(
    `SELECT id FROM heats
      WHERE event_id = ? AND status IN ('RUNNING', 'AWAITING_RESULT')
      LIMIT 1`,
  ).bind(event.id).first<{ id: string }>();
  const activeAssignment = await env.DB.prepare(
    `SELECT id FROM duck_assignments
      WHERE event_id = ? AND valid_to IS NULL
      LIMIT 1`,
  ).bind(event.id).first<{ id: string }>();
  const unresolvedDucks = await env.DB.prepare(
    `SELECT d.visible_number
       FROM event_ducks ed
       JOIN ducks d ON d.id = ed.duck_id
       LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
      WHERE ed.event_id = ? AND ded.id IS NULL
      ORDER BY d.visible_number
      LIMIT 100`,
  ).bind(event.id).all<{ visible_number: number }>();

  return json({
    event,
    review: {
      totalDucks: summary?.total_count ?? 0,
      unresolvedDucks: summary?.unresolved_count ?? 0,
      unreleasedDucks: summary?.unreleased_count ?? 0,
      hasBlockingHeat: blockingHeat !== null,
      hasActiveAssignment: activeAssignment !== null,
      unresolvedDuckNumbers: unresolvedDucks.results.map((duck) => duck.visible_number),
      dispositions: await dispositionCounts(event.id, env),
    },
  });
};

const markEventPurgeReady = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
): Promise<Response> => {
  if (!actor.isSystemAdmin) return json({ error: "Administrator permission required." }, 403);
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || payload?.returnReviewCompleted !== true
    || payload?.permanentDeletionAcknowledged !== true
  ) {
    return json({ error: "Command, completed return review, and permanent-deletion acknowledgement are required." }, 400);
  }

  const existingCommand = await findCommand(commandId, env);
  if (existingCommand !== null) {
    if (existingCommand.event_id !== eventId || existingCommand.command_type !== "MARK_EVENT_PURGE_READY") {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const event = await env.DB.prepare(
      "SELECT id, name, status FROM events WHERE id = ?",
    ).bind(eventId).first<{ id: string; name: string; status: string }>();
    return event === null
      ? json({ error: "Event not found." }, 404)
      : json({ event, dispositions: await dispositionCounts(eventId, env), replayed: true });
  }

  const event = await env.DB.prepare(
    "SELECT id, name, status FROM events WHERE id = ?",
  ).bind(eventId).first<{ id: string; name: string; status: string }>();
  if (event === null) return json({ error: "Event not found." }, 404);
  if (!["COMPLETED", "RETURN_PROCESSING"].includes(event.status)) {
    return json({ error: "The event is not in return review." }, 409);
  }

  const blockingHeat = await env.DB.prepare(
    `SELECT id FROM heats
      WHERE event_id = ? AND status IN ('RUNNING', 'AWAITING_RESULT')
      LIMIT 1`,
  ).bind(eventId).first<{ id: string }>();
  if (blockingHeat !== null) {
    return json({ error: "A heat is still running or awaiting a result." }, 409);
  }
  const unresolved = await env.DB.prepare(
    `SELECT ed.id
       FROM event_ducks ed
       LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
      WHERE ed.event_id = ? AND ded.id IS NULL
      LIMIT 1`,
  ).bind(eventId).first<{ id: string }>();
  if (unresolved !== null) {
    return json({ error: "Every event duck needs a physical disposition." }, 409);
  }
  const unreleased = await env.DB.prepare(
    `SELECT id FROM event_ducks
      WHERE event_id = ? AND released_at IS NULL
      LIMIT 1`,
  ).bind(eventId).first<{ id: string }>();
  if (unreleased !== null) {
    return json({ error: "Every event duck reservation must be released." }, 409);
  }
  const activeAssignment = await env.DB.prepare(
    `SELECT id FROM duck_assignments
      WHERE event_id = ? AND valid_to IS NULL
      LIMIT 1`,
  ).bind(eventId).first<{ id: string }>();
  if (activeAssignment !== null) {
    return json({ error: "Every duck assignment must be closed." }, 409);
  }

  const counts = await dispositionCounts(eventId, env);
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, ?, 'MARK_EVENT_PURGE_READY', ?, ?, ?
           FROM events
          WHERE id = ? AND status IN ('COMPLETED', 'RETURN_PROCESSING')`,
      ).bind(commandId, eventId, eventId, now, now, eventId),
      env.DB.prepare(
        `UPDATE events SET status = 'ARCHIVED', updated_at = ?
          WHERE id = ? AND status IN ('COMPLETED', 'RETURN_PROCESSING')`,
      ).bind(now, eventId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, 'EVENT_MARKED_PURGE_READY', 'EVENT', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        commandId,
        eventId,
        now,
        JSON.stringify({ staff_profile_id: actor.id, disposition_counts: counts }),
      ),
    ]);
  } catch {
    return json({ error: "Purge readiness conflicted with another update. Refresh and try again." }, 409);
  }

  return json({
    event: { ...event, status: "ARCHIVED" },
    dispositions: counts,
    replayed: false,
  }, 201);
};

const cancelEventPurgeReady = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
): Promise<Response> => {
  if (!actor.isSystemAdmin) return json({ error: "Administrator permission required." }, 403);
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const reason = typeof payload?.reason === "string" ? payload.reason.trim() : "";
  if (typeof commandId !== "string" || !isCommandId(commandId) || reason.length < 4 || reason.length > 500) {
    return json({ error: "Command and a correction reason between 4 and 500 characters are required." }, 400);
  }

  const existingCommand = await findCommand(commandId, env);
  if (existingCommand !== null) {
    if (existingCommand.event_id !== eventId || existingCommand.command_type !== "CANCEL_EVENT_PURGE_READY") {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const event = await env.DB.prepare(
      "SELECT id, name, status FROM events WHERE id = ?",
    ).bind(eventId).first<{ id: string; name: string; status: string }>();
    return event === null
      ? json({ error: "Event not found." }, 404)
      : json({ event, replayed: true });
  }

  const event = await env.DB.prepare(
    "SELECT id, name, status FROM events WHERE id = ?",
  ).bind(eventId).first<{ id: string; name: string; status: string }>();
  if (event === null) return json({ error: "Event not found." }, 404);
  if (event.status !== "ARCHIVED") return json({ error: "The event is not purge-ready." }, 409);

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, ?, 'CANCEL_EVENT_PURGE_READY', ?, ?, ?
           FROM events
          WHERE id = ? AND status = 'ARCHIVED'`,
      ).bind(commandId, eventId, eventId, now, now, eventId),
      env.DB.prepare(
        "UPDATE events SET status = 'RETURN_PROCESSING', updated_at = ? WHERE id = ? AND status = 'ARCHIVED'",
      ).bind(now, eventId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, 'EVENT_PURGE_READY_CANCELLED', 'EVENT', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        commandId,
        eventId,
        now,
        JSON.stringify({ staff_profile_id: actor.id, reason }),
      ),
    ]);
  } catch {
    return json({ error: "The correction request conflicted with another update. Refresh and try again." }, 409);
  }

  return json({ event: { ...event, status: "RETURN_PROCESSING" }, replayed: false }, 201);
};

const purgeEvent = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
): Promise<Response> => {
  if (!actor.isSystemAdmin) return json({ error: "Administrator permission required." }, 403);
  const payload = await readJson(request);
  if (payload === null || typeof payload.confirmation !== "string") {
    return json({ error: "A typed purge confirmation is required." }, 400);
  }

  const event = await env.DB.prepare(
    "SELECT id, name, status FROM events WHERE id = ?",
  ).bind(eventId).first<{ id: string; name: string; status: string }>();
  if (event === null) return new Response(null, { status: 204, headers });
  if (event.status !== "ARCHIVED") {
    return json({ error: "The event must pass return review and be marked purge-ready first." }, 409);
  }
  const purgeClaim = await env.DB.prepare(
    "SELECT status FROM event_purge_claims WHERE event_id = ? AND status = 'PURGING'",
  ).bind(eventId).first<{ status: string }>();
  if (purgeClaim === null) {
    return json({ error: "The event must have an active purge claim before permanent deletion." }, 409);
  }
  if (payload.confirmation !== `DELETE ${event.name}`) {
    return json({ error: `Type DELETE ${event.name} to confirm permanent deletion.` }, 422);
  }

  const otherEvent = await env.DB.prepare(
    "SELECT id FROM events WHERE id != ? LIMIT 1",
  ).bind(eventId).first<{ id: string }>();
  if (otherEvent !== null) {
    return json({ error: "Full purge requires this to be the only race dataset." }, 409);
  }

  const unresolved = await env.DB.prepare(
    `SELECT ed.id
       FROM event_ducks ed
       LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
      WHERE ed.event_id = ? AND ded.id IS NULL
      LIMIT 1`,
  ).bind(eventId).first<{ id: string }>();
  if (unresolved !== null) {
    return json({ error: "Every event duck needs a physical disposition before purge." }, 409);
  }

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM browser_collection_registrations"),
      env.DB.prepare("DELETE FROM email_attempts WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM email_notifications WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM heat_result_history WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM heat_results WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM heat_entries WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM heats WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM return_batch_items WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM return_batches WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM duck_event_dispositions WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM duck_assignments WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM event_ducks WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM duck_inventory_events WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM audit_events"),
      env.DB.prepare("DELETE FROM race_entries WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM registrations WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM race_commands WHERE event_id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM events WHERE id = ?").bind(eventId),
      env.DB.prepare("DELETE FROM duck_tags"),
      env.DB.prepare("DELETE FROM ducks"),
      env.DB.prepare("DELETE FROM browser_registration_collections"),
    ]);
  } catch {
    return json({ error: "Purge did not complete. No partial deletion was accepted." }, 409);
  }

  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      "clear-site-data": '"cache", "cookies", "storage"',
      "set-cookie": "__Host-quickducks_browser=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax",
    },
  });
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

  if (url.pathname === "/api/v1/staff/events/return-review" && request.method === "GET") {
    const denied = requireAnyRole(actor, ["RETURN_STEWARD", "RACE_DIRECTOR"]);
    return denied ?? returnReview(env);
  }

  const cancelPurgeReadyMatch = url.pathname.match(/^\/api\/v1\/staff\/events\/([^/]{1,128})\/purge-ready\/cancel$/);
  if (cancelPurgeReadyMatch !== null && request.method === "POST") {
    return cancelEventPurgeReady(request, env, actor, cancelPurgeReadyMatch[1]);
  }

  const purgeReadyMatch = url.pathname.match(/^\/api\/v1\/staff\/events\/([^/]{1,128})\/purge-ready$/);
  if (purgeReadyMatch !== null && request.method === "POST") {
    return markEventPurgeReady(request, env, actor, purgeReadyMatch[1]);
  }

  const purgeMatch = url.pathname.match(/^\/api\/v1\/staff\/events\/([^/]+)\/purge$/);
  if (purgeMatch !== null && request.method === "POST") {
    return purgeEvent(request, env, actor, purgeMatch[1]);
  }

  if (url.pathname === "/api/v1/staff/registrations/search" && request.method === "GET") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return searchRegistrations(url, env);
  }

  const assignmentMatch = url.pathname.match(/^\/api\/v1\/staff\/ducks\/([A-Za-z0-9_-]+)\/assignments$/);
  if (assignmentMatch !== null && request.method === "POST") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return pairDuck(request, env, actor, assignmentMatch[1]);
  }

  const numberedDispositionMatch = url.pathname.match(
    /^\/api\/v1\/staff\/events\/([^/]{1,128})\/ducks\/([1-9][0-9]{0,8})\/dispositions$/,
  );
  if (numberedDispositionMatch !== null && request.method === "POST") {
    const denied = requireAnyRole(actor, ["RETURN_STEWARD", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return recordDuckDisposition(request, env, actor, {
      eventId: numberedDispositionMatch[1],
      visibleNumber: Number(numberedDispositionMatch[2]),
    });
  }

  const dispositionMatch = url.pathname.match(/^\/api\/v1\/staff\/ducks\/([A-Za-z0-9_-]+)\/dispositions$/);
  if (dispositionMatch !== null && request.method === "POST") {
    const denied = requireAnyRole(actor, ["RETURN_STEWARD", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return recordDuckDisposition(request, env, actor, { token: dispositionMatch[1] });
  }

  const duckMatch = url.pathname.match(/^\/api\/v1\/staff\/ducks\/([A-Za-z0-9_-]+)$/);
  if (duckMatch !== null && request.method === "GET") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "DUCK_MANAGER", "RETURN_STEWARD", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return getStaffDuck(duckMatch[1], env, actor);
  }

  return json({ error: "Not found." }, 404);
};
