import type { StaffActor } from "./auth.ts";
import { operationalRoles, requireAnyRole } from "./authorization.ts";
import { isCommandId } from "./registration.ts";
import type { Env } from "./types.ts";

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
} as const;

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers });

const adminRequired = (actor: StaffActor): Response | null =>
  actor.isSystemAdmin ? null : json({ error: "Administrator permission required." }, 403);

const raceReadRoles = ["ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER", "RACE_DIRECTOR"] as const;

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) return null;
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

type EventStatus =
  | "DRAFT"
  | "REGISTRATION_OPEN"
  | "REGISTRATION_CLOSED"
  | "ROUND_ONE"
  | "FINAL"
  | "COMPLETED"
  | "RETURN_PROCESSING"
  | "ARCHIVED";

interface EventRow {
  id: string;
  slug: string;
  name: string;
  event_date: string | null;
  timezone: string;
  status: EventStatus;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
  email_required: number;
  heat_assignment_mode: "IMMEDIATE_FIXED" | "POST_CLOSE_BALANCED";
  round_one_heat_capacity: number;
  final_heat_capacity: number;
  public_name_policy: "FIRST_NAME_ONLY" | "FIRST_NAME_LAST_INITIAL" | "FULL_NAME";
  revision: number;
  created_at: string;
  updated_at: string;
}

interface EventDefaultsRow {
  timezone: string;
  email_required: number;
  heat_assignment_mode: EventRow["heat_assignment_mode"];
  round_one_heat_capacity: number;
  final_heat_capacity: number;
  public_name_policy: EventRow["public_name_policy"];
}

interface ExistingCommand {
  event_id: string;
  command_type: string;
  result_id: string | null;
  request_fingerprint: string | null;
}

const eventColumns = `id, slug, name, event_date, timezone, status,
  registration_opens_at, registration_closes_at, email_required,
  heat_assignment_mode, round_one_heat_capacity, final_heat_capacity,
  public_name_policy, revision, created_at, updated_at`;

const eventResponse = (event: EventRow): Record<string, unknown> => ({
  id: event.id,
  slug: event.slug,
  name: event.name,
  eventDate: event.event_date,
  timezone: event.timezone,
  status: event.status,
  registrationOpensAt: event.registration_opens_at,
  registrationClosesAt: event.registration_closes_at,
  emailRequired: event.email_required === 1,
  heatAssignmentMode: event.heat_assignment_mode,
  roundOneHeatCapacity: event.round_one_heat_capacity,
  finalHeatCapacity: event.final_heat_capacity,
  publicNamePolicy: event.public_name_policy,
  revision: event.revision,
  createdAt: event.created_at,
  updatedAt: event.updated_at,
});

const getEvent = (eventId: string, env: Env): Promise<EventRow | null> =>
  env.DB.prepare(`SELECT ${eventColumns} FROM events WHERE id = ? LIMIT 1`)
    .bind(eventId).first<EventRow>();

const findCommand = (commandId: string, env: Env): Promise<ExistingCommand | null> =>
  env.DB.prepare(
    `SELECT event_id, command_type, result_id, request_fingerprint
       FROM race_commands
      WHERE id = ?
      LIMIT 1`,
  ).bind(commandId).first<ExistingCommand>();

const listEvents = async (env: Env): Promise<Response> => {
  const events = await env.DB.prepare(
    `SELECT ${eventColumns}
       FROM events
      ORDER BY event_date IS NULL, event_date DESC, created_at DESC
      LIMIT 200`,
  ).all<EventRow>();
  return json({ events: events.results.map(eventResponse) });
};

interface EventSummaryRow {
  registration_count: number;
  event_duck_count: number;
  round_one_heat_count: number;
  final_heat_count: number;
}

const eventDetail = async (eventId: string, env: Env): Promise<Response> => {
  const event = await getEvent(eventId, env);
  if (event === null) return json({ error: "Event not found." }, 404);
  const summary = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM registrations WHERE event_id = e.id) AS registration_count,
       (SELECT COUNT(*) FROM event_ducks WHERE event_id = e.id) AS event_duck_count,
       (SELECT COUNT(*) FROM heats WHERE event_id = e.id AND round = 'ROUND_ONE') AS round_one_heat_count,
       (SELECT COUNT(*) FROM heats WHERE event_id = e.id AND round = 'FINAL') AS final_heat_count
     FROM events e
     WHERE e.id = ?`,
  ).bind(eventId).first<EventSummaryRow>();
  return json({
    event: eventResponse(event),
    summary: {
      registrations: summary?.registration_count ?? 0,
      eventDucks: summary?.event_duck_count ?? 0,
      roundOneHeats: summary?.round_one_heat_count ?? 0,
      finalHeats: summary?.final_heat_count ?? 0,
    },
  });
};

const normalizedName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name.length >= 1 && name.length <= 120 ? name : null;
};

const normalizedSlug = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  return slug.length <= 80 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) ? slug : null;
};

const normalizedDate = (value: unknown, nullable: boolean): string | null | undefined => {
  if (value === null && nullable) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? undefined : value;
};

const normalizedTimestamp = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
};

const normalizedTimezone = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const timezone = value.trim();
  return timezone.length <= 64
      && /^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)*)$/.test(timezone)
    ? timezone
    : null;
};

const canonicalFingerprint = (value: Record<string, unknown>): string => JSON.stringify(value);

const createEvent = async (
  request: Request,
  env: Env,
  actor: StaffActor,
): Promise<Response> => {
  const denied = adminRequired(actor);
  if (denied !== null) return denied;
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  const name = normalizedName(payload.name);
  const slug = normalizedSlug(payload.slug);
  const eventDate = normalizedDate(payload.eventDate, false);
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || name === null || slug === null || eventDate === undefined || eventDate === null
  ) {
    return json({ error: "Command, event name, slug, and event date are required." }, 400);
  }
  const fingerprint = canonicalFingerprint({ operation: "CREATE_EVENT", slug, name, eventDate });
  const existingCommand = await findCommand(commandId, env);
  if (existingCommand !== null) {
    if (existingCommand.command_type !== "CREATE_EVENT" || existingCommand.request_fingerprint !== fingerprint) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const existingEvent = existingCommand.result_id === null
      ? null
      : await getEvent(existingCommand.result_id, env);
    return existingEvent === null
      ? json({ error: "The event created by this command no longer exists." }, 409)
      : json({ event: eventResponse(existingEvent), replayed: true });
  }

  const current = await env.DB.prepare("SELECT id FROM events LIMIT 1").first<{ id: string }>();
  if (current !== null) return json({ error: "Delete or purge the existing event before creating another." }, 409);
  const defaults = await env.DB.prepare(
    `SELECT timezone, email_required, heat_assignment_mode,
            round_one_heat_capacity, final_heat_capacity, public_name_policy
       FROM organization_event_defaults
      WHERE singleton_id = 1`,
  ).first<EventDefaultsRow>();
  if (defaults === null) return json({ error: "Organization event defaults are not configured." }, 409);

  const eventId = crypto.randomUUID();
  const now = new Date().toISOString();
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events
          (id, slug, name, event_date, timezone, status,
           registration_opens_at, registration_closes_at, email_required,
           heat_assignment_mode, round_one_heat_capacity, final_heat_capacity,
           public_name_policy, revision, created_at, updated_at)
         SELECT ?, ?, ?, ?, d.timezone, 'DRAFT', NULL, NULL, d.email_required,
                d.heat_assignment_mode, d.round_one_heat_capacity,
                d.final_heat_capacity, d.public_name_policy, 0, ?, ?
           FROM organization_event_defaults d
          WHERE d.singleton_id = 1
            AND NOT EXISTS (SELECT 1 FROM events)`,
      ).bind(eventId, slug, name, eventDate, now, now),
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
         SELECT ?, ?, 'CREATE_EVENT', ?, ?, ?, ?
           FROM events
          WHERE id = ? AND status = 'DRAFT'`,
      ).bind(commandId, eventId, eventId, now, now, fingerprint, eventId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'EVENT_CREATED', 'EVENT', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = 'CREATE_EVENT'`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        commandId,
        eventId,
        now,
        JSON.stringify({ staff_profile_id: actor.id, command_id: commandId, slug, name, event_date: eventDate }),
        commandId,
        eventId,
      ),
    ]);
  } catch {
    return json({ error: "Event creation conflicted with another update. Refresh and try again." }, 409);
  }
  if (results[0]?.meta.changes === 0 || results[1]?.meta.changes === 0) {
    return json({ error: "Event creation conflicted with another update. Refresh and try again." }, 409);
  }

  const event: EventRow = {
    id: eventId,
    slug,
    name,
    event_date: eventDate,
    timezone: defaults.timezone,
    status: "DRAFT",
    registration_opens_at: null,
    registration_closes_at: null,
    email_required: defaults.email_required,
    heat_assignment_mode: defaults.heat_assignment_mode,
    round_one_heat_capacity: defaults.round_one_heat_capacity,
    final_heat_capacity: defaults.final_heat_capacity,
    public_name_policy: defaults.public_name_policy,
    revision: 0,
    created_at: now,
    updated_at: now,
  };
  return json({ event: eventResponse(event), replayed: false }, 201);
};

interface ConfigurationPatch {
  slug?: string;
  name?: string;
  eventDate?: string | null;
  timezone?: string;
  registrationOpensAt?: string | null;
  registrationClosesAt?: string | null;
  emailRequired?: boolean;
  heatAssignmentMode?: EventRow["heat_assignment_mode"];
  roundOneHeatCapacity?: number;
  finalHeatCapacity?: number;
  publicNamePolicy?: EventRow["public_name_policy"];
}

const parseConfigurationPatch = (
  payload: Record<string, unknown>,
): { patch?: ConfigurationPatch; error?: string } => {
  const patch: ConfigurationPatch = {};
  if ("slug" in payload) {
    const value = normalizedSlug(payload.slug);
    if (value === null) return { error: "Enter a valid lowercase event slug." };
    patch.slug = value;
  }
  if ("name" in payload) {
    const value = normalizedName(payload.name);
    if (value === null) return { error: "Enter an event name between 1 and 120 characters." };
    patch.name = value;
  }
  if ("eventDate" in payload) {
    const value = normalizedDate(payload.eventDate, true);
    if (value === undefined) return { error: "Enter a valid event date or null." };
    patch.eventDate = value;
  }
  if ("timezone" in payload) {
    const value = normalizedTimezone(payload.timezone);
    if (value === null) return { error: "Enter a valid IANA timezone." };
    patch.timezone = value;
  }
  for (const key of ["registrationOpensAt", "registrationClosesAt"] as const) {
    if (key in payload) {
      const value = normalizedTimestamp(payload[key]);
      if (value === undefined) return { error: `Enter a valid ${key} timestamp or null.` };
      patch[key] = value;
    }
  }
  if ("emailRequired" in payload) {
    if (typeof payload.emailRequired !== "boolean") return { error: "emailRequired must be a boolean." };
    patch.emailRequired = payload.emailRequired;
  }
  if ("heatAssignmentMode" in payload) {
    if (payload.heatAssignmentMode !== "IMMEDIATE_FIXED" && payload.heatAssignmentMode !== "POST_CLOSE_BALANCED") {
      return { error: "Select a valid heat assignment mode." };
    }
    patch.heatAssignmentMode = payload.heatAssignmentMode;
  }
  for (const key of ["roundOneHeatCapacity", "finalHeatCapacity"] as const) {
    if (key in payload) {
      const value = payload[key];
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
        return { error: `${key} must be an integer between 1 and 10000.` };
      }
      patch[key] = value as number;
    }
  }
  if ("publicNamePolicy" in payload) {
    if (!(["FIRST_NAME_ONLY", "FIRST_NAME_LAST_INITIAL", "FULL_NAME"] as unknown[]).includes(payload.publicNamePolicy)) {
      return { error: "Select a valid public name policy." };
    }
    patch.publicNamePolicy = payload.publicNamePolicy as EventRow["public_name_policy"];
  }
  return Object.keys(patch).length === 0
    ? { error: "At least one configuration field is required." }
    : { patch };
};

const configureEvent = async (
  request: Request,
  eventId: string,
  env: Env,
  actor: StaffActor,
): Promise<Response> => {
  const denied = adminRequired(actor);
  if (denied !== null) return denied;
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  const expectedRevision = payload.revision;
  const parsed = parseConfigurationPatch(payload);
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !Number.isInteger(expectedRevision) || (expectedRevision as number) < 0
    || parsed.patch === undefined
  ) {
    return json({ error: parsed.error ?? "Command, revision, and valid configuration are required." }, 400);
  }
  const patch = parsed.patch;
  const fingerprint = canonicalFingerprint({
    operation: "CONFIGURE_EVENT",
    eventId,
    revision: expectedRevision,
    patch,
  });
  const existingCommand = await findCommand(commandId, env);
  if (existingCommand !== null) {
    if (
      existingCommand.event_id !== eventId
      || existingCommand.command_type !== "CONFIGURE_EVENT"
      || existingCommand.request_fingerprint !== fingerprint
    ) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getEvent(eventId, env);
    return replay === null
      ? json({ error: "Event not found." }, 404)
      : json({ event: eventResponse(replay), replayed: true });
  }

  const event = await getEvent(eventId, env);
  if (event === null) return json({ error: "Event not found." }, 404);
  if (event.status !== "DRAFT") return json({ error: "Only a draft event can be configured." }, 409);
  if (event.revision !== expectedRevision) {
    return json({ error: "The event changed. Refresh and retry with its current revision.", event: eventResponse(event) }, 409);
  }
  const next = {
    slug: patch.slug ?? event.slug,
    name: patch.name ?? event.name,
    eventDate: patch.eventDate === undefined ? event.event_date : patch.eventDate,
    timezone: patch.timezone ?? event.timezone,
    registrationOpensAt: patch.registrationOpensAt === undefined
      ? event.registration_opens_at
      : patch.registrationOpensAt,
    registrationClosesAt: patch.registrationClosesAt === undefined
      ? event.registration_closes_at
      : patch.registrationClosesAt,
    emailRequired: patch.emailRequired ?? (event.email_required === 1),
    heatAssignmentMode: patch.heatAssignmentMode ?? event.heat_assignment_mode,
    roundOneHeatCapacity: patch.roundOneHeatCapacity ?? event.round_one_heat_capacity,
    finalHeatCapacity: patch.finalHeatCapacity ?? event.final_heat_capacity,
    publicNamePolicy: patch.publicNamePolicy ?? event.public_name_policy,
  };
  if (
    next.registrationOpensAt !== null
    && next.registrationClosesAt !== null
    && next.registrationOpensAt >= next.registrationClosesAt
  ) {
    return json({ error: "Registration must open before it closes." }, 422);
  }

  const now = new Date().toISOString();
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
         SELECT ?, id, 'CONFIGURE_EVENT', id, ?, ?, ?
           FROM events
          WHERE id = ? AND status = 'DRAFT' AND revision = ?`,
      ).bind(commandId, now, now, fingerprint, eventId, expectedRevision),
      env.DB.prepare(
        `UPDATE events
            SET slug = ?, name = ?, event_date = ?, timezone = ?,
                registration_opens_at = ?, registration_closes_at = ?,
                email_required = ?, heat_assignment_mode = ?,
                round_one_heat_capacity = ?, final_heat_capacity = ?,
                public_name_policy = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'DRAFT' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM race_commands
               WHERE id = ? AND event_id = ? AND command_type = 'CONFIGURE_EVENT'
            )`,
      ).bind(
        next.slug,
        next.name,
        next.eventDate,
        next.timezone,
        next.registrationOpensAt,
        next.registrationClosesAt,
        next.emailRequired ? 1 : 0,
        next.heatAssignmentMode,
        next.roundOneHeatCapacity,
        next.finalHeatCapacity,
        next.publicNamePolicy,
        now,
        eventId,
        expectedRevision,
        commandId,
        eventId,
      ),
      env.DB.prepare(
        `UPDATE organization_event_defaults
            SET timezone = ?, email_required = ?, heat_assignment_mode = ?,
                round_one_heat_capacity = ?, final_heat_capacity = ?,
                public_name_policy = ?, revision = revision + 1,
                updated_at = ?, updated_by_staff_profile_id = ?
          WHERE singleton_id = 1
            AND EXISTS (
              SELECT 1 FROM race_commands
               WHERE id = ? AND event_id = ? AND command_type = 'CONFIGURE_EVENT'
            )`,
      ).bind(
        next.timezone,
        next.emailRequired ? 1 : 0,
        next.heatAssignmentMode,
        next.roundOneHeatCapacity,
        next.finalHeatCapacity,
        next.publicNamePolicy,
        now,
        actor.id,
        commandId,
        eventId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'EVENT_CONFIGURED', 'EVENT', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = 'CONFIGURE_EVENT'`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        commandId,
        eventId,
        now,
        JSON.stringify({
          staff_profile_id: actor.id,
          command_id: commandId,
          previous_revision: expectedRevision,
          configuration: next,
        }),
        commandId,
        eventId,
      ),
    ]);
  } catch {
    return json({ error: "Event configuration conflicted with another update. Refresh and try again." }, 409);
  }
  if (results[0]?.meta.changes === 0 || results[1]?.meta.changes === 0) {
    return json({ error: "Event configuration conflicted with another update. Refresh and try again." }, 409);
  }

  const configured: EventRow = {
    ...event,
    slug: next.slug,
    name: next.name,
    event_date: next.eventDate,
    timezone: next.timezone,
    registration_opens_at: next.registrationOpensAt,
    registration_closes_at: next.registrationClosesAt,
    email_required: next.emailRequired ? 1 : 0,
    heat_assignment_mode: next.heatAssignmentMode,
    round_one_heat_capacity: next.roundOneHeatCapacity,
    final_heat_capacity: next.finalHeatCapacity,
    public_name_policy: next.publicNamePolicy,
    revision: event.revision + 1,
    updated_at: now,
  };
  return json({ event: eventResponse(configured), replayed: false });
};

interface ReadinessStats {
  submitted_registration_count: number;
  active_entry_count: number;
  active_entry_without_duck_count: number;
  active_entry_without_round_one_heat_count: number;
  pending_provisioning_count: number;
  round_one_heat_count: number;
  round_one_unready_heat_count: number;
  round_one_unfinished_heat_count: number;
  round_one_finalized_heat_count: number;
  round_one_missing_result_count: number;
  final_heat_count: number;
  final_entry_count: number;
  final_unready_heat_count: number;
  final_unfinished_heat_count: number;
  final_finalized_heat_count: number;
  final_missing_result_count: number;
  in_progress_heat_count: number;
  any_heat_count: number;
}

const getReadinessStats = (eventId: string, env: Env): Promise<ReadinessStats | null> =>
  env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM registrations r
         WHERE r.event_id = e.id AND r.status = 'SUBMITTED') AS submitted_registration_count,
       (SELECT COUNT(*) FROM race_entries re
          JOIN registrations r ON r.id = re.registration_id
         WHERE re.event_id = e.id AND r.status = 'ACTIVE') AS active_entry_count,
       (SELECT COUNT(*) FROM race_entries re
          JOIN registrations r ON r.id = re.registration_id
         WHERE re.event_id = e.id AND r.status = 'ACTIVE'
           AND NOT EXISTS (
             SELECT 1 FROM duck_assignments da
              WHERE da.race_entry_id = re.id AND da.valid_to IS NULL
           )) AS active_entry_without_duck_count,
        (SELECT COUNT(*) FROM race_entries re
           JOIN registrations r ON r.id = re.registration_id
          WHERE re.event_id = e.id AND r.status = 'ACTIVE'
            AND NOT EXISTS (
              SELECT 1 FROM heat_entries he
               WHERE he.race_entry_id = re.id AND he.round = 'ROUND_ONE'
            )) AS active_entry_without_round_one_heat_count,
        (SELECT COUNT(DISTINCT rc.id) FROM race_commands rc
           JOIN (SELECT base_duck.*, 'NEEDS_TAG' AS physical_condition FROM ducks base_duck) d
             ON d.id = rc.result_id
            AND d.inventory_status = 'NEW'
            AND d.physical_condition = 'NEEDS_TAG'
           JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'RESERVED'
          WHERE rc.event_id = e.id
            AND rc.command_type = 'START_DUCK_PROVISIONING'
            AND NOT EXISTS (
              SELECT 1 FROM event_ducks ed
               WHERE ed.duck_id = d.id AND ed.released_at IS NULL
            )) AS pending_provisioning_count,
        (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id AND h.round = 'ROUND_ONE') AS round_one_heat_count,
       (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id AND h.round = 'ROUND_ONE'
           AND h.status NOT IN ('PLANNED', 'LOADING', 'READY')) AS round_one_unready_heat_count,
       (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id AND h.round = 'ROUND_ONE'
           AND h.status NOT IN ('FINALIZED', 'CANCELLED')) AS round_one_unfinished_heat_count,
       (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id AND h.round = 'ROUND_ONE'
           AND h.status = 'FINALIZED') AS round_one_finalized_heat_count,
        (SELECT COUNT(*) FROM heats h
          WHERE h.event_id = e.id AND h.round = 'ROUND_ONE' AND h.status = 'FINALIZED'
            AND NOT EXISTS (
              SELECT 1 FROM heat_results hr
               WHERE hr.event_id = e.id AND hr.heat_id = h.id
                 AND hr.status = 'FINALIZED' AND hr.place = 1
            )) AS round_one_missing_result_count,
       (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id AND h.round = 'FINAL') AS final_heat_count,
       (SELECT COUNT(*) FROM heat_entries he
         WHERE he.event_id = e.id AND he.round = 'FINAL') AS final_entry_count,
       (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id AND h.round = 'FINAL'
           AND h.status NOT IN ('PLANNED', 'LOADING', 'READY')) AS final_unready_heat_count,
       (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id AND h.round = 'FINAL'
           AND h.status NOT IN ('FINALIZED', 'CANCELLED')) AS final_unfinished_heat_count,
       (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id AND h.round = 'FINAL'
           AND h.status = 'FINALIZED') AS final_finalized_heat_count,
        (SELECT COUNT(*) FROM heats h
          WHERE h.event_id = e.id AND h.round = 'FINAL' AND h.status = 'FINALIZED'
            AND (
              SELECT COUNT(*) FROM heat_results hr
               WHERE hr.event_id = e.id AND hr.heat_id = h.id AND hr.status = 'FINALIZED'
            ) != MIN(3, (
              SELECT COUNT(*) FROM heat_entries he
               WHERE he.event_id = e.id AND he.heat_id = h.id
            ))) AS final_missing_result_count,
       (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id
           AND h.status IN ('CALLING', 'RUNNING', 'AWAITING_RESULT')) AS in_progress_heat_count,
       (SELECT COUNT(*) FROM heats h WHERE h.event_id = e.id) AS any_heat_count
     FROM events e
     WHERE e.id = ?`,
  ).bind(eventId).first<ReadinessStats>();

type LifecycleAction =
  | "open-registration"
  | "close-registration"
  | "reopen-registration"
  | "start-round-one"
  | "start-final"
  | "complete"
  | "start-return-processing";

interface LifecycleDefinition {
  action: LifecycleAction;
  commandType: string;
  auditAction: string;
  from: EventStatus;
  to: EventStatus;
  requiresAdmin: boolean;
  commandSql: string;
  updateSql: string;
}

const lifecycleDefinitions: Record<LifecycleAction, LifecycleDefinition> = {
  "open-registration": {
    action: "open-registration",
    commandType: "OPEN_REGISTRATION",
    auditAction: "REGISTRATION_OPENED",
    from: "DRAFT",
    to: "REGISTRATION_OPEN",
    requiresAdmin: false,
    commandSql: `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
     SELECT ?, e.id, 'OPEN_REGISTRATION', e.id, ?, ?, ?
       FROM events e
      WHERE e.id = ? AND e.status = 'DRAFT' AND e.event_date IS NOT NULL`,
    updateSql: `UPDATE events SET status = 'REGISTRATION_OPEN', revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'DRAFT'
        AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'OPEN_REGISTRATION')`,
  },
  "close-registration": {
    action: "close-registration",
    commandType: "CLOSE_REGISTRATION",
    auditAction: "REGISTRATION_CLOSED",
    from: "REGISTRATION_OPEN",
    to: "REGISTRATION_CLOSED",
    requiresAdmin: false,
    commandSql: `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
     SELECT ?, e.id, 'CLOSE_REGISTRATION', e.id, ?, ?, ?
       FROM events e
      WHERE e.id = ? AND e.status = 'REGISTRATION_OPEN'`,
    updateSql: `UPDATE events SET status = 'REGISTRATION_CLOSED', revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'REGISTRATION_OPEN'
        AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'CLOSE_REGISTRATION')`,
  },
  "reopen-registration": {
    action: "reopen-registration",
    commandType: "REOPEN_REGISTRATION",
    auditAction: "REGISTRATION_REOPENED",
    from: "REGISTRATION_CLOSED",
    to: "REGISTRATION_OPEN",
    requiresAdmin: true,
    commandSql: `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
     SELECT ?, e.id, 'REOPEN_REGISTRATION', e.id, ?, ?, ?
       FROM events e
      WHERE e.id = ? AND e.status = 'REGISTRATION_CLOSED'
        AND NOT EXISTS (SELECT 1 FROM heats h WHERE h.event_id = e.id)`,
    updateSql: `UPDATE events SET status = 'REGISTRATION_OPEN', revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'REGISTRATION_CLOSED'
        AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'REOPEN_REGISTRATION')`,
  },
  "start-round-one": {
    action: "start-round-one",
    commandType: "START_ROUND_ONE",
    auditAction: "ROUND_ONE_STARTED",
    from: "REGISTRATION_CLOSED",
    to: "ROUND_ONE",
    requiresAdmin: false,
    commandSql: `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
     SELECT ?, e.id, 'START_ROUND_ONE', e.id, ?, ?, ?
       FROM events e
       WHERE e.id = ? AND e.status = 'REGISTRATION_CLOSED'
         AND NOT EXISTS (
           SELECT 1 FROM race_commands rc
             JOIN (SELECT base_duck.*, 'NEEDS_TAG' AS physical_condition FROM ducks base_duck) d
               ON d.id = rc.result_id
              AND d.inventory_status = 'NEW'
              AND d.physical_condition = 'NEEDS_TAG'
             JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'RESERVED'
            WHERE rc.event_id = e.id
              AND rc.command_type = 'START_DUCK_PROVISIONING'
              AND NOT EXISTS (
                SELECT 1 FROM event_ducks ed
                 WHERE ed.duck_id = d.id AND ed.released_at IS NULL
              )
         )
         AND EXISTS (
          SELECT 1 FROM race_entries re JOIN registrations r ON r.id = re.registration_id
           WHERE re.event_id = e.id AND r.status = 'ACTIVE'
        )
        AND NOT EXISTS (
          SELECT 1 FROM registrations r
           WHERE r.event_id = e.id AND r.status = 'SUBMITTED'
        )
        AND NOT EXISTS (
          SELECT 1 FROM race_entries re JOIN registrations r ON r.id = re.registration_id
           WHERE re.event_id = e.id AND r.status = 'ACTIVE'
             AND NOT EXISTS (SELECT 1 FROM duck_assignments da WHERE da.race_entry_id = re.id AND da.valid_to IS NULL)
        )
        AND NOT EXISTS (
          SELECT 1 FROM race_entries re JOIN registrations r ON r.id = re.registration_id
           WHERE re.event_id = e.id AND r.status = 'ACTIVE'
             AND NOT EXISTS (SELECT 1 FROM heat_entries he WHERE he.race_entry_id = re.id AND he.round = 'ROUND_ONE')
        )
         AND EXISTS (SELECT 1 FROM heats h WHERE h.event_id = e.id AND h.round = 'ROUND_ONE')
         AND (SELECT COUNT(*) FROM heats h
               WHERE h.event_id = e.id AND h.round = 'ROUND_ONE') <= e.final_heat_capacity
         AND NOT EXISTS (
          SELECT 1 FROM heats h WHERE h.event_id = e.id AND h.round = 'ROUND_ONE'
            AND h.status NOT IN ('PLANNED', 'LOADING', 'READY')
        )`,
    updateSql: `UPDATE events SET status = 'ROUND_ONE', revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'REGISTRATION_CLOSED'
        AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'START_ROUND_ONE')`,
  },
  "start-final": {
    action: "start-final",
    commandType: "START_FINAL",
    auditAction: "FINAL_STARTED",
    from: "ROUND_ONE",
    to: "FINAL",
    requiresAdmin: false,
    commandSql: `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
     SELECT ?, e.id, 'START_FINAL', e.id, ?, ?, ?
       FROM events e
      WHERE e.id = ? AND e.status = 'ROUND_ONE'
        AND EXISTS (SELECT 1 FROM heats h WHERE h.event_id = e.id AND h.round = 'ROUND_ONE' AND h.status = 'FINALIZED')
        AND NOT EXISTS (
          SELECT 1 FROM heats h WHERE h.event_id = e.id AND h.round = 'ROUND_ONE'
            AND h.status NOT IN ('FINALIZED', 'CANCELLED')
        )
        AND NOT EXISTS (
          SELECT 1 FROM heats h
           WHERE h.event_id = e.id AND h.round = 'ROUND_ONE' AND h.status = 'FINALIZED'
             AND NOT EXISTS (
               SELECT 1 FROM heat_results hr
                WHERE hr.event_id = e.id AND hr.heat_id = h.id
                  AND hr.status = 'FINALIZED' AND hr.place = 1
             )
        )
        AND EXISTS (SELECT 1 FROM heat_entries he WHERE he.event_id = e.id AND he.round = 'FINAL')
        AND NOT EXISTS (
          SELECT 1 FROM heats h WHERE h.event_id = e.id AND h.round = 'FINAL'
            AND h.status NOT IN ('PLANNED', 'LOADING', 'READY')
        )`,
    updateSql: `UPDATE events SET status = 'FINAL', revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'ROUND_ONE'
        AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'START_FINAL')`,
  },
  complete: {
    action: "complete",
    commandType: "COMPLETE_EVENT",
    auditAction: "EVENT_COMPLETED",
    from: "FINAL",
    to: "COMPLETED",
    requiresAdmin: false,
    commandSql: `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
     SELECT ?, e.id, 'COMPLETE_EVENT', e.id, ?, ?, ?
       FROM events e
      WHERE e.id = ? AND e.status = 'FINAL'
        AND EXISTS (SELECT 1 FROM heats h WHERE h.event_id = e.id AND h.round = 'FINAL' AND h.status = 'FINALIZED')
        AND NOT EXISTS (
          SELECT 1 FROM heats h WHERE h.event_id = e.id AND h.round = 'FINAL'
            AND h.status NOT IN ('FINALIZED', 'CANCELLED')
        )
        AND NOT EXISTS (
          SELECT 1 FROM heats h
           WHERE h.event_id = e.id AND h.round = 'FINAL' AND h.status = 'FINALIZED'
             AND (
               SELECT COUNT(*) FROM heat_results hr
                WHERE hr.event_id = e.id AND hr.heat_id = h.id AND hr.status = 'FINALIZED'
             ) != MIN(3, (
               SELECT COUNT(*) FROM heat_entries he
                WHERE he.event_id = e.id AND he.heat_id = h.id
             ))
        )`,
    updateSql: `UPDATE events SET status = 'COMPLETED', revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'FINAL'
        AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'COMPLETE_EVENT')`,
  },
  "start-return-processing": {
    action: "start-return-processing",
    commandType: "START_RETURN_PROCESSING",
    auditAction: "RETURN_PROCESSING_STARTED",
    from: "COMPLETED",
    to: "RETURN_PROCESSING",
    requiresAdmin: false,
    commandSql: `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
     SELECT ?, e.id, 'START_RETURN_PROCESSING', e.id, ?, ?, ?
       FROM events e
      WHERE e.id = ? AND e.status = 'COMPLETED'
        AND NOT EXISTS (
          SELECT 1 FROM heats h WHERE h.event_id = e.id
            AND h.status IN ('CALLING', 'RUNNING', 'AWAITING_RESULT')
        )`,
    updateSql: `UPDATE events SET status = 'RETURN_PROCESSING', revision = revision + 1, updated_at = ?
      WHERE id = ? AND status = 'COMPLETED'
        AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'START_RETURN_PROCESSING')`,
  },
};

const readinessFor = (
  event: EventRow,
  stats: ReadinessStats,
  definition: LifecycleDefinition,
): Record<string, unknown> => {
  const blockers: string[] = [];
  if (event.status !== definition.from) blockers.push(`Event status must be ${definition.from}.`);
  switch (definition.action) {
    case "open-registration":
      if (event.event_date === null) blockers.push("Set the event date before opening registration.");
      break;
    case "reopen-registration":
      if (stats.any_heat_count > 0) blockers.push("Registration cannot reopen after heats have been created.");
      break;
    case "start-round-one":
      if (stats.active_entry_count === 0) blockers.push("At least one paired participant is required.");
      if (stats.submitted_registration_count > 0) blockers.push("Every submitted participant must be paired or withdrawn.");
      if (stats.active_entry_without_duck_count > 0) blockers.push("Every active participant needs an assigned duck.");
      if (stats.active_entry_without_round_one_heat_count > 0) blockers.push("Every active participant needs a round-one heat.");
      if (stats.pending_provisioning_count > 0) {
        blockers.push(stats.pending_provisioning_count === 1
          ? "Finish the pending NFC sticker before starting round one."
          : `Finish ${stats.pending_provisioning_count} pending NFC stickers before starting round one.`);
      }
      if (stats.round_one_heat_count === 0) blockers.push("At least one round-one heat is required.");
      if (stats.round_one_heat_count > event.final_heat_capacity) {
        blockers.push("Round-one heat count cannot exceed final capacity.");
      }
      if (stats.round_one_unready_heat_count > 0) blockers.push("Round-one heats must not have started.");
      break;
    case "start-final":
      if (stats.round_one_finalized_heat_count === 0) blockers.push("At least one round-one heat must be finalized.");
      if (stats.round_one_unfinished_heat_count > 0) blockers.push("Every round-one heat must be finalized or cancelled.");
      if (stats.round_one_missing_result_count > 0) blockers.push("Every finalized round-one heat needs a winning result.");
      if (stats.final_heat_count === 0 || stats.final_entry_count === 0) blockers.push("Create the final and promote finalists first.");
      if (stats.final_unready_heat_count > 0) blockers.push("Final heats must not have started.");
      break;
    case "complete":
      if (stats.final_finalized_heat_count === 0) blockers.push("At least one final heat must be finalized.");
      if (stats.final_unfinished_heat_count > 0) blockers.push("Every final heat must be finalized or cancelled.");
      if (stats.final_missing_result_count > 0) blockers.push("Every finalized final heat needs a complete podium result.");
      break;
    case "start-return-processing":
      if (stats.in_progress_heat_count > 0) blockers.push("No heat may be active or awaiting a result.");
      break;
    case "close-registration":
      break;
  }
  return {
    command: definition.commandType,
    fromStatus: definition.from,
    toStatus: definition.to,
    requiresAdmin: definition.requiresAdmin,
    allowed: blockers.length === 0,
    blockers,
  };
};

const eventReadiness = async (eventId: string, env: Env): Promise<Response> => {
  const event = await getEvent(eventId, env);
  if (event === null) return json({ error: "Event not found." }, 404);
  const stats = await getReadinessStats(eventId, env);
  if (stats === null) return json({ error: "Event readiness could not be calculated." }, 409);
  return json({
    event: eventResponse(event),
    readiness: Object.fromEntries(
      Object.entries(lifecycleDefinitions).map(([action, definition]) => [
        action,
        readinessFor(event, stats, definition),
      ]),
    ),
  });
};

const runLifecycleCommand = async (
  request: Request,
  eventId: string,
  definition: LifecycleDefinition,
  env: Env,
  actor: StaffActor,
): Promise<Response> => {
  if (definition.requiresAdmin) {
    const denied = adminRequired(actor);
    if (denied !== null) return denied;
  } else {
    const denied = requireAnyRole(actor, ["RACE_DIRECTOR"]);
    if (denied !== null) return denied;
  }
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  if (typeof commandId !== "string" || !isCommandId(commandId)) {
    return json({ error: "A valid command identifier is required." }, 400);
  }
  const fingerprint = canonicalFingerprint({ operation: definition.commandType, eventId });
  const existingCommand = await findCommand(commandId, env);
  if (existingCommand !== null) {
    if (
      existingCommand.event_id !== eventId
      || existingCommand.command_type !== definition.commandType
      || existingCommand.request_fingerprint !== fingerprint
    ) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getEvent(eventId, env);
    return replay === null
      ? json({ error: "Event not found." }, 404)
      : json({ event: eventResponse(replay), replayed: true });
  }

  const event = await getEvent(eventId, env);
  if (event === null) return json({ error: "Event not found." }, 404);
  const stats = await getReadinessStats(eventId, env);
  if (stats === null) return json({ error: "Event readiness could not be calculated." }, 409);
  const readiness = readinessFor(event, stats, definition);
  if (readiness.allowed !== true) return json({ error: "Event is not ready for this transition.", readiness }, 409);

  const now = new Date().toISOString();
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(definition.commandSql).bind(commandId, now, now, fingerprint, eventId),
      env.DB.prepare(definition.updateSql).bind(now, eventId, commandId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, ?, 'EVENT', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = ?`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        commandId,
        definition.auditAction,
        eventId,
        now,
        JSON.stringify({
          staff_profile_id: actor.id,
          command_id: commandId,
          from_status: definition.from,
          to_status: definition.to,
        }),
        commandId,
        eventId,
        definition.commandType,
      ),
    ]);
  } catch {
    return json({ error: "The event transition conflicted with another update. Refresh and try again." }, 409);
  }
  if (results[0]?.meta.changes === 0 || results[1]?.meta.changes === 0) {
    return json({ error: "The event transition conflicted with another update. Refresh and try again." }, 409);
  }

  const transitioned: EventRow = {
    ...event,
    status: definition.to,
    revision: event.revision + 1,
    updated_at: now,
  };
  return json({ event: eventResponse(transitioned), replayed: false }, 201);
};

interface DraftSafetyRow {
  registration_count: number;
  race_entry_count: number;
  event_duck_count: number;
  duck_assignment_count: number;
  heat_count: number;
  heat_entry_count: number;
  heat_result_count: number;
  disposition_count: number;
  unsafe_command_count: number;
  unsafe_audit_count: number;
}

const getDraftSafety = (eventId: string, env: Env): Promise<DraftSafetyRow | null> =>
  env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM registrations WHERE event_id = e.id) AS registration_count,
       (SELECT COUNT(*) FROM race_entries WHERE event_id = e.id) AS race_entry_count,
       (SELECT COUNT(*) FROM event_ducks WHERE event_id = e.id) AS event_duck_count,
       (SELECT COUNT(*) FROM duck_assignments WHERE event_id = e.id) AS duck_assignment_count,
       (SELECT COUNT(*) FROM heats WHERE event_id = e.id) AS heat_count,
       (SELECT COUNT(*) FROM heat_entries WHERE event_id = e.id) AS heat_entry_count,
       (SELECT COUNT(*) FROM heat_results WHERE event_id = e.id) AS heat_result_count,
       (SELECT COUNT(*) FROM duck_event_dispositions WHERE event_id = e.id) AS disposition_count,
       (SELECT COUNT(*) FROM race_commands
         WHERE event_id = e.id AND command_type NOT IN ('CREATE_EVENT', 'CONFIGURE_EVENT')) AS unsafe_command_count,
       (SELECT COUNT(*) FROM audit_events
         WHERE event_id = e.id AND action NOT IN ('EVENT_CREATED', 'EVENT_CONFIGURED')) AS unsafe_audit_count
     FROM events e
     WHERE e.id = ?`,
  ).bind(eventId).first<DraftSafetyRow>();

const draftSafetyBlockers = (event: EventRow, safety: DraftSafetyRow): string[] => {
  const blockers: string[] = [];
  if (event.status !== "DRAFT") blockers.push("Only a draft event can be deleted as a mistake.");
  const dataCount = safety.registration_count + safety.race_entry_count + safety.event_duck_count
    + safety.duck_assignment_count + safety.heat_count + safety.heat_entry_count
    + safety.heat_result_count + safety.disposition_count;
  if (dataCount > 0) blockers.push("The draft contains race data and cannot be deleted.");
  if (safety.unsafe_command_count > 0 || safety.unsafe_audit_count > 0) {
    blockers.push("The draft has operational history and cannot be deleted.");
  }
  return blockers;
};

const deleteDraft = async (
  request: Request,
  eventId: string,
  env: Env,
  actor: StaffActor,
): Promise<Response> => {
  const denied = adminRequired(actor);
  if (denied !== null) return denied;
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const revision = payload?.revision;
  const confirmation = payload?.confirmation;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !Number.isInteger(revision) || (revision as number) < 0
    || typeof confirmation !== "string"
  ) {
    return json({ error: "Command, revision, and typed deletion confirmation are required." }, 400);
  }
  const fingerprint = canonicalFingerprint({ operation: "DELETE_EMPTY_DRAFT", eventId, revision, confirmation });
  const deletionReplay = await env.DB.prepare(
    `SELECT subject_id, details_json
       FROM audit_events
      WHERE action = 'EMPTY_DRAFT_DELETED'
        AND CASE WHEN json_valid(details_json)
          THEN json_extract(details_json, '$.command_id') END = ?
      LIMIT 1`,
  ).bind(commandId).first<{ subject_id: string; details_json: string }>();
  if (deletionReplay !== null) {
    let replayFingerprint: unknown;
    try {
      replayFingerprint = (JSON.parse(deletionReplay.details_json) as Record<string, unknown>).request_fingerprint;
    } catch {
      return json({ error: "This command identifier has an invalid audit record." }, 409);
    }
    return deletionReplay.subject_id === eventId && replayFingerprint === fingerprint
      ? new Response(null, { status: 204, headers })
      : json({ error: "This command identifier was already used for another operation." }, 409);
  }
  if (await findCommand(commandId, env) !== null) {
    return json({ error: "This command identifier was already used for another operation." }, 409);
  }

  const event = await getEvent(eventId, env);
  if (event === null) return json({ error: "Event not found." }, 404);
  if (event.revision !== revision) {
    return json({ error: "The event changed. Refresh before deleting it.", event: eventResponse(event) }, 409);
  }
  if (confirmation !== `DELETE ${event.name}`) {
    return json({ error: `Type DELETE ${event.name} to confirm deletion.` }, 422);
  }
  const safety = await getDraftSafety(eventId, env);
  if (safety === null) return json({ error: "Event not found." }, 404);
  const blockers = draftSafetyBlockers(event, safety);
  if (blockers.length > 0) return json({ error: blockers[0], blockers }, 409);

  const now = new Date().toISOString();
  const deletionAuditId = crypto.randomUUID();
  const safeDraftPredicate = `e.id = ? AND e.status = 'DRAFT' AND e.revision = ?
    AND NOT EXISTS (SELECT 1 FROM registrations WHERE event_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM race_entries WHERE event_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM event_ducks WHERE event_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM duck_assignments WHERE event_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM heats WHERE event_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM heat_entries WHERE event_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM heat_results WHERE event_id = e.id)
    AND NOT EXISTS (SELECT 1 FROM duck_event_dispositions WHERE event_id = e.id)
    AND NOT EXISTS (
      SELECT 1 FROM race_commands
       WHERE event_id = e.id AND command_type NOT IN ('CREATE_EVENT', 'CONFIGURE_EVENT')
    )
    AND NOT EXISTS (
      SELECT 1 FROM audit_events
       WHERE event_id = e.id AND action NOT IN ('EVENT_CREATED', 'EVENT_CONFIGURED')
    )`;
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
         SELECT ?, e.id, 'DELETE_EMPTY_DRAFT', e.id, ?, ?, ?
           FROM events e
          WHERE ${safeDraftPredicate}`,
      ).bind(commandId, now, now, fingerprint, eventId, revision),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'EMPTY_DRAFT_DELETED', 'EVENT', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = 'DELETE_EMPTY_DRAFT'`,
      ).bind(
        deletionAuditId,
        eventId,
        commandId,
        eventId,
        now,
        JSON.stringify({
          staff_profile_id: actor.id,
          command_id: commandId,
          event_id: eventId,
          event_slug: event.slug,
          event_name: event.name,
          revision,
          request_fingerprint: fingerprint,
        }),
        commandId,
        eventId,
      ),
      env.DB.prepare(
        `UPDATE audit_events
            SET event_id = NULL, command_id = NULL
          WHERE event_id = ?
            AND EXISTS (
              SELECT 1 FROM race_commands
               WHERE id = ? AND event_id = ? AND command_type = 'DELETE_EMPTY_DRAFT'
            )`,
      ).bind(eventId, commandId, eventId),
      env.DB.prepare(
        `DELETE FROM race_commands
          WHERE event_id = ?
            AND EXISTS (
              SELECT 1 FROM audit_events
               WHERE id = ? AND action = 'EMPTY_DRAFT_DELETED'
                 AND event_id IS NULL AND command_id IS NULL
            )`,
      ).bind(eventId, deletionAuditId),
      env.DB.prepare(
        `DELETE FROM events
          WHERE id = ? AND status = 'DRAFT' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM audit_events
               WHERE id = ? AND action = 'EMPTY_DRAFT_DELETED'
                 AND event_id IS NULL AND command_id IS NULL
            )`,
      ).bind(eventId, revision, deletionAuditId),
    ]);
  } catch {
    return json({ error: "Draft deletion conflicted with another update. Refresh and try again." }, 409);
  }
  if (results[0]?.meta.changes === 0 || results[1]?.meta.changes === 0 || results[4]?.meta.changes === 0) {
    return json({ error: "Draft deletion conflicted with another update. Refresh and try again." }, 409);
  }
  return new Response(null, { status: 204, headers });
};

const eventIdPattern = "([A-Za-z0-9_-]{1,128})";

export const handleEventOperations = async (
  request: Request,
  env: Env,
  actor: StaffActor,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/staff/events") {
    if (request.method === "GET") {
      const denied = requireAnyRole(actor, operationalRoles);
      return denied ?? listEvents(env);
    }
    if (request.method === "POST") return createEvent(request, env, actor);
    return null;
  }

  const configurationMatch = url.pathname.match(
    new RegExp(`^/api/v1/staff/events/${eventIdPattern}/configuration$`),
  );
  if (configurationMatch !== null && (request.method === "PATCH" || request.method === "PUT")) {
    return configureEvent(request, configurationMatch[1], env, actor);
  }

  const readinessMatch = url.pathname.match(
    new RegExp(`^/api/v1/staff/events/${eventIdPattern}/readiness$`),
  );
  if (readinessMatch !== null && request.method === "GET") {
    const denied = requireAnyRole(actor, raceReadRoles);
    return denied ?? eventReadiness(readinessMatch[1], env);
  }

  const lifecycleMatch = url.pathname.match(
    new RegExp(`^/api/v1/staff/events/${eventIdPattern}/(open-registration|close-registration|reopen-registration|start-round-one|start-final|complete|start-return-processing)$`),
  );
  if (lifecycleMatch !== null && request.method === "POST") {
    const action = lifecycleMatch[2] as LifecycleAction;
    return runLifecycleCommand(request, lifecycleMatch[1], lifecycleDefinitions[action], env, actor);
  }

  const detailMatch = url.pathname.match(new RegExp(`^/api/v1/staff/events/${eventIdPattern}$`));
  if (detailMatch !== null && detailMatch[1] !== "return-review") {
    if (request.method === "GET") {
      const denied = requireAnyRole(actor, operationalRoles);
      return denied ?? eventDetail(detailMatch[1], env);
    }
    if (request.method === "DELETE") return deleteDraft(request, detailMatch[1], env, actor);
  }
  return null;
};
