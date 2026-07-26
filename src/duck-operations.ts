import type { StaffActor } from "./auth.ts";
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

const hashValue = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

interface DuckSummaryRow {
  duck_id: string;
  visible_number: number;
  inventory_status: string;
  duck_revision: number;
  physical_condition: PhysicalCondition;
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
  registration_id: string | null;
  first_name: string | null;
  last_name: string | null;
  registration_status: string | null;
  heat_id: string | null;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  heat_slot_number: number | null;
  disposition: string | null;
  disposition_recorded_at: string | null;
}

const duckSelect = `
  SELECT d.id AS duck_id, d.visible_number, d.inventory_status,
         d.revision AS duck_revision, d.physical_condition,
         d.storage_location, d.notes,
         dt.id AS tag_id, dt.status AS tag_status, dt.activated_at AS tag_activated_at,
         ed.id AS event_duck_id, ed.reserved_at, ed.released_at,
         e.id AS event_id, e.name AS event_name, e.status AS event_status,
         da.id AS assignment_id, da.valid_from AS assignment_valid_from,
         da.race_entry_id, r.id AS registration_id,
         r.first_name, r.last_name, r.status AS registration_status,
         h.id AS heat_id, h.round AS heat_round, h.heat_number,
         h.status AS heat_status, he.slot_number AS heat_slot_number,
         ded.disposition, ded.recorded_at AS disposition_recorded_at
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
    LEFT JOIN heats h ON h.id = he.heat_id
    LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id`;

const summaryResponse = (row: DuckSummaryRow): Record<string, unknown> => ({
  id: row.duck_id,
  visibleNumber: row.visible_number,
  inventoryStatus: row.inventory_status,
  revision: row.duck_revision,
  condition: row.physical_condition,
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
  participant: row.registration_id === null ? null : {
    registrationId: row.registration_id,
    raceEntryId: row.race_entry_id,
    firstName: row.first_name,
    lastName: row.last_name,
    status: row.registration_status,
  },
  heat: row.heat_id === null ? null : {
    id: row.heat_id,
    round: row.heat_round,
    number: row.heat_number,
    status: row.heat_status,
    slotNumber: row.heat_slot_number,
  },
  disposition: row.disposition === null ? null : {
    status: row.disposition,
    recordedAt: row.disposition_recorded_at,
  },
});

const getDuckSummary = (env: Env, duckId: string): Promise<DuckSummaryRow | null> =>
  env.DB.prepare(`${duckSelect} WHERE d.id = ? LIMIT 1`).bind(duckId).first<DuckSummaryRow>();

const listDucks = async (env: Env): Promise<Response> => {
  const ducks = await env.DB.prepare(`${duckSelect} ORDER BY d.visible_number`).all<DuckSummaryRow>();
  return json({ ducks: ducks.results.map(summaryResponse) });
};

const parseDetails = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
};

const getDuckHistory = async (env: Env, duckId: string): Promise<Record<string, unknown>> => {
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
              e.id AS event_id, e.name AS event_name, e.status AS event_status,
              ded.disposition, ded.recorded_at AS disposition_recorded_at
         FROM event_ducks ed
         JOIN events e ON e.id = ed.event_id
         LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
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
      disposition: string | null;
      disposition_recorded_at: string | null;
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
      disposition: row.disposition === null ? null : {
        status: row.disposition,
        recordedAt: row.disposition_recorded_at,
      },
    })),
    assignments: assignments.results.map((row) => ({
      id: row.id,
      validFrom: row.valid_from,
      validTo: row.valid_to,
      endReason: row.end_reason,
      participant: {
        registrationId: row.registration_id,
        raceEntryId: row.race_entry_id,
        firstName: row.first_name,
        lastName: row.last_name,
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

const getDuckDetail = async (env: Env, duckId: string, historyOnly: boolean): Promise<Response> => {
  const duck = await getDuckSummary(env, duckId);
  if (duck === null) return json({ error: "Duck not found." }, 404);
  const history = await getDuckHistory(env, duckId);
  return historyOnly
    ? json({ duckId, history })
    : json({ duck: summaryResponse(duck), history });
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
  physical_condition: PhysicalCondition;
  storage_location: string | null;
  notes: string | null;
  tag_id: string;
  event_duck_id: string;
}

const getIntakeResult = (env: Env, duckId: string, eventId: string): Promise<IntakeResultRow | null> =>
  env.DB.prepare(
    `SELECT d.id AS duck_id, d.visible_number, d.inventory_status, d.revision,
            d.physical_condition, d.storage_location, d.notes,
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
    condition: row.physical_condition,
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
  const condition = payload?.condition ?? "GOOD";
  const location = cleanOptional(payload?.location ?? null, 100);
  const notes = cleanOptional(payload?.notes ?? null, 1000);
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || !validVisibleNumber(visibleNumber)
    || !validTagToken(tagToken)
    || !physicalConditions.includes(condition as PhysicalCondition)
    || location === undefined || notes === undefined
    || payload?.physicallyPresent !== true
  ) {
    return json({ error: "Command, event, physical-presence confirmation, duck number, condition, and valid tag are required." }, 400);
  }

  const requestDetails = {
    visibleNumber,
    tagTokenHash: await hashValue(tagToken),
    condition,
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

  const event = await env.DB.prepare(
    `SELECT id FROM events WHERE id = ? AND status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED')`,
  ).bind(eventId).first<{ id: string }>();
  if (event === null) return json({ error: "Duck intake is closed for this event." }, 409);

  const now = new Date().toISOString();
  const duckId = crypto.randomUUID();
  const tagId = crypto.randomUUID();
  const eventDuckId = crypto.randomUUID();
  const inventoryStatus = inventoryStatusForCondition(condition as PhysicalCondition, "RESERVED_FOR_EVENT");
  const details = { request: requestDetails, tag_id: tagId, event_duck_id: eventDuckId };
  const execution = await execute(env, [
    commandInsert(env, commandId, eventId, "REGISTER_RACE_DUCK", duckId, now, preRaceStatuses),
    env.DB.prepare(
      `INSERT INTO ducks
         (id, visible_number, inventory_status, inventory_status_changed_at,
          physical_condition, storage_location, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(duckId, visibleNumber, inventoryStatus, now, condition, location, notes, now, now),
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
      condition,
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
    physical_condition: condition as PhysicalCondition,
    storage_location: location,
    notes,
    tag_id: tagId,
    event_duck_id: eventDuckId,
  }, false);
};

interface EditableDuckRow {
  id: string;
  visible_number: number;
  inventory_status: string;
  revision: number;
  physical_condition: PhysicalCondition;
  storage_location: string | null;
  notes: string | null;
  event_duck_id: string;
  event_status: string;
  active_assignment_id: string | null;
}

const getEditableDuck = (env: Env, duckId: string, eventId: string): Promise<EditableDuckRow | null> =>
  env.DB.prepare(
    `SELECT d.id, d.visible_number, d.inventory_status, d.revision,
            d.physical_condition, d.storage_location, d.notes,
            ed.id AS event_duck_id, e.status AS event_status,
            da.id AS active_assignment_id
       FROM ducks d
       JOIN event_ducks ed
         ON ed.duck_id = d.id AND ed.event_id = ? AND ed.released_at IS NULL
       JOIN events e ON e.id = ed.event_id
       LEFT JOIN duck_assignments da ON da.duck_id = d.id AND da.valid_to IS NULL
      WHERE d.id = ?
      LIMIT 1`,
  ).bind(eventId, duckId).first<EditableDuckRow>();

const editDuck = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  duckId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const expectedRevision = payload?.expectedRevision;
  const hasVisibleNumber = payload !== null && Object.hasOwn(payload, "visibleNumber");
  const hasCondition = payload !== null && Object.hasOwn(payload, "condition");
  const hasLocation = payload !== null && Object.hasOwn(payload, "location");
  const hasNotes = payload !== null && Object.hasOwn(payload, "notes");
  const location = hasLocation ? cleanOptional(payload?.location, 100) : undefined;
  const notes = hasNotes ? cleanOptional(payload?.notes, 1000) : undefined;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || !validRevision(expectedRevision)
    || (!hasVisibleNumber && !hasCondition && !hasLocation && !hasNotes)
    || (hasVisibleNumber && !validVisibleNumber(payload?.visibleNumber))
    || (hasCondition && !physicalConditions.includes(payload?.condition as PhysicalCondition))
    || (hasLocation && location === undefined) || (hasNotes && notes === undefined)
  ) {
    return json({ error: "Command, event, expected revision, and at least one valid inventory field are required." }, 400);
  }

  const changes: Record<string, unknown> = {};
  if (hasVisibleNumber) changes.visibleNumber = payload?.visibleNumber;
  if (hasCondition) changes.condition = payload?.condition;
  if (hasLocation) changes.location = location;
  if (hasNotes) changes.notes = notes;
  const requestDetails = { duckId, expectedRevision, changes };
  const previous = await checkCommand(env, commandId, eventId, "EDIT_DUCK_INVENTORY", requestDetails, duckId, duckId);
  if (previous.kind === "conflict") {
    return json({ error: "This command identifier was already used for another operation." }, 409);
  }
  if (previous.kind === "replay") {
    const current = await getEditableDuck(env, duckId, eventId);
    return current === null
      ? json({ error: "Duck not found in this event." }, 404)
      : json({ duck: {
        id: current.id,
        visibleNumber: current.visible_number,
        inventoryStatus: current.inventory_status,
        revision: current.revision,
        condition: current.physical_condition,
        location: current.storage_location,
        notes: current.notes,
      }, replayed: true });
  }

  const current = await getEditableDuck(env, duckId, eventId);
  if (current === null) return json({ error: "Duck not found in this event." }, 404);
  if (!preRaceStatuses.includes(current.event_status as typeof preRaceStatuses[number])) {
    return json({ error: "Inventory fields can be edited only before racing begins." }, 409);
  }
  if (current.revision !== expectedRevision) {
    return json({ error: "Duck inventory changed. Refresh and try again.", revision: current.revision }, 409);
  }

  const now = new Date().toISOString();
  const nextCondition = hasCondition
    ? payload?.condition as PhysicalCondition
    : current.physical_condition;
  const nextInventoryStatus = hasCondition
    ? inventoryStatusForCondition(
      nextCondition,
      current.active_assignment_id === null ? "RESERVED_FOR_EVENT" : "IN_USE",
    )
    : current.inventory_status;
  const assignments: string[] = [];
  const values: unknown[] = [];
  if (hasVisibleNumber) {
    assignments.push("visible_number = ?");
    values.push(payload?.visibleNumber);
  }
  if (hasCondition) {
    assignments.push("physical_condition = ?");
    values.push(payload?.condition);
    assignments.push("inventory_status = ?", "inventory_status_changed_at = ?");
    values.push(nextInventoryStatus, now);
  }
  if (hasLocation) {
    assignments.push("storage_location = ?");
    values.push(location);
  }
  if (hasNotes) {
    assignments.push("notes = ?");
    values.push(notes);
  }
  const details = { request: requestDetails, before: {
    visibleNumber: current.visible_number,
    condition: current.physical_condition,
    location: current.storage_location,
    notes: current.notes,
  } };
  const guardedCommand = env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
     SELECT ?, ?, 'EDIT_DUCK_INVENTORY', ?, ?, ?
       FROM events e
       JOIN event_ducks ed ON ed.event_id = e.id AND ed.duck_id = ? AND ed.released_at IS NULL
       JOIN ducks d ON d.id = ed.duck_id
      WHERE e.id = ?
        AND e.status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED')
        AND d.revision = ?`,
  ).bind(commandId, eventId, duckId, now, now, duckId, eventId, expectedRevision);
  const execution = await execute(env, [
    guardedCommand,
    env.DB.prepare(
      `UPDATE ducks SET ${assignments.join(", ")}, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`,
    ).bind(...values, now, duckId, expectedRevision),
    inventoryEventInsert(env, eventId, duckId, "DUCK_EDITED", actor.id, commandId, now, details),
    auditInsert(env, eventId, commandId, "DUCK_INVENTORY_EDITED", "DUCK", duckId, actor.id, now, {
      expected_revision: expectedRevision,
      changes,
    }),
  ], commandId, eventId, "EDIT_DUCK_INVENTORY", requestDetails, duckId, duckId);
  if (execution === null) {
    return json({ error: "Duck inventory changed or conflicts with another duck. Refresh and try again." }, 409);
  }
  if (execution.replayed) {
    const replay = await getEditableDuck(env, duckId, eventId);
    return replay === null ? json({ error: "Duck not found in this event." }, 404) : json({
      duck: {
        id: replay.id,
        visibleNumber: replay.visible_number,
        inventoryStatus: replay.inventory_status,
        revision: replay.revision,
        condition: replay.physical_condition,
        location: replay.storage_location,
        notes: replay.notes,
      },
      replayed: true,
    });
  }
  return json({
    duck: {
      id: duckId,
      visibleNumber: hasVisibleNumber ? payload?.visibleNumber : current.visible_number,
      inventoryStatus: nextInventoryStatus,
      revision: expectedRevision + 1,
      condition: hasCondition ? payload?.condition : current.physical_condition,
      location: hasLocation ? location : current.storage_location,
      notes: hasNotes ? notes : current.notes,
    },
    replayed: false,
  });
};

interface TagContextRow {
  duck_id: string;
  visible_number: number;
  revision: number;
  inventory_status: string;
  physical_condition: PhysicalCondition;
  event_duck_id: string;
  event_status: string;
  tag_id: string;
  active_assignment_id: string | null;
}

const getTagContext = (env: Env, duckId: string, eventId: string): Promise<TagContextRow | null> =>
  env.DB.prepare(
    `SELECT d.id AS duck_id, d.visible_number, d.revision, d.inventory_status,
            d.physical_condition, ed.id AS event_duck_id, e.status AS event_status,
            dt.id AS tag_id, da.id AS active_assignment_id
       FROM ducks d
       JOIN event_ducks ed
         ON ed.duck_id = d.id AND ed.event_id = ? AND ed.released_at IS NULL
       JOIN events e ON e.id = ed.event_id
       JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'ACTIVE'
       LEFT JOIN duck_assignments da ON da.duck_id = d.id AND da.valid_to IS NULL
      WHERE d.id = ?
      LIMIT 1`,
  ).bind(eventId, duckId).first<TagContextRow>();

const replaceTag = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  duckId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const expectedRevision = payload?.expectedRevision;
  const newTagToken = payload?.tagToken;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !validEventId(eventId) || !validRevision(expectedRevision)
    || !validTagToken(newTagToken) || payload?.physicalTagVerified !== true
  ) {
    return json({ error: "Command, event, expected revision, verified physical tag, and valid tag token are required." }, 400);
  }
  const requestDetails = {
    duckId,
    expectedRevision,
    tagTokenHash: await hashValue(newTagToken),
    physicalTagVerified: true,
  };
  const previous = await checkCommand(env, commandId, eventId, "REPLACE_DUCK_TAG", requestDetails, duckId, duckId);
  if (previous.kind === "conflict") {
    return json({ error: "This command identifier was already used for another operation." }, 409);
  }
  if (previous.kind === "replay") {
    const current = await getTagContext(env, duckId, eventId);
    return current === null
      ? json({ error: "The saved tag replacement is no longer active." }, 409)
      : json({ duckId, revision: current.revision, tag: { id: current.tag_id, status: "ACTIVE" }, replayed: true });
  }

  const context = await getTagContext(env, duckId, eventId);
  if (context === null) return json({ error: "Duck has no active tag in this event." }, 404);
  if (!activeRaceStatuses.includes(context.event_status as typeof activeRaceStatuses[number])) {
    return json({ error: "Tags cannot be replaced after racing is complete." }, 409);
  }
  if (context.revision !== expectedRevision) {
    return json({ error: "Duck inventory changed. Refresh and try again.", revision: context.revision }, 409);
  }

  const now = new Date().toISOString();
  const tagId = crypto.randomUUID();
  const restoredCondition = context.physical_condition === "NEEDS_TAG" ? "GOOD" : context.physical_condition;
  const restoredInventoryStatus = context.physical_condition === "NEEDS_TAG"
    ? context.active_assignment_id === null ? "RESERVED_FOR_EVENT" : "IN_USE"
    : context.inventory_status;
  const details = { request: requestDetails, retired_tag_id: context.tag_id, active_tag_id: tagId };
  const guardedCommand = env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
     SELECT ?, ?, 'REPLACE_DUCK_TAG', ?, ?, ?
       FROM events e
       JOIN event_ducks ed ON ed.event_id = e.id AND ed.duck_id = ? AND ed.released_at IS NULL
       JOIN ducks d ON d.id = ed.duck_id
       JOIN duck_tags dt ON dt.duck_id = d.id AND dt.id = ? AND dt.status = 'ACTIVE'
      WHERE e.id = ?
        AND e.status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')
        AND d.revision = ?`,
  ).bind(commandId, eventId, duckId, now, now, duckId, context.tag_id, eventId, expectedRevision);
  const execution = await execute(env, [
    guardedCommand,
    env.DB.prepare(
      `UPDATE duck_tags
          SET status = 'RETIRED', retired_at = ?, updated_at = ?
        WHERE id = ? AND duck_id = ? AND status = 'ACTIVE'`,
    ).bind(now, now, context.tag_id, duckId),
    env.DB.prepare(
      `INSERT INTO duck_tags
        (id, duck_id, token, status, supersedes_tag_id, written_at,
         verified_at, activated_at, created_at, updated_at)
       VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?, ?)`,
    ).bind(tagId, duckId, newTagToken, context.tag_id, now, now, now, now, now),
    env.DB.prepare(
      `UPDATE ducks
          SET inventory_status = ?, inventory_status_changed_at = ?,
              physical_condition = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`,
    ).bind(restoredInventoryStatus, now, restoredCondition, now, duckId, expectedRevision),
    inventoryEventInsert(env, eventId, duckId, "DUCK_TAG_REPLACED", actor.id, commandId, now, details),
    auditInsert(env, eventId, commandId, "DUCK_TAG_REPLACED", "DUCK", duckId, actor.id, now, {
      retired_tag_id: context.tag_id,
      active_tag_id: tagId,
    }),
  ], commandId, eventId, "REPLACE_DUCK_TAG", requestDetails, duckId, duckId);
  if (execution === null) {
    return json({ error: "Tag replacement conflicted with another inventory update. Refresh and try again." }, 409);
  }
  if (execution.replayed) {
    const replay = await getTagContext(env, duckId, eventId);
    return replay === null
      ? json({ error: "The saved tag replacement is no longer active." }, 409)
      : json({ duckId, revision: replay.revision, tag: { id: replay.tag_id, status: "ACTIVE" }, replayed: true });
  }
  return json({ duckId, revision: expectedRevision + 1, tag: { id: tagId, status: "ACTIVE" }, replayed: false }, 201);
};

const retireTag = async (
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
    || reason.length < 4 || reason.length > 500 || payload?.physicalTagRemoved !== true
  ) {
    return json({ error: "Command, event, expected revision, removal confirmation, and a reason are required." }, 400);
  }
  const requestDetails = { duckId, expectedRevision, reason, physicalTagRemoved: true };
  const previous = await checkCommand(env, commandId, eventId, "RETIRE_DUCK_TAG", requestDetails, duckId, duckId);
  if (previous.kind === "conflict") {
    return json({ error: "This command identifier was already used for another operation." }, 409);
  }
  if (previous.kind === "replay") {
    return json({ duckId, revision: expectedRevision + 1, tag: { status: "RETIRED" }, replayed: true });
  }

  const context = await getTagContext(env, duckId, eventId);
  if (context === null) return json({ error: "Duck has no active tag in this event." }, 404);
  if (!preRaceStatuses.includes(context.event_status as typeof preRaceStatuses[number])) {
    return json({ error: "A tag may be retired without replacement only before racing begins." }, 409);
  }
  if (context.active_assignment_id !== null) {
    return json({ error: "Replace the tag instead; an assigned duck must retain an active tag." }, 409);
  }
  if (context.revision !== expectedRevision) {
    return json({ error: "Duck inventory changed. Refresh and try again.", revision: context.revision }, 409);
  }

  const now = new Date().toISOString();
  const details = { request: requestDetails, retired_tag_id: context.tag_id };
  const guardedCommand = env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at)
     SELECT ?, ?, 'RETIRE_DUCK_TAG', ?, ?, ?
       FROM events e
       JOIN event_ducks ed ON ed.event_id = e.id AND ed.duck_id = ? AND ed.released_at IS NULL
       JOIN ducks d ON d.id = ed.duck_id
       JOIN duck_tags dt ON dt.duck_id = d.id AND dt.id = ? AND dt.status = 'ACTIVE'
      WHERE e.id = ?
        AND e.status IN ('DRAFT', 'REGISTRATION_OPEN', 'REGISTRATION_CLOSED')
        AND d.revision = ?
        AND NOT EXISTS (
          SELECT 1 FROM duck_assignments da WHERE da.duck_id = d.id AND da.valid_to IS NULL
        )`,
  ).bind(commandId, eventId, duckId, now, now, duckId, context.tag_id, eventId, expectedRevision);
  const execution = await execute(env, [
    guardedCommand,
    env.DB.prepare(
      `UPDATE duck_tags
          SET status = 'RETIRED', retired_at = ?, updated_at = ?
        WHERE id = ? AND duck_id = ? AND status = 'ACTIVE'`,
    ).bind(now, now, context.tag_id, duckId),
    env.DB.prepare(
      `UPDATE ducks
          SET inventory_status = 'QUARANTINED', inventory_status_changed_at = ?,
              physical_condition = 'NEEDS_TAG', updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`,
    ).bind(now, now, duckId, expectedRevision),
    inventoryEventInsert(env, eventId, duckId, "DUCK_TAG_RETIRED", actor.id, commandId, now, details),
    auditInsert(env, eventId, commandId, "DUCK_TAG_RETIRED", "DUCK", duckId, actor.id, now, {
      tag_id: context.tag_id,
      reason,
    }),
  ], commandId, eventId, "RETIRE_DUCK_TAG", requestDetails, duckId, duckId);
  if (execution === null) {
    return json({ error: "Tag retirement conflicted with another inventory update. Refresh and try again." }, 409);
  }
  return json({ duckId, revision: expectedRevision + 1, tag: { id: context.tag_id, status: "RETIRED" }, replayed: execution.replayed }, execution.replayed ? 200 : 201);
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
      firstName: entry.first_name,
      lastName: entry.last_name,
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

  if (url.pathname === `${inventoryPath}/ducks`) {
    if (request.method === "GET") return listDucks(env);
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
    /^\/api\/v1\/staff\/inventory\/ducks\/([A-Za-z0-9_-]{1,128})\/(history|label|tags\/replace|tags\/retire|assignments|reservations\/release)$/,
  );
  if (duckActionMatch !== null) {
    const [, duckId, action] = duckActionMatch;
    if (action === "history" && request.method === "GET") return getDuckDetail(env, duckId, true);
    if (action === "label" && request.method === "GET") return getLabelData(env, duckId);
    if (action === "tags/replace" && request.method === "POST") return replaceTag(request, env, actor, duckId);
    if (action === "tags/retire" && request.method === "POST") return retireTag(request, env, actor, duckId);
    if (action === "assignments" && request.method === "POST") return assignDuck(request, env, actor, duckId);
    if (action === "reservations/release" && request.method === "POST") {
      return releaseReservation(request, env, actor, duckId);
    }
    return json({ error: "Method not allowed." }, 405);
  }

  const duckMatch = url.pathname.match(
    /^\/api\/v1\/staff\/inventory\/ducks\/([A-Za-z0-9_-]{1,128})$/,
  );
  if (duckMatch !== null) {
    if (request.method === "GET") return getDuckDetail(env, duckMatch[1], false);
    if (request.method === "PATCH") return editDuck(request, env, actor, duckMatch[1]);
    return json({ error: "Method not allowed." }, 405);
  }

  return null;
};
