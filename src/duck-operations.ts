import type { StaffActor } from "./auth.ts";
import { canViewParticipantPii, requireAnyRole } from "./authorization.ts";
import { publicDuckName } from "./duck-name-filter.ts";
import { isCommandId } from "./registration.ts";
import type { Env } from "./types.ts";

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
} as const;

const inventoryPath = "/api/v1/staff/inventory";
const preRaceStatuses = ["DRAFT", "REGISTRATION_OPEN", "REGISTRATION_CLOSED"] as const;
const activeRaceStatuses = [...preRaceStatuses, "ROUND_ONE", "FINAL"] as const;

// `ducks.physical_condition` is no longer a field staff set or read. Nothing
// outside this module writes anything but the two values the blank-sticker
// station uses for itself: NEEDS_TAG while a sticker is reserved and unwritten,
// GOOD once it is confirmed. Delete duck replaced every judgement the old
// condition dropdown was making. The column stays until a later release drops
// it, because a migration must be safe against the previously deployed Worker.
const physicalConditions = ["GOOD", "NEEDS_TAG", "DAMAGED", "RETIRED"] as const;

type PhysicalCondition = typeof physicalConditions[number];

const inventoryStatusForCondition = (
  condition: PhysicalCondition | undefined,
  goodStatus: "AVAILABLE" | "RESERVED_FOR_EVENT" | "IN_USE",
): string => {
  if (condition === "NEEDS_TAG") return "QUARANTINED";
  if (condition === "DAMAGED") return "DAMAGED";
  if (condition === "RETIRED") return "RETIRED";
  return goodStatus;
};

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers });

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 16_384) return null;
  try {
    const body = await request.text();
    if (body.length > 16_384) return null;
    const parsed = JSON.parse(body) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const cleanOptional = (value: unknown, maximum: number): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length === 0 || cleaned.length > maximum) return undefined;
  return cleaned;
};

const validEntityId = (value: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(value);
const validEventId = (value: unknown): value is string =>
  typeof value === "string" && validEntityId(value);
const validRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const validVisibleNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 999_999_999;
const validTagToken = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{22,128}$/.test(value);

const canonicalTagToken = (value: unknown, appOrigin: string): string | null => {
  if (typeof value !== "string") return null;
  try {
    const configured = new URL(appOrigin);
    const parsed = new URL(value);
    const match = parsed.pathname.match(/^\/t\/([A-Za-z0-9_-]{22,128})$/);
    return configured.pathname === "/"
      && configured.search === ""
      && configured.hash === ""
      && parsed.origin === configured.origin
      && parsed.username === ""
      && parsed.password === ""
      && parsed.search === ""
      && parsed.hash === ""
      && match !== null
      && value === `${configured.origin}/t/${match[1]}`
      ? match[1]
      : null;
  } catch {
    return null;
  }
};

const hashValue = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

interface DuckSummaryRow {
  duck_id: string;
  visible_number: number;
  inventory_status: string;
  duck_revision: number;
  storage_location: string | null;
  notes: string | null;
  tag_id: string | null;
  tag_status: string | null;
  tag_activated_at: string | null;
  event_duck_id: string | null;
  reserved_at: string | null;
  released_at: string | null;
  event_id: string | null;
  event_name: string | null;
  event_status: string | null;
  assignment_id: string | null;
  assignment_valid_from: string | null;
  race_entry_id: string | null;
  duck_name: string | null;
  registration_id: string | null;
  first_name: string | null;
  last_name: string | null;
  registration_status: string | null;
  heat_id: string | null;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  heat_slot_number: number | null;
}

const duckSelect = `
  SELECT d.id AS duck_id, d.visible_number, d.inventory_status,
         d.revision AS duck_revision,
         d.storage_location, d.notes,
         dt.id AS tag_id, dt.status AS tag_status, dt.activated_at AS tag_activated_at,
         ed.id AS event_duck_id, ed.reserved_at, ed.released_at,
         e.id AS event_id, e.name AS event_name, e.status AS event_status,
         da.id AS assignment_id, da.valid_from AS assignment_valid_from,
         da.race_entry_id, re.duck_name, r.id AS registration_id,
         r.first_name, r.last_name, r.status AS registration_status,
         h.id AS heat_id, h.round AS heat_round, h.heat_number,
         h.status AS heat_status, he.slot_number AS heat_slot_number
    FROM ducks d
    LEFT JOIN duck_tags dt ON dt.id = (
      SELECT dt2.id
        FROM duck_tags dt2
       WHERE dt2.duck_id = d.id
       ORDER BY CASE dt2.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,
                COALESCE(dt2.activated_at, dt2.created_at) DESC
       LIMIT 1
    )
    LEFT JOIN event_ducks ed ON ed.id = (
      SELECT ed2.id
        FROM event_ducks ed2
       WHERE ed2.duck_id = d.id
       ORDER BY CASE WHEN ed2.released_at IS NULL THEN 0 ELSE 1 END,
                ed2.reserved_at DESC
       LIMIT 1
    )
    LEFT JOIN events e ON e.id = ed.event_id
    LEFT JOIN duck_assignments da
      ON da.event_duck_id = ed.id AND da.valid_to IS NULL
    LEFT JOIN race_entries re ON re.id = da.race_entry_id
    LEFT JOIN registrations r ON r.id = re.registration_id
    LEFT JOIN heat_entries he ON he.id = (
      SELECT he2.id
        FROM heat_entries he2
        JOIN heats h2 ON h2.id = he2.heat_id
       WHERE he2.race_entry_id = da.race_entry_id
       ORDER BY CASE h2.round WHEN 'FINAL' THEN 0 ELSE 1 END, h2.heat_number
       LIMIT 1
    )
    LEFT JOIN heats h ON h.id = he.heat_id`;

const summaryResponse = (row: DuckSummaryRow, includePii: boolean): Record<string, unknown> => ({
  id: row.duck_id,
  visibleNumber: row.visible_number,
  inventoryStatus: row.inventory_status,
  revision: row.duck_revision,
  location: row.storage_location,
  notes: row.notes,
  tag: row.tag_id === null ? null : {
    id: row.tag_id,
    status: row.tag_status,
    activatedAt: row.tag_activated_at,
  },
  reservation: row.event_duck_id === null ? null : {
    id: row.event_duck_id,
    reservedAt: row.reserved_at,
    releasedAt: row.released_at,
    event: {
      id: row.event_id,
      name: row.event_name,
      status: row.event_status,
    },
  },
  assignment: row.assignment_id === null ? null : {
    id: row.assignment_id,
    validFrom: row.assignment_valid_from,
    raceEntryId: row.race_entry_id,
  },
  // Inventory staff name and moderate this duck, so they see exactly what is
  // stored plus whether the read-time filter is already hiding it. It is the
  // same projection the participant console already carries, under the same
  // authenticated inventory roles, and it names a duck rather than a person.
  duckName: row.assignment_id === null ? null : row.duck_name,
  duckNamePubliclyHidden: row.assignment_id !== null
    && row.duck_name !== null
    && publicDuckName(row.duck_name) === null,
  participant: row.registration_id === null ? null : {
    registrationId: row.registration_id,
    raceEntryId: row.race_entry_id,
    ...(includePii ? { firstName: row.first_name, lastName: row.last_name } : {}),
    status: row.registration_status,
  },
  heat: row.heat_id === null ? null : {
    id: row.heat_id,
    round: row.heat_round,
    number: row.heat_number,
    status: row.heat_status,
    slotNumber: row.heat_slot_number,
  },
});

const getDuckSummary = (env: Env, duckId: string): Promise<DuckSummaryRow | null> =>
  env.DB.prepare(`${duckSelect} WHERE d.id = ? LIMIT 1`).bind(duckId).first<DuckSummaryRow>();

// RETIRED is now reachable only through delete duck, and only for a duck whose
// rows have to survive a published result. Leaving it in the list would make a
// deleted duck look like it was merely set aside, so it is excluded here and
// the two delete paths look identical to the actor.
const listDucks = async (env: Env, includePii: boolean): Promise<Response> => {
  const ducks = await env.DB.prepare(
    `${duckSelect} WHERE d.inventory_status != 'RETIRED' ORDER BY d.visible_number`,
  ).all<DuckSummaryRow>();
  return json({ ducks: ducks.results.map((duck) => summaryResponse(duck, includePii)) });
};

const parseDetails = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const getDuckHistory = async (
  env: Env,
  duckId: string,
  includePii: boolean,
): Promise<Record<string, unknown>> => {
  const [inventoryEvents, tags, reservations, assignments] = await Promise.all([
    env.DB.prepare(
      `SELECT die.id, die.action, die.occurred_at, die.details_json,
              sp.id AS actor_id, sp.display_name AS actor_display_name
         FROM duck_inventory_events die
         JOIN staff_profiles sp ON sp.id = die.actor_staff_profile_id
        WHERE die.duck_id = ?
        ORDER BY die.occurred_at DESC, die.id DESC`,
    ).bind(duckId).all<{
      id: string;
      action: string;
      occurred_at: string;
      details_json: string;
      actor_id: string;
      actor_display_name: string | null;
    }>(),
    env.DB.prepare(
      `SELECT id, status, supersedes_tag_id, written_at, verified_at,
              activated_at, retired_at, created_at
         FROM duck_tags
        WHERE duck_id = ?
        ORDER BY created_at DESC, id DESC`,
    ).bind(duckId).all<{
      id: string;
      status: string;
      supersedes_tag_id: string | null;
      written_at: string | null;
      verified_at: string | null;
      activated_at: string | null;
      retired_at: string | null;
      created_at: string;
    }>(),
    env.DB.prepare(
      `SELECT ed.id, ed.reserved_at, ed.released_at, ed.release_reason,
              e.id AS event_id, e.name AS event_name, e.status AS event_status
         FROM event_ducks ed
         JOIN events e ON e.id = ed.event_id
        WHERE ed.duck_id = ?
        ORDER BY ed.reserved_at DESC, ed.id DESC`,
    ).bind(duckId).all<{
      id: string;
      reserved_at: string;
      released_at: string | null;
      release_reason: string | null;
      event_id: string;
      event_name: string;
      event_status: string;
    }>(),
    env.DB.prepare(
      `SELECT da.id, da.valid_from, da.valid_to, da.end_reason,
              da.race_entry_id, r.id AS registration_id,
              r.first_name, r.last_name, r.status AS registration_status,
              h.id AS heat_id, h.round, h.heat_number, h.status AS heat_status,
              he.slot_number
         FROM duck_assignments da
         JOIN race_entries re ON re.id = da.race_entry_id
         JOIN registrations r ON r.id = re.registration_id
         LEFT JOIN heat_entries he ON he.id = (
           SELECT he2.id
             FROM heat_entries he2
             JOIN heats h2 ON h2.id = he2.heat_id
            WHERE he2.race_entry_id = da.race_entry_id
            ORDER BY CASE h2.round WHEN 'FINAL' THEN 0 ELSE 1 END, h2.heat_number
            LIMIT 1
         )
         LEFT JOIN heats h ON h.id = he.heat_id
        WHERE da.duck_id = ?
        ORDER BY da.valid_from DESC, da.id DESC`,
    ).bind(duckId).all<{
      id: string;
      valid_from: string;
      valid_to: string | null;
      end_reason: string | null;
      race_entry_id: string;
      registration_id: string;
      first_name: string;
      last_name: string;
      registration_status: string;
      heat_id: string | null;
      round: string | null;
      heat_number: number | null;
      heat_status: string | null;
      slot_number: number | null;
    }>(),
  ]);

  return {
    inventoryEvents: inventoryEvents.results.map((row) => ({
      id: row.id,
      action: row.action,
      occurredAt: row.occurred_at,
      actor: { id: row.actor_id, displayName: row.actor_display_name },
      details: parseDetails(row.details_json),
    })),
    tags: tags.results.map((row) => ({
      id: row.id,
      status: row.status,
      supersedesTagId: row.supersedes_tag_id,
      writtenAt: row.written_at,
      verifiedAt: row.verified_at,
      activatedAt: row.activated_at,
      retiredAt: row.retired_at,
      createdAt: row.created_at,
    })),
    reservations: reservations.results.map((row) => ({
      id: row.id,
      reservedAt: row.reserved_at,
      releasedAt: row.released_at,
      releaseReason: row.release_reason,
      event: { id: row.event_id, name: row.event_name, status: row.event_status },
    })),
    assignments: assignments.results.map((row) => ({
      id: row.id,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      endReason: row.end_reason,
      participant: {
        registrationId: row.registration_id,
        raceEntryId: row.race_entry_id,
        ...(includePii ? { firstName: row.first_name, lastName: row.last_name } : {}),
        status: row.registration_status,
      },
      heat: row.heat_id === null ? null : {
        id: row.heat_id,
        round: row.round,
        number: row.heat_number,
        status: row.heat_status,
        slotNumber: row.slot_number,
      },
    })),
  };
};

const getDuckDetail = async (
  env: Env,
  duckId: string,
  historyOnly: boolean,
  includePii: boolean,
): Promise<Response> => {
  const duck = await getDuckSummary(env, duckId);
  if (duck === null) return json({ error: "Duck not found." }, 404);
  const history = await getDuckHistory(env, duckId, includePii);
  return historyOnly
    ? json({ duckId, history })
    : json({ duck: summaryResponse(duck, includePii), history });
};

interface ExistingCommand {
  event_id: string;
  command_type: string;
  result_id: string | null;
}

type CommandCheck =
  | { kind: "new" }
  | { kind: "replay"; resultId: string | null }
  | { kind: "conflict" };

const sameRequest = (actual: unknown, expected: Record<string, unknown>): boolean =>
  actual !== null
  && typeof actual === "object"
  && !Array.isArray(actual)
  && JSON.stringify((actual as { request?: unknown }).request) === JSON.stringify(expected);

const checkCommand = async (
  env: Env,
  commandId: string,
  eventId: string,
  commandType: string,
  requestDetails: Record<string, unknown>,
  expectedResultId?: string,
  duckId?: string,
): Promise<CommandCheck> => {
  const command = await env.DB.prepare(
    "SELECT event_id, command_type, result_id FROM race_commands WHERE id = ?",
  ).bind(commandId).first<ExistingCommand>();
  if (command === null) return { kind: "new" };
  if (
    command.event_id !== eventId
    || command.command_type !== commandType
    || (expectedResultId !== undefined && command.result_id !== expectedResultId)
  ) {
    return { kind: "conflict" };
  }

  const inventoryEvent = await (duckId === undefined
    ? env.DB.prepare(
      `SELECT details_json FROM duck_inventory_events
        WHERE source_command_id = ? ORDER BY occurred_at LIMIT 1`,
    ).bind(commandId)
    : env.DB.prepare(
      `SELECT details_json FROM duck_inventory_events
        WHERE source_command_id = ? AND duck_id = ? ORDER BY occurred_at LIMIT 1`,
    ).bind(commandId, duckId)
  ).first<{ details_json: string }>();
  if (inventoryEvent === null || !sameRequest(parseDetails(inventoryEvent.details_json), requestDetails)) {
    return { kind: "conflict" };
  }
  return { kind: "replay", resultId: command.result_id };
};

const execute = async (
  env: Env,
  statements: D1PreparedStatement[],
  commandId: string,
  eventId: string,
  commandType: string,
  requestDetails: Record<string, unknown>,
  resultId: string,
  duckId?: string,
): Promise<{ replayed: boolean; resultId: string } | null> => {
  try {
    await env.DB.batch(statements);
    return { replayed: false, resultId };
  } catch {
    const replay = await checkCommand(
      env,
      commandId,
      eventId,
      commandType,
      requestDetails,
      undefined,
      duckId,
    );
    return replay.kind === "replay" && replay.resultId !== null
      ? { replayed: true, resultId: replay.resultId }
      : null;
  }
};

const commandInsert = (
  env: Env,
  commandId: string,
  eventId: string,
  commandType: string,
  resultId: string,
  now: string,
  allowedStatuses: readonly string[],
): D1PreparedStatement => {
  const placeholders = allowedStatuses.map(() => "?").join(", ");
  return env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
     SELECT ?, ?, ?, ?, ?, ?
       FROM events
      WHERE id = ? AND status IN (${placeholders})`,
  ).bind(commandId, eventId, commandType, resultId, now, now, eventId, ...allowedStatuses);
};

const inventoryEventInsert = (
  env: Env,
  eventId: string,
  duckId: string,
  action: string,
  actorId: string,
  commandId: string,
  now: string,
  details: Record<string, unknown>,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO duck_inventory_events
    (id, event_id, duck_id, action, actor_staff_profile_id,
     source_command_id, occurred_at, details_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
).bind(
  crypto.randomUUID(),
  eventId,
  duckId,
  action,
  actorId,
  commandId,
  now,
  JSON.stringify(details),
);

const auditInsert = (
  env: Env,
  eventId: string,
  commandId: string,
  action: string,
  subjectType: string,
  subjectId: string,
  actorId: string,
  now: string,
  details: Record<string, unknown>,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO audit_events
    (id, event_id, command_id, action, subject_type, subject_id,
     actor_type, occurred_at, details_json)
   VALUES (?, ?, ?, ?, ?, ?, 'STAFF', ?, ?)`,
).bind(
  crypto.randomUUID(),
  eventId,
  commandId,
  action,
  subjectType,
  subjectId,
  now,
  JSON.stringify({ staff_profile_id: actorId, ...details }),
);

interface IntakeResultRow {
  duck_id: string;
  visible_number: number;
  inventory_status: string;
  revision: number;
  storage_location: string | null;
  notes: string | null;
  tag_id: string;
  event_duck_id: string;
}

const getIntakeResult = (env: Env, duckId: string, eventId: string): Promise<IntakeResultRow | null> =>
  env.DB.prepare(
    `SELECT d.id AS duck_id, d.visible_number, d.inventory_status, d.revision,
            d.storage_location, d.notes,
            dt.id AS tag_id, ed.id AS event_duck_id
       FROM ducks d
       JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'ACTIVE'
       JOIN event_ducks ed
         ON ed.duck_id = d.id AND ed.event_id = ? AND ed.released_at IS NULL
      WHERE d.id = ?
      LIMIT 1`,
  ).bind(eventId, duckId).first<IntakeResultRow>();

const intakeResponse = (row: IntakeResultRow, replayed: boolean): Response => json({
  duck: {
    id: row.duck_id,
    visibleNumber: row.visible_number,
    inventoryStatus: row.inventory_status,
    revision: row.revision,
    location: row.storage_location,
    notes: row.notes,
  },
  tag: { id: row.tag_id, status: "ACTIVE" },
  reservation: { id: row.event_duck_id },
  replayed,
}, replayed ? 200 : 201);

const intakeDuck = async (request: Request, env: Env, actor: StaffActor): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const visibleNumber = payload?.visibleNumber;
  const tagToken = payload?.tagToken;
  const location = cleanOptional(payload?.location ?? null, 100);
  const notes = cleanOptional(payload?.notes ?? null, 1000);
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || !validVisibleNumber(visibleNumber)
    || !validTagToken(tagToken)
    || location === undefined || notes === undefined
    || payload?.physicallyPresent !== true
  ) {
    return json({ error: "Command, event, physical-presence confirmation, duck number, and valid tag are required." }, 400);
  }

  const requestDetails = {
    visibleNumber,
    tagTokenHash: await hashValue(tagToken),
    location,
    notes,
    physicallyPresent: true,
  };
  const previous = await checkCommand(env, commandId, eventId, "REGISTER_RACE_DUCK", requestDetails);
  if (previous.kind === "conflict") {
    return json({ error: "This command identifier was already used for another operation." }, 409);
  }
  if (previous.kind === "replay" && previous.resultId !== null) {
    const result = await getIntakeResult(env, previous.resultId, eventId);
    return result === null
      ? json({ error: "The saved intake result is no longer available." }, 409)
      : intakeResponse(result, true);
  }

  // Intake stays open once racing starts. Deleting a duck mid-race hands its
  // participant back to the pairing queue, and a race with no spare duck in
  // inventory would otherwise have no way to finish.
  const event = await env.DB.prepare(
    `SELECT id FROM events WHERE id = ? AND status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')`,
  ).bind(eventId).first<{ id: string }>();
  if (event === null) return json({ error: "Duck intake is closed for this event." }, 409);

  const now = new Date().toISOString();
  const duckId = crypto.randomUUID();
  const tagId = crypto.randomUUID();
  const eventDuckId = crypto.randomUUID();
  const inventoryStatus = "RESERVED_FOR_EVENT";
  const details = { request: requestDetails, tag_id: tagId, event_duck_id: eventDuckId };
  const execution = await execute(env, [
    commandInsert(env, commandId, eventId, "REGISTER_RACE_DUCK", duckId, now, activeRaceStatuses),
    env.DB.prepare(
      `INSERT INTO ducks
         (id, visible_number, inventory_status, inventory_status_changed_at,
          physical_condition, storage_location, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'GOOD', ?, ?, ?, ?)`,
    ).bind(duckId, visibleNumber, inventoryStatus, now, location, notes, now, now),
    env.DB.prepare(
      `INSERT INTO duck_tags
        (id, duck_id, token, status, written_at, verified_at, activated_at, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)`,
    ).bind(tagId, duckId, tagToken, now, now, now, now, now),
    env.DB.prepare(
      `INSERT INTO event_ducks
        (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(eventDuckId, eventId, duckId, now, actor.id),
    inventoryEventInsert(env, eventId, duckId, "DUCK_INTAKE", actor.id, commandId, now, details),
    auditInsert(env, eventId, commandId, "DUCK_REGISTERED_FOR_EVENT", "DUCK", duckId, actor.id, now, {
      visible_number: visibleNumber,
      location,
    }),
  ], commandId, eventId, "REGISTER_RACE_DUCK", requestDetails, duckId);
  if (execution === null) {
    return json({ error: "Duck intake conflicted with another inventory update. Refresh and try again." }, 409);
  }
  if (execution.replayed) {
    const replay = await getIntakeResult(env, execution.resultId, eventId);
    return replay === null
      ? json({ error: "The saved intake result is no longer available." }, 409)
      : intakeResponse(replay, true);
  }
  return intakeResponse({
    duck_id: duckId,
    visible_number: visibleNumber,
    inventory_status: inventoryStatus,
    revision: 0,
    storage_location: location,
    notes,
    tag_id: tagId,
    event_duck_id: eventDuckId,
  }, false);
};

const provisioningStartCommand = "START_DUCK_PROVISIONING";
const provisioningConfirmCommand = "CONFIRM_DUCK_PROVISIONING";
const provisioningTakeoverCommand = "TAKE_OVER_DUCK_PROVISIONING";
const provisioningTakeoverDelayMs = 10 * 60 * 1000;

interface ProvisioningCommandRow {
  event_id: string;
  command_type: string;
  result_id: string | null;
  request_fingerprint: string | null;
}

interface ProvisioningRow {
  provisioning_command_id: string;
  event_id: string;
  duck_id: string;
  visible_number: number;
  inventory_status: string;
  physical_condition: PhysicalCondition;
  storage_location: string | null;
  tag_id: string;
  tag_token: string;
  tag_status: string;
  event_duck_id: string | null;
  owner_audit_id: string;
  owner_staff_profile_id: string;
  ownership_occurred_at: string;
}

const provisioningSelect = `
  SELECT rc.id AS provisioning_command_id, rc.event_id,
         d.id AS duck_id, d.visible_number, d.inventory_status,
         d.physical_condition, d.storage_location,
         dt.id AS tag_id, dt.token AS tag_token, dt.status AS tag_status,
         ed.id AS event_duck_id,
         owner_ae.id AS owner_audit_id,
         json_extract(owner_ae.details_json, '$.staff_profile_id') AS owner_staff_profile_id,
         owner_ae.occurred_at AS ownership_occurred_at
    FROM race_commands rc
    JOIN audit_events start_ae
      ON start_ae.command_id = rc.id
     AND start_ae.action = 'DUCK_PROVISIONING_STARTED'
     AND start_ae.subject_type = 'DUCK'
     AND start_ae.subject_id = rc.result_id
    JOIN ducks d ON d.id = rc.result_id
    JOIN duck_tags dt
      ON dt.duck_id = d.id
     AND dt.id = json_extract(start_ae.details_json, '$.tag_id')
    JOIN audit_events owner_ae ON owner_ae.id = (
      SELECT ownership_ae.id
        FROM audit_events ownership_ae
       WHERE ownership_ae.event_id = rc.event_id
         AND ownership_ae.subject_type = 'DUCK'
         AND ownership_ae.subject_id = d.id
         AND ownership_ae.action IN ('DUCK_PROVISIONING_STARTED', 'DUCK_PROVISIONING_TAKEN_OVER')
       ORDER BY ownership_ae.occurred_at DESC, ownership_ae.id DESC
       LIMIT 1
    )
    LEFT JOIN event_ducks ed
      ON ed.duck_id = d.id AND ed.event_id = rc.event_id AND ed.released_at IS NULL
   WHERE rc.command_type = '${provisioningStartCommand}'`;

const getProvisioningCommand = (
  env: Env,
  commandId: string,
): Promise<ProvisioningCommandRow | null> => env.DB.prepare(
  `SELECT event_id, command_type, result_id, request_fingerprint
     FROM race_commands
    WHERE id = ?`,
).bind(commandId).first<ProvisioningCommandRow>();

const getProvisioningByCommand = (
  env: Env,
  commandId: string,
  actorId: string,
): Promise<ProvisioningRow | null> => env.DB.prepare(
  `${provisioningSelect}
      AND rc.id = ?
      AND json_extract(owner_ae.details_json, '$.staff_profile_id') = ?
    LIMIT 1`,
).bind(commandId, actorId).first<ProvisioningRow>();

const getProvisioningTarget = (
  env: Env,
  commandId: string,
  duckId: string,
): Promise<ProvisioningRow | null> => env.DB.prepare(
  `${provisioningSelect}
      AND rc.id = ?
      AND d.id = ?
    LIMIT 1`,
).bind(commandId, duckId).first<ProvisioningRow>();

const getPendingProvisioning = (
  env: Env,
  eventId: string,
  actorId: string,
): Promise<ProvisioningRow | null> => env.DB.prepare(
  `${provisioningSelect}
      AND rc.event_id = ?
      AND json_extract(owner_ae.details_json, '$.staff_profile_id') = ?
      AND d.inventory_status = 'NEW'
      AND d.physical_condition = 'NEEDS_TAG'
      AND dt.status = 'RESERVED'
      AND ed.id IS NULL
    ORDER BY rc.requested_at, rc.id
    LIMIT 1`,
).bind(eventId, actorId).first<ProvisioningRow>();

const getTakeoverCandidate = (
  env: Env,
  eventId: string,
  actorId: string,
  takeoverBefore: string,
): Promise<ProvisioningRow | null> => env.DB.prepare(
  `${provisioningSelect}
      AND rc.event_id = ?
      AND json_extract(owner_ae.details_json, '$.staff_profile_id') != ?
      AND owner_ae.occurred_at <= ?
      AND d.inventory_status = 'NEW'
      AND d.physical_condition = 'NEEDS_TAG'
      AND dt.status = 'RESERVED'
      AND ed.id IS NULL
    ORDER BY owner_ae.occurred_at, rc.requested_at, rc.id
    LIMIT 1`,
).bind(eventId, actorId, takeoverBefore).first<ProvisioningRow>();

const provisioningFingerprint = (
  commandType: string,
  actorId: string,
  eventId: string,
  details: Record<string, unknown>,
): Promise<string> => hashValue(JSON.stringify({ commandType, actorId, eventId, ...details }));

const generateTagToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const provisioningResponse = (
  env: Env,
  row: ProvisioningRow,
  replayed: boolean,
  status = 200,
): Response => {
  const pending = row.inventory_status === "NEW"
    && row.physical_condition === "NEEDS_TAG"
    && row.tag_status === "RESERVED"
    && row.event_duck_id === null;
  return json({
    provisioningCommandId: row.provisioning_command_id,
    duckId: row.duck_id,
    visibleNumber: row.visible_number,
    status: pending ? "PENDING_WRITE" : "CONFIRMED",
    ...(pending ? { tagUrl: new URL(`/t/${row.tag_token}`, env.APP_ORIGIN).toString() } : {}),
    replayed,
  }, status);
};

const isPendingProvisioning = (row: ProvisioningRow): boolean =>
  row.inventory_status === "NEW"
  && row.physical_condition === "NEEDS_TAG"
  && row.tag_status === "RESERVED"
  && row.event_duck_id === null;

const parseProvisioningLocation = (payload: Record<string, unknown>): string | null | undefined => {
  if (!Object.hasOwn(payload, "location") || payload.location === null) return null;
  if (typeof payload.location !== "string") return undefined;
  const location = payload.location.trim().replace(/\s+/g, " ");
  if (location.length === 0) return null;
  return location.length <= 100 ? location : undefined;
};

const recoverProvisioning = async (
  url: URL,
  env: Env,
  actor: StaffActor,
): Promise<Response> => {
  const eventId = url.searchParams.get("eventId");
  if (eventId === null || !validEventId(eventId)) {
    return json({ error: "A valid event is required." }, 400);
  }
  const pending = await getPendingProvisioning(env, eventId, actor.id);
  if (pending !== null) {
    return json({
      provisioning: {
        provisioningCommandId: pending.provisioning_command_id,
        duckId: pending.duck_id,
        visibleNumber: pending.visible_number,
        tagUrl: new URL(`/t/${pending.tag_token}`, env.APP_ORIGIN).toString(),
        status: "PENDING_WRITE",
      },
    });
  }
  if (!actor.isSystemAdmin && !actor.roles.includes("RACE_DIRECTOR")) {
    return json({ provisioning: null });
  }
  const takeoverBefore = new Date(Date.now() - provisioningTakeoverDelayMs).toISOString();
  const candidate = await getTakeoverCandidate(env, eventId, actor.id, takeoverBefore);
  return candidate === null ? json({ provisioning: null }) : json({
    provisioning: {
      provisioningCommandId: candidate.provisioning_command_id,
      duckId: candidate.duck_id,
      visibleNumber: candidate.visible_number,
      status: "PENDING_WRITE",
      takeoverAvailable: true,
    },
  });
};

const takeoverProvisioning = async (
  request: Request,
  env: Env,
  actor: StaffActor,
): Promise<Response> => {
  const denied = requireAnyRole(actor, ["RACE_DIRECTOR"]);
  if (denied !== null) return denied;
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const duckId = payload?.duckId;
  const startCommandId = payload?.provisioningCommandId;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || typeof duckId !== "string" || !validEntityId(duckId)
    || typeof startCommandId !== "string" || !isCommandId(startCommandId)
  ) {
    return json({ error: "Command, event, target duck, and provisioning command are required." }, 400);
  }

  const requestDetails = { duckId, provisioningCommandId: startCommandId };
  const fingerprint = await provisioningFingerprint(
    provisioningTakeoverCommand,
    actor.id,
    eventId,
    requestDetails,
  );
  const previous = await getProvisioningCommand(env, commandId);
  if (previous !== null) {
    if (
      previous.event_id !== eventId
      || previous.command_type !== provisioningTakeoverCommand
      || previous.result_id !== duckId
      || previous.request_fingerprint !== fingerprint
    ) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getProvisioningByCommand(env, startCommandId, actor.id);
    return replay === null
      ? json({ error: "This provisioning takeover no longer belongs to this operator." }, 409)
      : provisioningResponse(env, replay, true);
  }

  const provisioning = await getProvisioningTarget(env, startCommandId, duckId);
  if (provisioning === null || provisioning.event_id !== eventId) {
    return json({ error: "Pending provisioning was not found for this event." }, 404);
  }
  if (!isPendingProvisioning(provisioning)) {
    return json({ error: "This provisioning is not waiting for NFC confirmation." }, 409);
  }
  if (provisioning.owner_staff_profile_id === actor.id) {
    return json({ error: "This provisioning already belongs to this operator." }, 409);
  }
  const takeoverBefore = new Date(Date.now() - provisioningTakeoverDelayMs).toISOString();
  if (provisioning.ownership_occurred_at > takeoverBefore) {
    return json({ error: "Provisioning can be taken over only after it has been pending for 10 minutes." }, 409);
  }

  const now = new Date().toISOString();
  const auditDetails = JSON.stringify({
    staff_profile_id: actor.id,
    prior_staff_profile_id: provisioning.owner_staff_profile_id,
    new_staff_profile_id: actor.id,
    provisioning_command_id: startCommandId,
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
         SELECT ?, e.id, '${provisioningTakeoverCommand}', d.id, ?, ?, ?
           FROM events e
           JOIN race_commands start_rc
             ON start_rc.id = ? AND start_rc.event_id = e.id
            AND start_rc.command_type = '${provisioningStartCommand}'
           JOIN audit_events start_ae
             ON start_ae.command_id = start_rc.id
            AND start_ae.action = 'DUCK_PROVISIONING_STARTED'
            AND start_ae.subject_type = 'DUCK'
            AND start_ae.subject_id = start_rc.result_id
           JOIN ducks d ON d.id = start_rc.result_id
           JOIN duck_tags dt
             ON dt.duck_id = d.id
            AND dt.id = json_extract(start_ae.details_json, '$.tag_id')
           JOIN audit_events owner_ae ON owner_ae.id = ?
          WHERE e.id = ?
            AND e.status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')
            AND d.id = ?
            AND d.inventory_status = 'NEW'
            AND d.physical_condition = 'NEEDS_TAG'
            AND dt.status = 'RESERVED'
            AND owner_ae.event_id = e.id
            AND owner_ae.subject_type = 'DUCK'
            AND owner_ae.subject_id = d.id
            AND owner_ae.action IN ('DUCK_PROVISIONING_STARTED', 'DUCK_PROVISIONING_TAKEN_OVER')
            AND json_extract(owner_ae.details_json, '$.staff_profile_id') = ?
            AND owner_ae.occurred_at <= ?
            AND owner_ae.id = (
              SELECT latest_owner.id
                FROM audit_events latest_owner
               WHERE latest_owner.event_id = e.id
                 AND latest_owner.subject_type = 'DUCK'
                 AND latest_owner.subject_id = d.id
                 AND latest_owner.action IN ('DUCK_PROVISIONING_STARTED', 'DUCK_PROVISIONING_TAKEN_OVER')
               ORDER BY latest_owner.occurred_at DESC, latest_owner.id DESC
               LIMIT 1
            )
            AND NOT EXISTS (
              SELECT 1 FROM event_ducks ed WHERE ed.duck_id = d.id AND ed.released_at IS NULL
            )`,
      ).bind(
        commandId,
        now,
        now,
        fingerprint,
        startCommandId,
        provisioning.owner_audit_id,
        eventId,
        duckId,
        provisioning.owner_staff_profile_id,
        takeoverBefore,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'DUCK_PROVISIONING_TAKEN_OVER', 'DUCK', ?, 'STAFF', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM race_commands
             WHERE id = ? AND event_id = ?
               AND command_type = '${provisioningTakeoverCommand}' AND result_id = ?
          )`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        commandId,
        duckId,
        now,
        auditDetails,
        commandId,
        eventId,
        duckId,
      ),
    ]);
  } catch {
    const racedCommand = await getProvisioningCommand(env, commandId);
    if (
      racedCommand !== null
      && racedCommand.event_id === eventId
      && racedCommand.command_type === provisioningTakeoverCommand
      && racedCommand.result_id === duckId
      && racedCommand.request_fingerprint === fingerprint
    ) {
      const replay = await getProvisioningByCommand(env, startCommandId, actor.id);
      if (replay !== null) return provisioningResponse(env, replay, true);
    }
    return json({ error: "Provisioning takeover conflicted with another operator. Refresh before trying again." }, 409);
  }

  const committed = await getProvisioningCommand(env, commandId);
  const recovered = await getProvisioningByCommand(env, startCommandId, actor.id);
  return committed !== null
    && committed.event_id === eventId
    && committed.command_type === provisioningTakeoverCommand
    && committed.result_id === duckId
    && committed.request_fingerprint === fingerprint
    && recovered !== null
    ? provisioningResponse(env, recovered, false, 201)
    : json({ error: "Provisioning takeover conflicted with another operator. Refresh before trying again." }, 409);
};

const startProvisioning = async (
  request: Request,
  env: Env,
  actor: StaffActor,
): Promise<Response> => {
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON provisioning request is required." }, 400);
  const commandId = payload.commandId;
  const eventId = payload.eventId;
  const location = parseProvisioningLocation(payload);
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || location === undefined
  ) {
    return json({ error: "Command, event, and an optional location of at most 100 characters are required." }, 400);
  }

  const fingerprint = await provisioningFingerprint(
    provisioningStartCommand,
    actor.id,
    eventId,
    { location },
  );
  const previous = await getProvisioningCommand(env, commandId);
  if (previous !== null) {
    if (
      previous.event_id !== eventId
      || previous.command_type !== provisioningStartCommand
      || previous.request_fingerprint !== fingerprint
    ) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getProvisioningByCommand(env, commandId, actor.id);
    return replay === null
      ? json({ error: "The saved provisioning result is no longer available." }, 409)
      : provisioningResponse(env, replay, true);
  }

  const recovered = await getPendingProvisioning(env, eventId, actor.id);
  if (recovered !== null) return provisioningResponse(env, recovered, true);

  const event = await env.DB.prepare(
    `SELECT id FROM events
      WHERE id = ? AND status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')`,
  ).bind(eventId).first<{ id: string }>();
  if (event === null) return json({ error: "Duck provisioning is closed for this event." }, 409);

  const now = new Date().toISOString();
  const duckId = crypto.randomUUID();
  const tagId = crypto.randomUUID();
  const token = generateTagToken();
  const auditDetails = JSON.stringify({ staff_profile_id: actor.id, tag_id: tagId });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
         SELECT ?, e.id, '${provisioningStartCommand}', ?, ?, ?, ?
           FROM events e
          WHERE e.id = ?
            AND e.status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')
            AND COALESCE((SELECT MAX(visible_number) FROM ducks), 0) < 999999999
            AND NOT EXISTS (
              SELECT 1
                FROM race_commands pending_rc
                JOIN audit_events pending_ae
                  ON pending_ae.command_id = pending_rc.id
                 AND pending_ae.action = 'DUCK_PROVISIONING_STARTED'
                JOIN ducks pending_d ON pending_d.id = pending_rc.result_id
                JOIN duck_tags pending_dt
                  ON pending_dt.duck_id = pending_d.id AND pending_dt.status = 'RESERVED'
               WHERE pending_rc.event_id = e.id
                  AND pending_rc.command_type = '${provisioningStartCommand}'
                  AND json_extract((
                    SELECT current_owner.details_json
                      FROM audit_events current_owner
                     WHERE current_owner.event_id = pending_rc.event_id
                       AND current_owner.subject_type = 'DUCK'
                       AND current_owner.subject_id = pending_d.id
                       AND current_owner.action IN ('DUCK_PROVISIONING_STARTED', 'DUCK_PROVISIONING_TAKEN_OVER')
                     ORDER BY current_owner.occurred_at DESC, current_owner.id DESC
                     LIMIT 1
                  ), '$.staff_profile_id') = ?
                  AND pending_d.inventory_status = 'NEW'
                  AND pending_d.physical_condition = 'NEEDS_TAG'
                 AND NOT EXISTS (
                   SELECT 1 FROM event_ducks pending_ed
                    WHERE pending_ed.duck_id = pending_d.id AND pending_ed.released_at IS NULL
                 )
            )`,
      ).bind(commandId, duckId, now, now, fingerprint, eventId, actor.id),
      env.DB.prepare(
        `INSERT INTO ducks
          (id, visible_number, inventory_status, inventory_status_changed_at,
           physical_condition, storage_location, created_at, updated_at)
         SELECT ?, (SELECT COALESCE(MAX(visible_number), 0) + 1 FROM ducks),
                'NEW', ?, 'NEEDS_TAG', ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM race_commands
             WHERE id = ? AND command_type = '${provisioningStartCommand}' AND result_id = ?
          )`,
      ).bind(duckId, now, location, now, now, commandId, duckId),
      env.DB.prepare(
        `INSERT INTO duck_tags
          (id, duck_id, token, status, created_at, updated_at)
         SELECT ?, ?, ?, 'RESERVED', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM race_commands
             WHERE id = ? AND command_type = '${provisioningStartCommand}' AND result_id = ?
          )`,
      ).bind(tagId, duckId, token, now, now, commandId, duckId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'DUCK_PROVISIONING_STARTED', 'DUCK', ?, 'STAFF', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM race_commands
             WHERE id = ? AND command_type = '${provisioningStartCommand}' AND result_id = ?
          )`,
      ).bind(crypto.randomUUID(), eventId, commandId, duckId, now, auditDetails, commandId, duckId),
    ]);
  } catch {
    const racedCommand = await getProvisioningCommand(env, commandId);
    if (
      racedCommand !== null
      && racedCommand.event_id === eventId
      && racedCommand.command_type === provisioningStartCommand
      && racedCommand.request_fingerprint === fingerprint
    ) {
      const replay = await getProvisioningByCommand(env, commandId, actor.id);
      if (replay !== null) return provisioningResponse(env, replay, true);
    }
    const racedPending = await getPendingProvisioning(env, eventId, actor.id);
    if (racedPending !== null) return provisioningResponse(env, racedPending, true);
    return json({ error: "Duck provisioning conflicted with another inventory update. Retap the same sticker." }, 409);
  }

  const created = await getProvisioningByCommand(env, commandId, actor.id);
  if (created !== null) return provisioningResponse(env, created, false, 201);
  const concurrent = await getPendingProvisioning(env, eventId, actor.id);
  return concurrent === null
    ? json({ error: "Duck provisioning could not reserve a pending tag." }, 409)
    : provisioningResponse(env, concurrent, true);
};

interface ProvisioningTagRow {
  duck_id: string;
  tag_status: string;
  inventory_status: string;
  provisioning_command_id: string | null;
  provisioning_event_id: string | null;
  provisioning_owner_id: string | null;
}

const classifyProvisioningTag = async (
  request: Request,
  env: Env,
  actor: StaffActor,
): Promise<Response> => {
  const payload = await readJson(request);
  const eventId = payload?.eventId;
  const token = canonicalTagToken(payload?.tagUrl, env.APP_ORIGIN);
  if (!validEventId(eventId) || token === null) {
    return json({ error: "A valid event and canonical QuickDucks tag URL are required." }, 400);
  }
  const tag = await env.DB.prepare(
    `SELECT d.id AS duck_id, d.inventory_status, dt.status AS tag_status,
             rc.id AS provisioning_command_id,
             rc.event_id AS provisioning_event_id,
             json_extract((
               SELECT owner_ae.details_json
                 FROM audit_events owner_ae
                WHERE owner_ae.event_id = rc.event_id
                  AND owner_ae.subject_type = 'DUCK'
                  AND owner_ae.subject_id = d.id
                  AND owner_ae.action IN ('DUCK_PROVISIONING_STARTED', 'DUCK_PROVISIONING_TAKEN_OVER')
                ORDER BY owner_ae.occurred_at DESC, owner_ae.id DESC
                LIMIT 1
             ), '$.staff_profile_id') AS provisioning_owner_id
         FROM duck_tags dt
        JOIN ducks d ON d.id = dt.duck_id
        LEFT JOIN race_commands rc
          ON rc.result_id = d.id AND rc.command_type = '${provisioningStartCommand}'
       WHERE dt.token = ?
      ORDER BY CASE dt.status WHEN 'ACTIVE' THEN 0 WHEN 'RESERVED' THEN 1 ELSE 2 END
      LIMIT 1`,
  ).bind(token).first<ProvisioningTagRow>();
  if (tag === null) {
    return json({ kind: "reusable" });
  }
  if (
    tag.tag_status === "RESERVED"
    && tag.inventory_status === "NEW"
    && tag.provisioning_event_id === eventId
    && tag.provisioning_owner_id === actor.id
    && tag.provisioning_command_id !== null
  ) {
    return json({ kind: "pending", duckId: tag.duck_id, provisioningCommandId: tag.provisioning_command_id });
  }
  // The duck identifier travels with an already-registered verdict so the
  // station can open that duck's record instead of only refusing to overwrite
  // it. It is an internal identifier behind the same inventory roles as the
  // rest of this module, and it names a duck rather than a person.
  return json({ kind: "already", duckId: tag.duck_id });
};

const confirmProvisioning = async (
  request: Request,
  env: Env,
  actor: StaffActor,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const duckId = payload?.duckId;
  const startCommandId = payload?.provisioningCommandId;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || typeof duckId !== "string" || !validEntityId(duckId)
    || typeof startCommandId !== "string" || !isCommandId(startCommandId)
    || payload?.physicalWriteVerified !== true
  ) {
    return json({ error: "Command, event, pending provisioning, duck, and successful physical write are required." }, 400);
  }
  const requestDetails = { duckId, provisioningCommandId: startCommandId, physicalWriteVerified: true };
  const fingerprint = await provisioningFingerprint(
    provisioningConfirmCommand,
    actor.id,
    eventId,
    requestDetails,
  );
  const previous = await getProvisioningCommand(env, commandId);
  if (previous !== null) {
    if (
      previous.event_id !== eventId
      || previous.command_type !== provisioningConfirmCommand
      || previous.result_id !== duckId
      || previous.request_fingerprint !== fingerprint
    ) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getIntakeResult(env, duckId, eventId);
    return replay === null
      ? json({ error: "The saved provisioning confirmation is no longer available." }, 409)
      : intakeResponse(replay, true);
  }

  const provisioning = await getProvisioningByCommand(env, startCommandId, actor.id);
  if (provisioning === null || provisioning.event_id !== eventId || provisioning.duck_id !== duckId) {
    return json({ error: "Pending provisioning was not found for this operator and event." }, 404);
  }
  if (provisioning.event_duck_id !== null) {
    const already = await getIntakeResult(env, duckId, eventId);
    return already === null
      ? json({ error: "The confirmed provisioning result is unavailable." }, 409)
      : intakeResponse(already, true);
  }
  if (
    provisioning.inventory_status !== "NEW"
    || provisioning.physical_condition !== "NEEDS_TAG"
    || provisioning.tag_status !== "RESERVED"
    || provisioning.event_duck_id !== null
  ) {
    return json({ error: "This provisioning is not waiting for NFC confirmation." }, 409);
  }

  const event = await env.DB.prepare(
    `SELECT id FROM events
      WHERE id = ? AND status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')`,
  ).bind(eventId).first<{ id: string }>();
  if (event === null) return json({ error: "Duck provisioning confirmation is closed for this event." }, 409);

  const now = new Date().toISOString();
  const eventDuckId = crypto.randomUUID();
  const details = JSON.stringify({ request: requestDetails, tag_id: provisioning.tag_id, event_duck_id: eventDuckId });
  const auditDetails = JSON.stringify({
    staff_profile_id: actor.id,
    provisioning_command_id: startCommandId,
    tag_id: provisioning.tag_id,
    event_duck_id: eventDuckId,
  });
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
         SELECT ?, e.id, '${provisioningConfirmCommand}', d.id, ?, ?, ?
           FROM events e
           JOIN race_commands start_rc
             ON start_rc.id = ? AND start_rc.event_id = e.id
            AND start_rc.command_type = '${provisioningStartCommand}'
           JOIN audit_events start_ae
              ON start_ae.command_id = start_rc.id
             AND start_ae.action = 'DUCK_PROVISIONING_STARTED'
           JOIN ducks d ON d.id = start_rc.result_id
           JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'RESERVED'
          WHERE e.id = ?
            AND e.status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')
             AND d.id = ?
             AND d.inventory_status = 'NEW'
             AND d.physical_condition = 'NEEDS_TAG'
             AND json_extract((
               SELECT current_owner.details_json
                 FROM audit_events current_owner
                WHERE current_owner.event_id = e.id
                  AND current_owner.subject_type = 'DUCK'
                  AND current_owner.subject_id = d.id
                  AND current_owner.action IN ('DUCK_PROVISIONING_STARTED', 'DUCK_PROVISIONING_TAKEN_OVER')
                ORDER BY current_owner.occurred_at DESC, current_owner.id DESC
                LIMIT 1
             ), '$.staff_profile_id') = ?
             AND NOT EXISTS (
              SELECT 1 FROM event_ducks ed WHERE ed.duck_id = d.id AND ed.released_at IS NULL
            )`,
      ).bind(commandId, now, now, fingerprint, startCommandId, eventId, duckId, actor.id),
      env.DB.prepare(
        `UPDATE ducks
            SET inventory_status = 'RESERVED_FOR_EVENT', inventory_status_changed_at = ?,
                physical_condition = 'GOOD', updated_at = ?, revision = revision + 1
          WHERE id = ? AND inventory_status = 'NEW' AND physical_condition = 'NEEDS_TAG'
            AND EXISTS (
              SELECT 1 FROM race_commands
               WHERE id = ? AND command_type = '${provisioningConfirmCommand}' AND result_id = ?
            )`,
      ).bind(now, now, duckId, commandId, duckId),
      env.DB.prepare(
        `UPDATE duck_tags
            SET status = 'ACTIVE', written_at = ?, verified_at = ?, activated_at = ?, updated_at = ?
          WHERE id = ? AND duck_id = ? AND status = 'RESERVED'
            AND EXISTS (
              SELECT 1 FROM race_commands
               WHERE id = ? AND command_type = '${provisioningConfirmCommand}' AND result_id = ?
            )`,
      ).bind(now, now, now, now, provisioning.tag_id, duckId, commandId, duckId),
      env.DB.prepare(
        `INSERT INTO event_ducks
          (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
         SELECT ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM race_commands
             WHERE id = ? AND command_type = '${provisioningConfirmCommand}' AND result_id = ?
          )`,
      ).bind(eventDuckId, eventId, duckId, now, actor.id, commandId, duckId),
      env.DB.prepare(
        `INSERT INTO duck_inventory_events
          (id, event_id, duck_id, action, actor_staff_profile_id,
           source_command_id, occurred_at, details_json)
         SELECT ?, ?, ?, 'DUCK_INTAKE', ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM race_commands
             WHERE id = ? AND command_type = '${provisioningConfirmCommand}' AND result_id = ?
          )`,
      ).bind(crypto.randomUUID(), eventId, duckId, actor.id, commandId, now, details, commandId, duckId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'DUCK_PROVISIONED_FOR_EVENT', 'DUCK', ?, 'STAFF', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM race_commands
             WHERE id = ? AND command_type = '${provisioningConfirmCommand}' AND result_id = ?
          )`,
      ).bind(crypto.randomUUID(), eventId, commandId, duckId, now, auditDetails, commandId, duckId),
    ]);
  } catch {
    const racedCommand = await getProvisioningCommand(env, commandId);
    if (
      racedCommand !== null
      && racedCommand.event_id === eventId
      && racedCommand.command_type === provisioningConfirmCommand
      && racedCommand.result_id === duckId
      && racedCommand.request_fingerprint === fingerprint
    ) {
      const replay = await getIntakeResult(env, duckId, eventId);
      if (replay !== null) return intakeResponse(replay, true);
    }
    const concurrentlyConfirmed = await getIntakeResult(env, duckId, eventId);
    if (concurrentlyConfirmed !== null) return intakeResponse(concurrentlyConfirmed, true);
    return json({ error: "Provisioning confirmation conflicted with another update. Retap the same sticker." }, 409);
  }

  const committedCommand = await getProvisioningCommand(env, commandId);
  const confirmed = await getIntakeResult(env, duckId, eventId);
  if (
    confirmed !== null
    && committedCommand !== null
    && committedCommand.event_id === eventId
    && committedCommand.command_type === provisioningConfirmCommand
    && committedCommand.result_id === duckId
    && committedCommand.request_fingerprint === fingerprint
  ) {
    return intakeResponse(confirmed, false);
  }
  return confirmed === null
    ? json({ error: "Provisioning confirmation did not complete. Retap the same sticker." }, 409)
    : intakeResponse(confirmed, true);
};

const getLabelData = async (env: Env, duckId: string): Promise<Response> => {
  const label = await env.DB.prepare(
    `SELECT d.visible_number, dt.token
       FROM ducks d
       JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'ACTIVE'
      WHERE d.id = ?
      LIMIT 1`,
  ).bind(duckId).first<{ visible_number: number; token: string }>();
  if (label === null) return json({ error: "Duck has no active label tag." }, 404);
  const tagUrl = new URL(`/t/${label.token}`, env.APP_ORIGIN).toString();
  return json({ visibleNumber: label.visible_number, tagUrl });
};

// ---------------------------------------------------------------------------
// Delete duck
//
// The one way a duck leaves inventory. It replaces the retired tag-replacement
// and tag-retirement commands, which asked staff to reason about tag states
// that only ever meant "this duck is out of the race".
//
// A participant is never deleted with their duck. A heat entry names the race
// entry, not the assignment, and the duck a racer is holding is resolved
// through the currently open assignment, so closing that assignment leaves the
// participant exactly where they were in their heat with no duck. Staff then
// pair them with another duck through the normal flow, and `transitionHeat`
// refuses to start a heat while anyone on its roster is holding nothing.
//
// Rows are removed outright when nothing published depends on them. A duck that
// has a finalized result cannot be erased without making that result untrue, so
// it keeps its rows and leaves inventory as RETIRED instead. Both paths look
// the same to the actor and both end with the duck gone from every list.
// ---------------------------------------------------------------------------
interface DeletableDuckRow {
  duck_id: string;
  visible_number: number;
  revision: number;
  event_duck_id: string | null;
  event_duck_event_id: string | null;
  event_status: string | null;
  active_assignment_id: string | null;
  race_entry_id: string | null;
  registration_id: string | null;
  published_result_count: number;
  in_flight_heat_id: string | null;
}

// Deleting a duck has no inventory-event row to compare a replay against — the
// erased path removes the table those rows live in — so the command row itself
// is the idempotency record.
const findRaceCommand = (env: Env, commandId: string): Promise<ExistingCommand | null> =>
  env.DB.prepare(
    "SELECT event_id, command_type, result_id FROM race_commands WHERE id = ?",
  ).bind(commandId).first<ExistingCommand>();

// `published_result_count` counts both the live result rows and every superseded
// revision of them. `heat_result_history` carries a `duck_assignment_id` with no
// foreign key of its own, so erasing a corrected duck would leave that history
// pointing at nothing and `PRAGMA foreign_key_check` would never notice.
const getDeletableDuck = (env: Env, duckId: string): Promise<DeletableDuckRow | null> =>
  env.DB.prepare(
    `SELECT d.id AS duck_id, d.visible_number, d.revision,
            ed.id AS event_duck_id, ed.event_id AS event_duck_event_id,
            e.status AS event_status,
            da.id AS active_assignment_id, da.race_entry_id,
            re.registration_id,
            (
              (SELECT COUNT(*)
                 FROM heat_results hr
                 JOIN duck_assignments hda ON hda.id = hr.duck_assignment_id
                WHERE hda.duck_id = d.id)
              + (SELECT COUNT(*)
                   FROM heat_result_history hh
                   JOIN duck_assignments hda ON hda.id = hh.duck_assignment_id
                  WHERE hda.duck_id = d.id)
            ) AS published_result_count,
            (
              SELECT h.id
                FROM heat_entries he
                JOIN heats h ON h.id = he.heat_id
               WHERE he.race_entry_id = da.race_entry_id
                 AND h.status IN ('RUNNING', 'AWAITING_RESULT')
               LIMIT 1
            ) AS in_flight_heat_id
       FROM ducks d
       LEFT JOIN event_ducks ed ON ed.id = (
         SELECT ed2.id FROM event_ducks ed2
          WHERE ed2.duck_id = d.id AND ed2.released_at IS NULL
          LIMIT 1
       )
       LEFT JOIN events e ON e.id = ed.event_id
       LEFT JOIN duck_assignments da ON da.duck_id = d.id AND da.valid_to IS NULL
       LEFT JOIN race_entries re ON re.id = da.race_entry_id
      WHERE d.id = ?
      LIMIT 1`,
  ).bind(duckId).first<DeletableDuckRow>();

const deleteDuck = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  duckId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const expectedRevision = payload?.expectedRevision;
  const reason = typeof payload?.reason === "string" ? payload.reason.trim().replace(/\s+/g, " ") : "";
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || !validRevision(expectedRevision)
    || reason.length < 4 || reason.length > 500
  ) {
    return json({ error: "Command, event, expected revision, and a reason are required." }, 400);
  }

  const previous = await findRaceCommand(env, commandId);
  if (previous !== null) {
    if (
      previous.event_id !== eventId
      || previous.command_type !== "DELETE_DUCK"
      || previous.result_id !== duckId
    ) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    return json({ duckId, deleted: true, replayed: true });
  }

  const context = await getDeletableDuck(env, duckId);
  if (context === null) return json({ error: "Duck not found." }, 404);
  if (context.revision !== expectedRevision) {
    return json({ error: "Duck inventory changed. Refresh and try again.", revision: context.revision }, 409);
  }
  // The command row is scoped to the event that owns the audit trail. A duck
  // held for a different event is not this event's to delete.
  if (context.event_duck_event_id !== null && context.event_duck_event_id !== eventId) {
    return json({ error: "This duck is reserved for another event." }, 409);
  }
  if (
    context.event_status !== null
    && !activeRaceStatuses.includes(context.event_status as typeof activeRaceStatuses[number])
  ) {
    return json({ error: "This event is finished. Its ducks and results can no longer be changed." }, 409);
  }
  // The one window deleting a duck is genuinely unsafe: the racer's heat has
  // been raced and its result is not published yet. Publishing needs an ACTIVE
  // participant holding an open assignment, so unpairing there would make that
  // result unpublishable and stall every heat waiting behind it.
  //
  // Everything either side is fine. Before the heat runs — including while it is
  // being called, which is when a duck usually breaks — the heat simply refuses
  // to start until the racer holds a duck again. After the result is published,
  // a finalist who lost their duck just needs another one.
  if (context.in_flight_heat_id !== null) {
    return json({
      error: "This racer's heat has been run. Publish its official result, then delete the duck.",
    }, 409);
  }

  const now = new Date().toISOString();
  const erasable = context.published_result_count === 0;
  // Every statement below the command insert is conditional on that insert
  // having landed. The deletes here are irreversible and span four tables, so
  // the batch, not the preflight, is what has to decide: if the duck was paired,
  // named, or moved between the read above and this write, the command row is
  // never written and nothing else in the batch does anything either.
  const committed = "AND EXISTS (SELECT 1 FROM race_commands rc WHERE rc.id = ? "
    + "AND rc.event_id = ? AND rc.command_type = 'DELETE_DUCK' AND rc.result_id = ?)";
  const commit = [commandId, eventId, duckId];
  const statements: D1PreparedStatement[] = [
    // Guarded on the revision the actor saw and on the event still being one
    // where inventory can change at all.
    env.DB.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at)
       SELECT ?, ?, 'DELETE_DUCK', ?, ?, ?
         FROM events e
         JOIN ducks d ON d.id = ?
        WHERE e.id = ? AND d.revision = ?
          AND e.status IN (${activeRaceStatuses.map(() => "?").join(", ")})
          AND NOT EXISTS (
            SELECT 1
              FROM duck_assignments da
              JOIN heat_entries he ON he.race_entry_id = da.race_entry_id
              JOIN heats h ON h.id = he.heat_id
             WHERE da.duck_id = d.id AND da.valid_to IS NULL
               AND h.status IN ('RUNNING', 'AWAITING_RESULT')
          )`,
    ).bind(
      commandId, eventId, duckId, now, now, duckId, eventId, expectedRevision,
      ...activeRaceStatuses,
    ),
    // Audit first: it is the only record that survives an erased duck, and it
    // carries identifiers and the staff reason, never participant details.
    auditInsert(env, eventId, commandId, "DUCK_DELETED", "DUCK", duckId, actor.id, now, {
      visible_number: context.visible_number,
      erased: erasable,
      unpaired_race_entry_id: context.race_entry_id,
      reason,
    }),
  ];

  if (context.active_assignment_id !== null) {
    statements.push(
      env.DB.prepare(
        `UPDATE duck_assignments
            SET valid_to = ?, end_reason = 'DUCK_DELETED', ended_by_staff_profile_id = ?
          WHERE id = ? AND valid_to IS NULL ${committed}`,
      ).bind(now, actor.id, context.active_assignment_id, ...commit),
      // Back to SUBMITTED is exactly where a participant sits before pairing,
      // which is what puts them back in the queue on every staff and public
      // surface without a status of their own.
      env.DB.prepare(
        `UPDATE registrations
            SET status = 'SUBMITTED', status_changed_at = ?, updated_at = ?, revision = revision + 1
          WHERE id = ? AND status = 'ACTIVE' ${committed}`,
      ).bind(now, now, context.registration_id, ...commit),
      // The duck is going; a name that described it goes with it.
      env.DB.prepare(
        `UPDATE race_entries SET duck_name = NULL, updated_at = ? WHERE id = ? ${committed}`,
      ).bind(now, context.race_entry_id, ...commit),
    );
  }

  if (erasable) {
    statements.push(
      // `supersedes_tag_id` is a self-referencing restricted foreign key, so a
      // multi-row tag delete can hit a retired parent while its replacement
      // still points at it. Clearing it first is what makes the delete
      // survivable; this is the bug that once made force delete permanently
      // fail for any race where a tag had been replaced. It clears every row
      // pointing into this duck's tags, not only this duck's own rows.
      env.DB.prepare(
        `UPDATE duck_tags SET supersedes_tag_id = NULL
          WHERE supersedes_tag_id IN (SELECT id FROM duck_tags WHERE duck_id = ?) ${committed}`,
      ).bind(duckId, ...commit),
      env.DB.prepare(`DELETE FROM duck_tags WHERE duck_id = ? ${committed}`).bind(duckId, ...commit),
      env.DB.prepare(`DELETE FROM duck_assignments WHERE duck_id = ? ${committed}`).bind(duckId, ...commit),
      env.DB.prepare(`DELETE FROM event_ducks WHERE duck_id = ? ${committed}`).bind(duckId, ...commit),
      // `duck_inventory_events` cascades with the duck, so its history goes
      // with it and the audit row above is what remains.
      env.DB.prepare(
        `DELETE FROM ducks WHERE id = ? AND revision = ? ${committed}`,
      ).bind(duckId, expectedRevision, ...commit),
    );
  } else {
    statements.push(
      env.DB.prepare(
        `UPDATE duck_tags SET status = 'RETIRED', retired_at = ?, updated_at = ?
          WHERE duck_id = ? AND status = 'ACTIVE' ${committed}`,
      ).bind(now, now, duckId, ...commit),
      env.DB.prepare(
        `UPDATE event_ducks
            SET released_at = ?, release_reason = 'DUCK_DELETED', released_by_staff_profile_id = ?
          WHERE duck_id = ? AND released_at IS NULL ${committed}`,
      ).bind(now, actor.id, duckId, ...commit),
      env.DB.prepare(
        `UPDATE ducks
            SET inventory_status = 'RETIRED', inventory_status_changed_at = ?,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ? ${committed}`,
      ).bind(now, now, duckId, expectedRevision, ...commit),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: "Deleting this duck conflicted with another update. Refresh and try again." }, 409);
  }
  const saved = await findRaceCommand(env, commandId);
  return saved === null || saved.command_type !== "DELETE_DUCK"
    ? json({ error: "Deleting this duck conflicted with another update. Refresh and try again." }, 409)
    : json({
      duckId,
      deleted: true,
      erased: erasable,
      unpairedRaceEntryId: context.race_entry_id,
      replayed: false,
    }, 201);
};

interface AssignmentContextRow {
  duck_id: string;
  visible_number: number;
  duck_revision: number;
  inventory_status: string;
  physical_condition: PhysicalCondition;
  event_duck_id: string | null;
  event_duck_event_id: string | null;
  active_assignment_id: string | null;
  tag_id: string | null;
}

interface RaceEntryContextRow {
  race_entry_id: string;
  registration_id: string;
  registration_status: string;
  first_name: string;
  last_name: string;
  old_assignment_id: string | null;
  old_duck_id: string | null;
  old_duck_revision: number | null;
  old_event_duck_id: string | null;
  blocking_heat_id: string | null;
}

const assignDuck = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  duckId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const raceEntryId = payload?.raceEntryId;
  const expectedRevision = payload?.expectedRevision;
  const reason = typeof payload?.reason === "string" ? payload.reason.trim().replace(/\s+/g, " ") : "";
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || typeof raceEntryId !== "string" || !validEntityId(raceEntryId)
    || !validRevision(expectedRevision) || reason.length < 4 || reason.length > 500
  ) {
    return json({ error: "Command, event, race entry, expected revision, and a reason are required." }, 400);
  }
  const requestDetails = { duckId, raceEntryId, expectedRevision, reason };
  const previous = await checkCommand(env, commandId, eventId, "ASSIGN_INVENTORY_DUCK", requestDetails, undefined, duckId);
  if (previous.kind === "conflict") {
    return json({ error: "This command identifier was already used for another operation." }, 409);
  }
  if (previous.kind === "replay" && previous.resultId !== null) {
    return json({ assignmentId: previous.resultId, duckId, raceEntryId, replayed: true });
  }

  const event = await env.DB.prepare(
    `SELECT id FROM events
      WHERE id = ? AND status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED')`,
  ).bind(eventId).first<{ id: string }>();
  if (event === null) return json({ error: "Assignments can change only before racing begins." }, 409);

  const duck = await env.DB.prepare(
    `SELECT d.id AS duck_id, d.visible_number, d.revision AS duck_revision,
            d.inventory_status, d.physical_condition,
            ed.id AS event_duck_id, ed.event_id AS event_duck_event_id,
            da.id AS active_assignment_id, dt.id AS tag_id
       FROM ducks d
       LEFT JOIN event_ducks ed ON ed.id = (
         SELECT ed2.id FROM event_ducks ed2
          WHERE ed2.duck_id = d.id AND ed2.released_at IS NULL LIMIT 1
       )
       LEFT JOIN duck_assignments da ON da.duck_id = d.id AND da.valid_to IS NULL
       LEFT JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'ACTIVE'
      WHERE d.id = ?
      LIMIT 1`,
  ).bind(duckId).first<AssignmentContextRow>();
  if (duck === null) return json({ error: "Duck not found." }, 404);
  if (duck.duck_revision !== expectedRevision) {
    return json({ error: "Duck inventory changed. Refresh and try again.", revision: duck.duck_revision }, 409);
  }
  if (
    duck.tag_id === null || duck.physical_condition !== "GOOD"
    || !["AVAILABLE", "RESERVED_FOR_EVENT"].includes(duck.inventory_status)
  ) {
    return json({ error: "This duck is not physically eligible for assignment." }, 409);
  }
  if (duck.active_assignment_id !== null) return json({ error: "This duck is already assigned." }, 409);
  if (duck.event_duck_event_id !== null && duck.event_duck_event_id !== eventId) {
    return json({ error: "This duck is reserved for another event." }, 409);
  }

  const entry = await env.DB.prepare(
    `SELECT re.id AS race_entry_id, r.id AS registration_id,
            r.status AS registration_status, r.first_name, r.last_name,
            old_da.id AS old_assignment_id, old_da.duck_id AS old_duck_id,
            old_d.revision AS old_duck_revision,
            old_da.event_duck_id AS old_event_duck_id,
            (
              SELECT h.id
                FROM heat_entries he
                JOIN heats h ON h.id = he.heat_id
                LEFT JOIN heat_results hr
                  ON hr.heat_id = he.heat_id AND hr.race_entry_id = he.race_entry_id
               WHERE he.race_entry_id = re.id
                 AND (h.status IN ('CALLING', 'RUNNING', 'AWAITING_RESULT', 'FINALIZED') OR hr.id IS NOT NULL)
               LIMIT 1
            ) AS blocking_heat_id
       FROM race_entries re
       JOIN registrations r ON r.id = re.registration_id
       LEFT JOIN duck_assignments old_da
         ON old_da.race_entry_id = re.id AND old_da.valid_to IS NULL
       LEFT JOIN ducks old_d ON old_d.id = old_da.duck_id
      WHERE re.id = ? AND re.event_id = ?
        AND r.status IN ('SUBMITTED', 'ACTIVE')
      LIMIT 1`,
  ).bind(raceEntryId, eventId).first<RaceEntryContextRow>();
  if (entry === null) return json({ error: "Race entry is not eligible for assignment." }, 404);
  if (entry.blocking_heat_id !== null) {
    return json({ error: "This participant's heat has started or has a result; assignment cannot change." }, 409);
  }
  if (entry.old_duck_id === duckId) return json({ error: "This duck is already assigned to that participant." }, 409);

  const now = new Date().toISOString();
  const assignmentId = crypto.randomUUID();
  const eventDuckId = duck.event_duck_id ?? crypto.randomUUID();
  const action = entry.old_assignment_id === null ? "DUCK_ASSIGNED" : "DUCK_REASSIGNED";
  const details = {
    request: requestDetails,
    assignment_id: assignmentId,
    replaced_assignment_id: entry.old_assignment_id,
    replaced_duck_id: entry.old_duck_id,
  };
  const guardedCommand = env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
      SELECT ?, ?, 'ASSIGN_INVENTORY_DUCK', ?, ?, ?
       FROM events e
       JOIN ducks d ON d.id = ?
       JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'ACTIVE'
       JOIN race_entries re ON re.id = ? AND re.event_id = e.id
       JOIN registrations r ON r.id = re.registration_id AND r.status IN ('SUBMITTED', 'ACTIVE')
      WHERE e.id = ? AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED')
        AND d.revision = ? AND d.physical_condition = 'GOOD'
        AND d.inventory_status IN ('AVAILABLE', 'RESERVED_FOR_EVENT')
        AND NOT EXISTS (
         SELECT 1 FROM duck_assignments da WHERE da.duck_id = d.id AND da.valid_to IS NULL
        )
        AND COALESCE((
          SELECT da.id FROM duck_assignments da
           WHERE da.race_entry_id = re.id AND da.valid_to IS NULL
        ), '') = COALESCE(?, '')
        AND (
          ? IS NULL OR EXISTS (
            SELECT 1
              FROM duck_assignments old_da
              JOIN ducks old_d ON old_d.id = old_da.duck_id
             WHERE old_da.id = ? AND old_da.race_entry_id = re.id
               AND old_da.valid_to IS NULL AND old_d.revision = ?
          )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM heat_entries he
            JOIN heats h ON h.id = he.heat_id
            LEFT JOIN heat_results hr
              ON hr.heat_id = he.heat_id AND hr.race_entry_id = he.race_entry_id
           WHERE he.race_entry_id = ?
             AND (h.status IN ('CALLING', 'RUNNING', 'AWAITING_RESULT', 'FINALIZED') OR hr.id IS NOT NULL)
        )`,
  ).bind(
    commandId,
    eventId,
    assignmentId,
    now,
    now,
    duckId,
    raceEntryId,
    eventId,
    expectedRevision,
    entry.old_assignment_id,
    entry.old_assignment_id,
    entry.old_assignment_id,
    entry.old_duck_revision,
    raceEntryId,
  );
  const statements: D1PreparedStatement[] = [guardedCommand];
  if (entry.old_assignment_id !== null && entry.old_duck_id !== null) {
    statements.push(
      env.DB.prepare(
        `UPDATE duck_assignments
            SET valid_to = ?, end_reason = 'STAFF_REASSIGNED', ended_by_staff_profile_id = ?
          WHERE id = ? AND event_id = ? AND valid_to IS NULL`,
      ).bind(now, actor.id, entry.old_assignment_id, eventId),
      env.DB.prepare(
        `UPDATE ducks
            SET inventory_status = CASE physical_condition
                  WHEN 'NEEDS_TAG' THEN 'QUARANTINED'
                  WHEN 'DAMAGED' THEN 'DAMAGED'
                  WHEN 'RETIRED' THEN 'RETIRED'
                  ELSE 'RESERVED_FOR_EVENT'
                END,
                inventory_status_changed_at = ?,
                updated_at = ?, revision = revision + 1
          WHERE id = ? AND revision = ?`,
      ).bind(now, now, entry.old_duck_id, entry.old_duck_revision),
      inventoryEventInsert(env, eventId, entry.old_duck_id, "DUCK_UNASSIGNED", actor.id, commandId, now, {
        request: requestDetails,
        assignment_id: entry.old_assignment_id,
        replacement_duck_id: duckId,
      }),
    );
  }
  if (duck.event_duck_id === null) {
    statements.push(env.DB.prepare(
      `INSERT INTO event_ducks
        (id, event_id, duck_id, reserved_at, reserved_by_staff_profile_id)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(eventDuckId, eventId, duckId, now, actor.id));
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO duck_assignments
        (id, event_id, race_entry_id, event_duck_id, duck_id, valid_from,
         assigned_by_staff_profile_id, source_command_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(assignmentId, eventId, raceEntryId, eventDuckId, duckId, now, actor.id, commandId),
    env.DB.prepare(
      `UPDATE registrations
          SET status = 'ACTIVE', status_changed_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND status IN ('SUBMITTED', 'ACTIVE')`,
    ).bind(now, now, entry.registration_id),
    env.DB.prepare(
      `UPDATE ducks
          SET inventory_status = 'IN_USE', inventory_status_changed_at = ?,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`,
    ).bind(now, now, duckId, expectedRevision),
    inventoryEventInsert(env, eventId, duckId, action, actor.id, commandId, now, details),
    auditInsert(env, eventId, commandId, action, "DUCK_ASSIGNMENT", assignmentId, actor.id, now, {
      race_entry_id: raceEntryId,
      duck_id: duckId,
      replaced_assignment_id: entry.old_assignment_id,
      replaced_duck_id: entry.old_duck_id,
      reason,
    }),
  );
  const execution = await execute(
    env,
    statements,
    commandId,
    eventId,
    "ASSIGN_INVENTORY_DUCK",
    requestDetails,
    assignmentId,
    duckId,
  );
  if (execution === null) {
    return json({ error: "Assignment conflicted with another update. Refresh and try again." }, 409);
  }
  return json({
    assignmentId: execution.resultId,
    duck: { id: duckId, visibleNumber: duck.visible_number, revision: expectedRevision + 1 },
    participant: {
      raceEntryId,
      ...(canViewParticipantPii(actor) ? {
        firstName: entry.first_name,
        lastName: entry.last_name,
      } : {}),
    },
    replacedAssignmentId: entry.old_assignment_id,
    replayed: execution.replayed,
  }, execution.replayed ? 200 : 201);
};

interface UnassignmentContextRow {
  assignment_id: string;
  event_id: string;
  race_entry_id: string;
  registration_id: string;
  duck_id: string;
  visible_number: number;
  duck_revision: number;
  event_duck_id: string;
  event_status: string;
  physical_condition: PhysicalCondition;
  blocking_heat_id: string | null;
}

const unassignDuck = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  assignmentId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const expectedRevision = payload?.expectedRevision;
  const releaseReservation = payload?.releaseReservation === true;
  const reason = typeof payload?.reason === "string" ? payload.reason.trim().replace(/\s+/g, " ") : "";
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || !validRevision(expectedRevision)
    || reason.length < 4 || reason.length > 500
  ) {
    return json({ error: "Command, event, expected revision, and a reason are required." }, 400);
  }
  const requestDetails = { assignmentId, expectedRevision, releaseReservation, reason };
  const previous = await checkCommand(
    env,
    commandId,
    eventId,
    "UNASSIGN_DUCK",
    requestDetails,
    assignmentId,
  );
  if (previous.kind === "conflict") {
    return json({ error: "This command identifier was already used for another operation." }, 409);
  }
  if (previous.kind === "replay") {
    return json({ assignmentId, reservationReleased: releaseReservation, replayed: true });
  }

  const context = await env.DB.prepare(
    `SELECT da.id AS assignment_id, da.event_id, da.race_entry_id,
            r.id AS registration_id, da.duck_id, d.visible_number,
            d.revision AS duck_revision, d.physical_condition, da.event_duck_id,
            e.status AS event_status,
            (
              SELECT h.id
                FROM heat_entries he
                JOIN heats h ON h.id = he.heat_id
                LEFT JOIN heat_results hr
                  ON hr.heat_id = he.heat_id AND hr.race_entry_id = he.race_entry_id
               WHERE he.race_entry_id = da.race_entry_id
                 AND (h.status IN ('CALLING', 'RUNNING', 'AWAITING_RESULT', 'FINALIZED') OR hr.id IS NOT NULL)
               LIMIT 1
            ) AS blocking_heat_id
       FROM duck_assignments da
       JOIN ducks d ON d.id = da.duck_id
       JOIN race_entries re ON re.id = da.race_entry_id
       JOIN registrations r ON r.id = re.registration_id
       JOIN events e ON e.id = da.event_id
      WHERE da.id = ? AND da.event_id = ? AND da.valid_to IS NULL
      LIMIT 1`,
  ).bind(assignmentId, eventId).first<UnassignmentContextRow>();
  if (context === null) return json({ error: "Active assignment not found." }, 404);
  if (!["REGISTRATION_OPEN", "REGISTRATION_CLOSED"].includes(context.event_status)) {
    return json({ error: "Assignments can change only before racing begins." }, 409);
  }
  if (context.blocking_heat_id !== null) {
    return json({ error: "This participant's heat has started or has a result; assignment cannot change." }, 409);
  }
  if (context.duck_revision !== expectedRevision) {
    return json({ error: "Duck inventory changed. Refresh and try again.", revision: context.duck_revision }, 409);
  }

  const now = new Date().toISOString();
  const inventoryStatus = inventoryStatusForCondition(
    context.physical_condition,
    releaseReservation ? "AVAILABLE" : "RESERVED_FOR_EVENT",
  );
  const details = { request: requestDetails, duck_id: context.duck_id, race_entry_id: context.race_entry_id };
  const guardedCommand = env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
     SELECT ?, ?, 'UNASSIGN_DUCK', ?, ?, ?
       FROM events e
       JOIN duck_assignments da ON da.event_id = e.id AND da.id = ? AND da.valid_to IS NULL
       JOIN ducks d ON d.id = da.duck_id
      WHERE e.id = ? AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED')
        AND d.revision = ?
        AND NOT EXISTS (
          SELECT 1
            FROM heat_entries he
            JOIN heats h ON h.id = he.heat_id
            LEFT JOIN heat_results hr
              ON hr.heat_id = he.heat_id AND hr.race_entry_id = he.race_entry_id
           WHERE he.race_entry_id = da.race_entry_id
             AND (h.status IN ('CALLING', 'RUNNING', 'AWAITING_RESULT', 'FINALIZED') OR hr.id IS NOT NULL)
        )`,
  ).bind(commandId, eventId, assignmentId, now, now, assignmentId, eventId, expectedRevision);
  const statements: D1PreparedStatement[] = [
    guardedCommand,
    env.DB.prepare(
      `UPDATE duck_assignments
          SET valid_to = ?, end_reason = 'STAFF_UNASSIGNED', ended_by_staff_profile_id = ?
        WHERE id = ? AND event_id = ? AND valid_to IS NULL`,
    ).bind(now, actor.id, assignmentId, eventId),
    env.DB.prepare(
      `UPDATE registrations
          SET status = 'SUBMITTED', status_changed_at = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND status = 'ACTIVE'`,
    ).bind(now, now, context.registration_id),
  ];
  if (releaseReservation) {
    statements.push(env.DB.prepare(
      `UPDATE event_ducks
          SET released_at = ?, release_reason = 'STAFF_RELEASED', released_by_staff_profile_id = ?
        WHERE id = ? AND event_id = ? AND released_at IS NULL`,
    ).bind(now, actor.id, context.event_duck_id, eventId));
  }
  statements.push(
    env.DB.prepare(
      `UPDATE ducks
          SET inventory_status = ?, inventory_status_changed_at = ?,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`,
    ).bind(inventoryStatus, now, now, context.duck_id, expectedRevision),
    inventoryEventInsert(env, eventId, context.duck_id, "DUCK_UNASSIGNED", actor.id, commandId, now, details),
    auditInsert(env, eventId, commandId, "DUCK_UNASSIGNED", "DUCK_ASSIGNMENT", assignmentId, actor.id, now, {
      duck_id: context.duck_id,
      race_entry_id: context.race_entry_id,
      release_reservation: releaseReservation,
      reason,
    }),
  );
  if (releaseReservation) {
    statements.push(
      inventoryEventInsert(
        env,
        eventId,
        context.duck_id,
        "DUCK_RESERVATION_RELEASED",
        actor.id,
        commandId,
        now,
        details,
      ),
      auditInsert(env, eventId, commandId, "DUCK_RESERVATION_RELEASED", "DUCK", context.duck_id, actor.id, now, {
        event_duck_id: context.event_duck_id,
        assignment_id: assignmentId,
        reason,
      }),
    );
  }
  const execution = await execute(
    env,
    statements,
    commandId,
    eventId,
    "UNASSIGN_DUCK",
    requestDetails,
    assignmentId,
    context.duck_id,
  );
  if (execution === null) {
    return json({ error: "Unassignment conflicted with another update. Refresh and try again." }, 409);
  }
  return json({
    assignmentId,
    duck: {
      id: context.duck_id,
      visibleNumber: context.visible_number,
      inventoryStatus,
      revision: expectedRevision + 1,
    },
    reservationReleased: releaseReservation,
    replayed: execution.replayed,
  }, execution.replayed ? 200 : 201);
};

interface ReservationContextRow {
  duck_id: string;
  visible_number: number;
  duck_revision: number;
  event_duck_id: string;
  event_status: string;
  physical_condition: PhysicalCondition;
  active_assignment_id: string | null;
}

const releaseReservation = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  duckId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const expectedRevision = payload?.expectedRevision;
  const reason = typeof payload?.reason === "string" ? payload.reason.trim().replace(/\s+/g, " ") : "";
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || !validRevision(expectedRevision)
    || reason.length < 4 || reason.length > 500
  ) {
    return json({ error: "Command, event, expected revision, and a reason are required." }, 400);
  }
  const requestDetails = { duckId, expectedRevision, reason };
  const previous = await checkCommand(
    env,
    commandId,
    eventId,
    "RELEASE_DUCK_RESERVATION",
    requestDetails,
    duckId,
    duckId,
  );
  if (previous.kind === "conflict") {
    return json({ error: "This command identifier was already used for another operation." }, 409);
  }
  if (previous.kind === "replay") {
    return json({ duckId, reservationReleased: true, replayed: true });
  }

  const context = await env.DB.prepare(
    `SELECT d.id AS duck_id, d.visible_number, d.revision AS duck_revision,
            d.physical_condition, ed.id AS event_duck_id, e.status AS event_status,
            da.id AS active_assignment_id
       FROM ducks d
       JOIN event_ducks ed
         ON ed.duck_id = d.id AND ed.event_id = ? AND ed.released_at IS NULL
       JOIN events e ON e.id = ed.event_id
       LEFT JOIN duck_assignments da ON da.duck_id = d.id AND da.valid_to IS NULL
      WHERE d.id = ?
      LIMIT 1`,
  ).bind(eventId, duckId).first<ReservationContextRow>();
  if (context === null) return json({ error: "Active duck reservation not found." }, 404);
  if (!preRaceStatuses.includes(context.event_status as typeof preRaceStatuses[number])) {
    return json({ error: "Reservations can be released only before racing begins." }, 409);
  }
  if (context.active_assignment_id !== null) {
    return json({ error: "Unassign the duck before releasing its event reservation." }, 409);
  }
  if (context.duck_revision !== expectedRevision) {
    return json({ error: "Duck inventory changed. Refresh and try again.", revision: context.duck_revision }, 409);
  }

  const now = new Date().toISOString();
  const inventoryStatus = inventoryStatusForCondition(context.physical_condition, "AVAILABLE");
  const details = { request: requestDetails, event_duck_id: context.event_duck_id };
  const guardedCommand = env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
     SELECT ?, ?, 'RELEASE_DUCK_RESERVATION', ?, ?, ?
       FROM events e
       JOIN event_ducks ed ON ed.event_id = e.id AND ed.duck_id = ? AND ed.released_at IS NULL
       JOIN ducks d ON d.id = ed.duck_id
      WHERE e.id = ? AND e.status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED')
        AND d.revision = ?
        AND NOT EXISTS (
          SELECT 1 FROM duck_assignments da WHERE da.duck_id = d.id AND da.valid_to IS NULL
        )`,
  ).bind(commandId, eventId, duckId, now, now, duckId, eventId, expectedRevision);
  const execution = await execute(env, [
    guardedCommand,
    env.DB.prepare(
      `UPDATE event_ducks
          SET released_at = ?, release_reason = 'STAFF_RELEASED', released_by_staff_profile_id = ?
        WHERE id = ? AND event_id = ? AND released_at IS NULL`,
    ).bind(now, actor.id, context.event_duck_id, eventId),
    env.DB.prepare(
      `UPDATE ducks
          SET inventory_status = ?, inventory_status_changed_at = ?,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`,
    ).bind(inventoryStatus, now, now, duckId, expectedRevision),
    inventoryEventInsert(env, eventId, duckId, "DUCK_RESERVATION_RELEASED", actor.id, commandId, now, details),
    auditInsert(env, eventId, commandId, "DUCK_RESERVATION_RELEASED", "DUCK", duckId, actor.id, now, {
      event_duck_id: context.event_duck_id,
      reason,
    }),
  ], commandId, eventId, "RELEASE_DUCK_RESERVATION", requestDetails, duckId, duckId);
  if (execution === null) {
    return json({ error: "Reservation release conflicted with another update. Refresh and try again." }, 409);
  }
  return json({
    duck: {
      id: duckId,
      visibleNumber: context.visible_number,
      inventoryStatus,
      revision: expectedRevision + 1,
    },
    reservationReleased: true,
    replayed: execution.replayed,
  }, execution.replayed ? 200 : 201);
};

export const handleDuckOperations = async (
  request: Request,
  env: Env,
  actor: StaffActor | null,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(`${inventoryPath}/`)) return null;
  if (actor === null) {
    return json({ error: "Staff authentication required." }, 401);
  }
  const denied = requireAnyRole(actor, ["DUCK_MANAGER", "RACE_DIRECTOR"]);
  if (denied !== null) return denied;
  const includePii = canViewParticipantPii(actor);

  if (url.pathname === `${inventoryPath}/provisioning`) {
    if (request.method === "GET") return recoverProvisioning(url, env, actor);
    if (request.method === "POST") return startProvisioning(request, env, actor);
    return json({ error: "Method not allowed." }, 405);
  }

  if (url.pathname === `${inventoryPath}/provisioning/classify`) {
    return request.method === "POST"
      ? classifyProvisioningTag(request, env, actor)
      : json({ error: "Method not allowed." }, 405);
  }

  if (url.pathname === `${inventoryPath}/provisioning/takeover`) {
    return request.method === "POST"
      ? takeoverProvisioning(request, env, actor)
      : json({ error: "Method not allowed." }, 405);
  }

  if (url.pathname === `${inventoryPath}/provisioning/confirm`) {
    return request.method === "POST"
      ? confirmProvisioning(request, env, actor)
      : json({ error: "Method not allowed." }, 405);
  }

  if (url.pathname === `${inventoryPath}/ducks`) {
    if (request.method === "GET") return listDucks(env, includePii);
    if (request.method === "POST") return intakeDuck(request, env, actor);
    return json({ error: "Method not allowed." }, 405);
  }

  const unassignMatch = url.pathname.match(
    /^\/api\/v1\/staff\/inventory\/assignments\/([A-Za-z0-9_-]{1,128})\/unassign$/,
  );
  if (unassignMatch !== null) {
    return request.method === "POST"
      ? unassignDuck(request, env, actor, unassignMatch[1])
      : json({ error: "Method not allowed." }, 405);
  }

  const duckActionMatch = url.pathname.match(
    /^\/api\/v1\/staff\/inventory\/ducks\/([A-Za-z0-9_-]{1,128})\/(history|label|assignments|reservations\/release|delete)$/,
  );
  if (duckActionMatch !== null) {
    const [, duckId, action] = duckActionMatch;
    if (action === "history" && request.method === "GET") return getDuckDetail(env, duckId, true, includePii);
    if (action === "label" && request.method === "GET") return getLabelData(env, duckId);
    if (action === "assignments" && request.method === "POST") return assignDuck(request, env, actor, duckId);
    if (action === "delete" && request.method === "POST") return deleteDuck(request, env, actor, duckId);
    if (action === "reservations/release" && request.method === "POST") {
      return releaseReservation(request, env, actor, duckId);
    }
    return json({ error: "Method not allowed." }, 405);
  }

  const duckMatch = url.pathname.match(
    /^\/api\/v1\/staff\/inventory\/ducks\/([A-Za-z0-9_-]{1,128})$/,
  );
  if (duckMatch !== null) {
    return request.method === "GET"
      ? getDuckDetail(env, duckMatch[1], false, includePii)
      : json({ error: "Method not allowed." }, 405);
  }

  return null;
};
