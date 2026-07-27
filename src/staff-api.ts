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
            r.status AS registration_status
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
      WHERE dt.token = ?
      ORDER BY CASE dt.status WHEN 'ACTIVE' THEN 0 ELSE 1 END
      LIMIT 1`,
  ).bind(token).first<StaffDuckRow>();
  if (duck === null) return json({ error: "Duck not found." }, 404);

  const includePii = canViewParticipantPii(actor);
  const assignment = duck.assignment_id === null ? null : {
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
      && duck.tag_status === "ACTIVE"
      && ["AVAILABLE", "RESERVED_FOR_EVENT"].includes(duck.inventory_status),
    event: duck.event_id === null ? null : {
      id: duck.event_id,
      name: duck.event_name,
      status: duck.event_status,
    },
    assignment,
  });
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
            e.id AS event_id, e.round_one_heat_capacity,
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
    `SELECT e.id AS event_id, e.round_one_heat_capacity,
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

  // Assigning a heat while pairing is the only heat model. The retired
  // post-close balanced planner is gone, so an event row that still carries the
  // retired mode value is paired into heats exactly like every other event
  // rather than being left with no route to a heat at all.
  let heat: { id: string; number: number; slot: number; isNew: boolean } | null = null;
  {
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
      // Guarded creation: no row is inserted once round-one heats reach final
      // capacity, and the dependent heat-entry insert then fails its foreign
      // key, rolling the whole pairing batch back.
      statements.push(env.DB.prepare(
        `INSERT INTO heats
          (id, event_id, round, heat_number, status, target_size, source_command_id)
         SELECT ?, e.id, 'ROUND_ONE', ?, 'PLANNED', e.round_one_heat_capacity, ?
           FROM events e
          WHERE e.id = ?
            AND (SELECT COUNT(*) FROM heats h
                  WHERE h.event_id = e.id AND h.round = 'ROUND_ONE') < e.final_heat_capacity`,
      ).bind(heat.id, heat.number, commandId, eventId));
    } else {
      heat = {
        id: existingHeat.id,
        number: existingHeat.heat_number,
        slot: existingHeat.entry_count + 1,
        isNew: false,
      };
    }
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
      heat.id,
      context.race_entry_id,
      heat.id,
      heat.id,
      now,
      commandId,
      eventId,
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

  return pairingResponse(
    assignmentId,
    duck.visible_number,
    context,
    heat === null ? null : { number: heat.number },
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

  const assignmentMatch = url.pathname.match(/^\/api\/v1\/staff\/ducks\/([A-Za-z0-9_-]+)\/assignments$/);
  if (assignmentMatch !== null && request.method === "POST") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return pairDuck(request, env, actor, assignmentMatch[1]);
  }

  const duckMatch = url.pathname.match(/^\/api\/v1\/staff\/ducks\/([A-Za-z0-9_-]+)$/);
  if (duckMatch !== null && request.method === "GET") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "DUCK_MANAGER", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return getStaffDuck(duckMatch[1], env, actor);
  }

  return json({ error: "Not found." }, 404);
};
