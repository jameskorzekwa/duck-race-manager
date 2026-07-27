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

// The complete lifecycle vocabulary. COMPLETED is terminal: results stay
// publicly visible until an administrator deletes the event outright.
type EventStatus =
  | "DRAFT"
  | "REGISTRATION_OPEN"
  | "REGISTRATION_CLOSED"
  | "ROUND_ONE"
  | "FINAL"
  | "COMPLETED";

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
  // Retired `POST_CLOSE_BALANCED` rows may still exist in a database that was
  // never migrated away from the default, so the column is read as a string and
  // only ever written as the single supported mode.
  heat_assignment_mode: "IMMEDIATE_FIXED";
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

export const eventSlugFromName = (name: string): string => {
  const source = name.trim().replace(/\s+/g, " ").normalize("NFKD");
  const slug = source
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  if (slug) return slug;

  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `event-${(hash >>> 0).toString(36)}`;
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

// Shape of an IANA zone identifier: one to three slash-separated components,
// each starting the identifier with a letter. This rejects offset forms such as
// "+05:00" that the formatter would otherwise accept.
const timezoneIdentifier = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

// The shape check alone still admits junk like "Foo/Bar", so the value is also
// offered to the runtime's zone database. Legacy links (US/Mountain,
// Asia/Calcutta) resolve there, so events stored before this check keep loading,
// and the accepted identifier is stored exactly as submitted rather than
// canonicalized, which keeps every stored value stable across deploys.
export const normalizedTimezone = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const timezone = value.trim();
  if (timezone.length === 0 || timezone.length > 64 || !timezoneIdentifier.test(timezone)) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    return null;
  }
  return timezone;
};

const canonicalFingerprint = (value: Record<string, unknown>): string => JSON.stringify(value);

// A heat is only worth racing with a real field in it, so round-one capacity
// starts at MINIMUM_HEAT_SIZE rather than at one. The database CHECK stays
// `> 0` on purpose: events configured before this rule keep loading, and a
// migration that deploys ahead of this Worker must stay compatible with the
// Worker still running when it lands.
const MINIMUM_HEAT_SIZE = 3;

// A roster is only a racing roster while every registration on it is ACTIVE.
// Withdrawal and disqualification leave the `heat_entries` row in place and are
// permitted while a heat is still an unlocked plan, so this predicate is what
// keeps a withdrawn participant from being locked onto a racing roster and read
// out by the announcer. The identical predicate appears in the readiness
// blocker, in the guarded start command, and in the automatic roster lock, so
// the preflight, the transition, and the lock can never disagree. The only
// interpolation is a fixed internal column name; every value stays bound.
const inactiveRosterEntryExists = (heatColumn: string): string => `EXISTS (
    SELECT 1 FROM heat_entries he
      JOIN race_entries re ON re.id = he.race_entry_id
      JOIN registrations r ON r.id = re.registration_id
     WHERE he.heat_id = ${heatColumn} AND r.status != 'ACTIVE'
  )`;

const normalizedHeatCapacity = (value: unknown, minimum: number): number | null =>
  Number.isInteger(value) && (value as number) >= minimum && (value as number) <= 10_000
    ? value as number
    : null;

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
  const eventDate = normalizedDate(payload.eventDate, false);
  const ducksPerHeat = normalizedHeatCapacity(payload.roundOneHeatCapacity, MINIMUM_HEAT_SIZE);
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || name === null || eventDate === undefined || eventDate === null
    || ducksPerHeat === null
  ) {
    return json({
      error:
        `Command, event name, event date, and ducks per heat (a whole number from ${MINIMUM_HEAT_SIZE} to 10000) are required.`,
    }, 400);
  }
  // The console sends the operator's detected zone. An API caller that omits it
  // still falls back to the retained organization default.
  const timezone = payload.timezone === undefined ? null : normalizedTimezone(payload.timezone);
  if (payload.timezone !== undefined && timezone === null) {
    return json({ error: "Enter a valid IANA timezone." }, 400);
  }
  const slug = eventSlugFromName(name);
  const fingerprint = canonicalFingerprint({
    operation: "CREATE_EVENT",
    slug,
    name,
    eventDate,
    timezone,
    ducksPerHeat,
  });
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
  if (current !== null) return json({ error: "Delete the existing event before creating another." }, 409);
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
         SELECT ?, ?, ?, ?, COALESCE(?, d.timezone), 'DRAFT', NULL, NULL, d.email_required,
                'IMMEDIATE_FIXED', ?,
                d.final_heat_capacity, d.public_name_policy, 0, ?, ?
           FROM organization_event_defaults d
          WHERE d.singleton_id = 1
            AND NOT EXISTS (SELECT 1 FROM events)`,
      ).bind(eventId, slug, name, eventDate, timezone, ducksPerHeat, now, now),
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
        JSON.stringify({
          staff_profile_id: actor.id,
          command_id: commandId,
          slug,
          name,
          event_date: eventDate,
          timezone: timezone ?? defaults.timezone,
          round_one_heat_capacity: ducksPerHeat,
        }),
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
    timezone: timezone ?? defaults.timezone,
    status: "DRAFT",
    registration_opens_at: null,
    registration_closes_at: null,
    email_required: defaults.email_required,
    heat_assignment_mode: "IMMEDIATE_FIXED",
    round_one_heat_capacity: ducksPerHeat,
    final_heat_capacity: defaults.final_heat_capacity,
    public_name_policy: defaults.public_name_policy,
    revision: 0,
    created_at: now,
    updated_at: now,
  };
  return json({ event: eventResponse(event), replayed: false }, 201);
};

interface ConfigurationPatch {
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
  // Heats are filled as participants are paired with ducks. The retired
  // post-close balanced planner is gone, so the only mode an API caller may
  // name is the one the application implements.
  if ("heatAssignmentMode" in payload) {
    if (payload.heatAssignmentMode !== "IMMEDIATE_FIXED") {
      return { error: "Heats are assigned during duck pairing; there is no other heat assignment mode." };
    }
    patch.heatAssignmentMode = payload.heatAssignmentMode;
  }
  for (const key of ["roundOneHeatCapacity", "finalHeatCapacity"] as const) {
    if (key in payload) {
      const minimum = key === "roundOneHeatCapacity" ? MINIMUM_HEAT_SIZE : 1;
      const value = payload[key];
      if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > 10_000) {
        return { error: `${key} must be an integer between ${minimum} and 10000.` };
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
    slug: patch.name !== undefined && patch.name !== event.name
      ? eventSlugFromName(patch.name)
      : event.slug,
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
    // Never write the retired mode back, even if a legacy row still holds it.
    heatAssignmentMode: "IMMEDIATE_FIXED" as const,
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
  round_one_undersized_heat_count: number;
  round_one_inactive_roster_heat_count: number;
  final_inactive_roster_heat_count: number;
  locked_heat_count: number;
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
            AND (SELECT COUNT(*) FROM heat_entries he
                  WHERE he.heat_id = h.id) < ${MINIMUM_HEAT_SIZE}) AS round_one_undersized_heat_count,
        (SELECT COUNT(*) FROM heats h
          WHERE h.event_id = e.id AND h.round = 'ROUND_ONE'
            AND ${inactiveRosterEntryExists("h.id")}) AS round_one_inactive_roster_heat_count,
        (SELECT COUNT(*) FROM heats h
          WHERE h.event_id = e.id AND h.round = 'FINAL'
            AND ${inactiveRosterEntryExists("h.id")}) AS final_inactive_roster_heat_count,
        (SELECT COUNT(*) FROM heats h
          WHERE h.event_id = e.id
            AND (h.status != 'PLANNED' OR h.roster_locked_at IS NOT NULL)) AS locked_heat_count,
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
            ))) AS final_missing_result_count
     FROM events e
     WHERE e.id = ?`,
  ).bind(eventId).first<ReadinessStats>();

type LifecycleAction =
  | "open-registration"
  | "close-registration"
  | "reopen-registration"
  | "start-round-one"
  | "start-final"
  | "complete";

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
      WHERE e.id = ? AND e.status = 'DRAFT' AND e.event_date IS NOT NULL
        AND e.round_one_heat_capacity >= 1`,
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
    // Heats are built as participants are paired, so existing heats are the
    // normal state at this point and never block a reopen. Round one not having
    // started is the real boundary, and `e.status = 'REGISTRATION_CLOSED'`
    // already enforces it. Every heat must still be an unlocked plan so the
    // tail split below can run against the roster-lock triggers.
    commandSql: `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
     SELECT ?, e.id, 'REOPEN_REGISTRATION', e.id, ?, ?, ?
       FROM events e
      WHERE e.id = ? AND e.status = 'REGISTRATION_CLOSED'
        AND NOT EXISTS (
          SELECT 1 FROM heats h
           WHERE h.event_id = e.id
             AND (h.status != 'PLANNED' OR h.roster_locked_at IS NOT NULL)
        )`,
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
        )
        AND NOT EXISTS (
          SELECT 1 FROM heats h
           WHERE h.event_id = e.id AND h.round = 'ROUND_ONE'
             AND (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) < ${MINIMUM_HEAT_SIZE}
        )
        AND NOT EXISTS (
          SELECT 1 FROM heats h
           WHERE h.event_id = e.id AND h.round = 'ROUND_ONE'
             AND ${inactiveRosterEntryExists("h.id")}
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
        )
        AND NOT EXISTS (
          SELECT 1 FROM heats h
           WHERE h.event_id = e.id AND h.round = 'FINAL'
             AND ${inactiveRosterEntryExists("h.id")}
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
};

const hasCompletedLifecycleTransition = async (
  eventId: string,
  definition: LifecycleDefinition,
  fingerprint: string,
  env: Env,
): Promise<boolean> => {
  const command = await env.DB.prepare(
    `SELECT rc.id
       FROM race_commands rc
      WHERE rc.event_id = ?
        AND rc.command_type = ?
        AND rc.result_id = ?
        AND rc.request_fingerprint = ?
        AND rc.rowid = (
          SELECT MAX(candidate.rowid)
            FROM race_commands candidate
           WHERE candidate.event_id = rc.event_id
             AND candidate.command_type IN (
               'OPEN_REGISTRATION', 'CLOSE_REGISTRATION', 'REOPEN_REGISTRATION',
               'START_ROUND_ONE', 'START_FINAL', 'COMPLETE_EVENT',
               'REOPEN_HEAT_RESULT'
             )
        )
      LIMIT 1`,
  ).bind(eventId, definition.commandType, eventId, fingerprint).first<{ id: string }>();
  return command !== null;
};

const lifecycleResponse = (
  event: EventRow,
  definition: LifecycleDefinition,
  replayed: boolean,
  transitioned: boolean,
  status = 200,
): Response => json({
  event: eventResponse(event),
  replayed,
  transitioned,
  alreadyAtTarget: !transitioned && event.status === definition.to,
}, status);

const resolveLifecycleRace = async (
  commandId: string,
  eventId: string,
  fingerprint: string,
  definition: LifecycleDefinition,
  env: Env,
): Promise<Response | null> => {
  const command = await findCommand(commandId, env);
  if (command !== null) {
    if (
      command.event_id !== eventId
      || command.command_type !== definition.commandType
      || command.request_fingerprint !== fingerprint
    ) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const event = await getEvent(eventId, env);
    return event === null
      ? json({ error: "Event not found." }, 404)
      : lifecycleResponse(event, definition, true, false);
  }

  const event = await getEvent(eventId, env);
  if (
    event !== null
    && event.status === definition.to
    && await hasCompletedLifecycleTransition(eventId, definition, fingerprint, env)
  ) {
    return lifecycleResponse(event, definition, false, false);
  }
  return null;
};

const safelyResolveLifecycleRace = async (
  commandId: string,
  eventId: string,
  fingerprint: string,
  definition: LifecycleDefinition,
  env: Env,
): Promise<Response | null> => {
  try {
    return await resolveLifecycleRace(commandId, eventId, fingerprint, definition, env);
  } catch {
    return null;
  }
};

// Names the remedy an operator can actually reach: while the round has not
// started, its heats are still unlocked plans and `PUT /heats/:id/roster`
// accepts a replacement roster, so the fix is to rewrite the affected roster
// without the withdrawn racer.
const inactiveRosterBlocker = (heatCount: number, round: string): string =>
  `${heatCount === 1 ? "A heat" : `${heatCount} heats`} in ${round} still `
  + `${heatCount === 1 ? "has" : "have"} a withdrawn or disqualified racer on the roster. `
  + "Replace that roster before starting, so no inactive racer is locked in or announced.";

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
      if (!Number.isInteger(event.round_one_heat_capacity) || event.round_one_heat_capacity < 1) {
        blockers.push("Set how many ducks race in each heat before opening registration, so ducks can be assigned to heats as they are paired.");
      }
      break;
    case "reopen-registration":
      // Heats existing is not a blocker: they are built as participants are
      // paired, and a reopened registration simply fills the next free spot.
      // Only a heat that has already left its unlocked plan blocks a reopen,
      // which cannot happen before round one starts.
      if (stats.locked_heat_count > 0) {
        blockers.push("Heat rosters are already locked for racing, so registration can no longer reopen.");
      }
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
      if (stats.round_one_undersized_heat_count > 0) {
        blockers.push(
          `A heat cannot be raced with fewer than ${MINIMUM_HEAT_SIZE} ducks. Reopen registration and sign up more participants.`,
        );
      }
      if (stats.round_one_heat_count > event.final_heat_capacity) {
        blockers.push("Round-one heat count cannot exceed final capacity.");
      }
      if (stats.round_one_inactive_roster_heat_count > 0) {
        blockers.push(inactiveRosterBlocker(stats.round_one_inactive_roster_heat_count, "round one"));
      }
      if (stats.round_one_unready_heat_count > 0) blockers.push("Round-one heats must not have started.");
      break;
    case "start-final":
      if (stats.round_one_finalized_heat_count === 0) blockers.push("At least one round-one heat must be finalized.");
      if (stats.round_one_unfinished_heat_count > 0) blockers.push("Every round-one heat must be finalized or cancelled.");
      if (stats.round_one_missing_result_count > 0) blockers.push("Every finalized round-one heat needs a winning result.");
      if (stats.final_heat_count === 0 || stats.final_entry_count === 0) blockers.push("Create the final and promote finalists first.");
      if (stats.final_inactive_roster_heat_count > 0) {
        blockers.push(inactiveRosterBlocker(stats.final_inactive_roster_heat_count, "the final"));
      }
      if (stats.final_unready_heat_count > 0) blockers.push("Final heats must not have started.");
      break;
    case "complete":
      if (stats.final_finalized_heat_count === 0) blockers.push("At least one final heat must be finalized.");
      if (stats.final_unfinished_heat_count > 0) blockers.push("Every final heat must be finalized or cancelled.");
      if (stats.final_missing_result_count > 0) blockers.push("Every finalized final heat needs a complete podium result.");
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

// ---------------------------------------------------------------------------
// Round-one tail rebalancing
// ---------------------------------------------------------------------------
//
// A heat of one or two ducks is not a race, so closing registration folds a
// short tail into the heat before it, deliberately taking that heat over its
// capacity, and reopening registration splits the borrowed slots back out.
//
// Both operations are fixpoint loops, not single passes, because one pass is
// not enough. Pairing keeps running through REGISTRATION_CLOSED and starts a
// fresh short heat behind an already merged one, so a close/reopen cycle
// reaches layouts such as 10 + 1 + 1 where folding only the last heat still
// leaves a heat below the minimum. `closeRegistration` therefore repeats:
//
//   while some round-one heat holds fewer than MINIMUM_HEAT_SIZE entries and
//   more than one heat remains, fold the last heat into the heat before it.
//
// Termination: every pass deletes exactly one heat, so at most `heats - 1`
// passes run. Postcondition: the loop can only exit with no short heat left, or
// with a single heat holding every entry. A single heat is short only when the
// event has fewer than MINIMUM_HEAT_SIZE entries in total, which no layout can
// fix; that is precisely the "cannot run" state the round-one readiness blocker
// reports, with reopening registration as its remedy. So closing registration
// yields a layout where every round-one heat is raceable whenever the total
// makes that possible.
//
// `heats.target_size` records how many slots a heat owns. Pairing creates every
// heat with `target_size = events.round_one_heat_capacity` and never inserts
// past it, and the manual roster replacement rewrites `target_size` to the
// roster it just wrote, so outside a merge a round-one roster is always exactly
// `target_size` or smaller. A merge is therefore the only way a heat can hold
// more entries than its own `target_size`, which makes that comparison a
// complete and self-describing merge marker with no extra state. Comparing
// against the heat's own `target_size` rather than the event capacity is what
// keeps the marker correct when pairing continues after registration closed and
// starts a fresh short heat behind the merged one.
//
// A merge chain overwrites markers rather than stacking them: each pass records
// the receiving heat's pre-merge roster and then deletes the heat it emptied,
// so at every moment at most one heat is over its own `target_size`, and a
// nested merge leaves one marker rather than two. The split is the mirrored
// fixpoint loop over exactly that marker:
//
//   while some round-one heat holds more entries than its own `target_size`,
//   move the entries past `target_size` into a new last heat that owns a full
//   capacity of slots, and give the source its capacity back.
//
// Termination: a pass moves `m = entries - target_size` rows out of a heat
// holding `entries`, leaving a heat of `target_size` and creating one of `m`,
// both measured against `round_one_heat_capacity >= 1`; the total overflow past
// capacity therefore strictly decreases every pass, so the loop ends. The
// split restores a layout with the same entries in the same order and no heat
// over capacity. It does not always reproduce the exact pre-close layout: after
// a two-pass merge the intermediate heat's marker was deleted with it, so
// 10 + 1 + 1 reopens as 10 + 2. That is deliberate and safe. The recovered
// layout is raceable, holds every participant once in slot order, and closing
// again converges on the same result, whereas remembering the chain would need
// schema for a distinction no operator can observe.
//
// Slot numbers stay contiguous from 1 on both sides of the operation: a merge
// appends at `max(slot) + 1`, and a split moves exactly the entries past
// `target_size` into slots 1..k. Contiguity is what lets pairing keep computing
// the next slot as `COUNT(*) + 1` without ever colliding with
// `UNIQUE (heat_id, slot_number)`.

interface HeatLayoutRow {
  id: string;
  heat_number: number;
  target_size: number | null;
  entry_count: number;
}

interface LayoutEntryRow {
  id: string;
  heat_id: string;
}

interface PlannedHeat {
  id: string;
  heatNumber: number;
  targetSize: number | null;
  entryIds: string[];
}

interface MergePlan {
  targetHeatId: string;
  targetHeatNumber: number;
  targetEntryCount: number;
  tailHeatId: string;
  tailHeatNumber: number;
  entryIds: string[];
}

// One read of every unlocked round-one heat with its roster in slot order. The
// planners below simulate their passes against this snapshot, because a batch
// is built before it runs; the guarded SQL each pass emits re-checks the same
// facts inside the transaction, so a snapshot that went stale writes nothing.
const readRoundOneLayout = async (eventId: string, env: Env): Promise<PlannedHeat[] | null> => {
  const heats = await env.DB.prepare(
    `SELECT h.id, h.heat_number, h.target_size,
            (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) AS entry_count
       FROM heats h
      WHERE h.event_id = ? AND h.round = 'ROUND_ONE'
        AND h.status = 'PLANNED' AND h.roster_locked_at IS NULL
      ORDER BY h.heat_number`,
  ).bind(eventId).all<HeatLayoutRow>();
  const entries = await env.DB.prepare(
    `SELECT he.id, he.heat_id FROM heat_entries he
       JOIN heats h ON h.id = he.heat_id
      WHERE he.event_id = ? AND he.round = 'ROUND_ONE'
        AND h.status = 'PLANNED' AND h.roster_locked_at IS NULL
      ORDER BY h.heat_number, he.slot_number`,
  ).bind(eventId).all<LayoutEntryRow>();
  const rosters = new Map<string, string[]>();
  for (const row of entries.results) {
    const roster = rosters.get(row.heat_id);
    if (roster === undefined) rosters.set(row.heat_id, [row.id]);
    else roster.push(row.id);
  }
  const layout = heats.results.map((heat) => ({
    id: heat.id,
    heatNumber: heat.heat_number,
    targetSize: heat.target_size,
    entryIds: rosters.get(heat.id) ?? [],
  }));
  // The two reads are not one snapshot. A disagreement means a concurrent
  // write landed between them, so no rebalance is planned at all and the
  // lifecycle transition proceeds untouched; readiness still refuses to start
  // an unrunnable layout, and the next close rebalances it.
  return layout.every((heat, index) => heat.entryIds.length === heats.results[index].entry_count)
    ? layout
    : null;
};

const planTailMerges = async (eventId: string, env: Env): Promise<MergePlan[]> => {
  const layout = await readRoundOneLayout(eventId, env);
  if (layout === null) return [];
  const plans: MergePlan[] = [];
  const state = layout.map((heat) => ({ ...heat, entryIds: [...heat.entryIds] }));
  while (state.length > 1 && state.some((heat) => heat.entryIds.length < MINIMUM_HEAT_SIZE)) {
    const tail = state[state.length - 1];
    const target = state[state.length - 2];
    // An empty heat holds no roster to fold, so there is nothing to move and
    // nothing this loop can improve. Stopping also keeps the loop finite when
    // an empty heat is the permanently short one.
    if (tail.entryIds.length === 0) break;
    plans.push({
      targetHeatId: target.id,
      targetHeatNumber: target.heatNumber,
      targetEntryCount: target.entryIds.length,
      tailHeatId: tail.id,
      tailHeatNumber: tail.heatNumber,
      entryIds: tail.entryIds,
    });
    // The next pass sees the rosters this pass will have written: the folded
    // entries keep their order behind the target's own, which is exactly the
    // slot order `mergeStatements` binds.
    target.entryIds = [...target.entryIds, ...tail.entryIds];
    state.pop();
  }
  return plans;
};

const mergeStatements = (
  plan: MergePlan,
  eventId: string,
  commandId: string,
  now: string,
  env: Env,
): D1PreparedStatement[] => {
  const plannedUnlocked = `h.event_id = ? AND h.round = 'ROUND_ONE'
    AND h.status = 'PLANNED' AND h.roster_locked_at IS NULL`;
  const plannedUnlockedSelf = `heats.event_id = ? AND heats.round = 'ROUND_ONE'
    AND heats.status = 'PLANNED' AND heats.roster_locked_at IS NULL`;
  const commandCommitted = `EXISTS (
    SELECT 1 FROM race_commands rc
     WHERE rc.id = ? AND rc.event_id = ? AND rc.command_type = 'CLOSE_REGISTRATION'
  )`;
  const statements: D1PreparedStatement[] = [
    // Claim the target's slots by recording the roster it owned before the
    // merge. The CASE collapses to 0 when the target gained or lost an entry
    // since the plan was read, and `CHECK (target_size IS NULL OR
    // target_size > 0)` then aborts the whole batch rather than letting the
    // bound slot numbers below land on a roster they no longer describe.
    env.DB.prepare(
      `UPDATE heats
          SET target_size = (
                SELECT CASE WHEN COUNT(*) = ? THEN COUNT(*) ELSE 0 END
                  FROM heat_entries he WHERE he.heat_id = heats.id
              ),
              revision = revision + 1, source_command_id = ?, updated_at = ?
        WHERE heats.id = ? AND ${plannedUnlockedSelf}
          AND ${commandCommitted}`,
    ).bind(
      plan.targetEntryCount,
      commandId,
      now,
      plan.targetHeatId,
      eventId,
      commandId,
      eventId,
    ),
  ];
  // Every move is a single fully bound row rather than a set update whose SET
  // expression would re-read rows it had already written. A pass folds the last
  // heat, which pairing keeps at or under capacity, so the row count per pass is
  // bounded by `round_one_heat_capacity` and is one or two in every layout
  // pairing produces.
  for (const [index, entryId] of plan.entryIds.entries()) {
    statements.push(env.DB.prepare(
      `UPDATE heat_entries
          SET heat_id = ?, slot_number = ?, source_command_id = ?
        WHERE id = ? AND event_id = ? AND heat_id = ?
          AND EXISTS (SELECT 1 FROM heats h WHERE h.id = ? AND ${plannedUnlocked})
          AND ${commandCommitted}`,
    ).bind(
      plan.targetHeatId,
      plan.targetEntryCount + index + 1,
      commandId,
      entryId,
      eventId,
      plan.tailHeatId,
      plan.targetHeatId,
      eventId,
      commandId,
      eventId,
    ));
  }
  // The emptied tail heat is removed last. `heat_entries` references `heats`
  // ON DELETE RESTRICT, so if any move above did not apply the leftover row
  // aborts this delete and rolls the entire batch back; the merge can never
  // half-commit.
  statements.push(env.DB.prepare(
    `DELETE FROM heats
      WHERE heats.id = ? AND ${plannedUnlockedSelf}
        AND ${commandCommitted}`,
  ).bind(plan.tailHeatId, eventId, commandId, eventId));
  return statements;
};

interface HeatCapacityRow {
  round_one_heat_capacity: number;
  final_heat_capacity: number;
}

interface SplitPlan {
  sourceHeatId: string;
  sourceTargetSize: number;
  newHeatId: string;
  newHeatNumber: number;
  capacity: number;
  entryIds: string[];
}

const planTailSplits = async (eventId: string, env: Env): Promise<SplitPlan[]> => {
  const capacities = await env.DB.prepare(
    "SELECT round_one_heat_capacity, final_heat_capacity FROM events WHERE id = ?",
  ).bind(eventId).first<HeatCapacityRow>();
  if (capacities === null) return [];
  const layout = await readRoundOneLayout(eventId, env);
  if (layout === null) return [];

  const plans: SplitPlan[] = [];
  const state = layout.map((heat) => ({ ...heat, entryIds: [...heat.entryIds] }));
  let nextHeatNumber = state.reduce((highest, heat) => Math.max(highest, heat.heatNumber), 0) + 1;
  for (;;) {
    // Round-one heats can never outnumber what the final can hold, so a split
    // that would break that invariant is simply not planned; the guarded insert
    // below enforces the same rule against a concurrent pairing. Leaving the
    // borrowed slots in place keeps the reopen available as an escape hatch,
    // and the next close folds the layout back together.
    if (state.length >= capacities.final_heat_capacity) break;
    const source = state.find((heat) => heat.targetSize !== null && heat.entryIds.length > heat.targetSize);
    if (source === undefined) break;
    const targetSize = source.targetSize as number;
    const moved = source.entryIds.slice(targetSize);
    const plan = {
      sourceHeatId: source.id,
      sourceTargetSize: targetSize,
      newHeatId: crypto.randomUUID(),
      newHeatNumber: nextHeatNumber,
      capacity: capacities.round_one_heat_capacity,
      entryIds: moved,
    };
    plans.push(plan);
    nextHeatNumber += 1;
    // The source keeps the slots it owned and gets a full capacity of slots
    // back, exactly as `splitStatements` writes it, and the replacement heat
    // owns a capacity of slots too. Both are what the next pass measures.
    source.entryIds = source.entryIds.slice(0, targetSize);
    source.targetSize = capacities.round_one_heat_capacity;
    state.push({
      id: plan.newHeatId,
      heatNumber: plan.newHeatNumber,
      targetSize: capacities.round_one_heat_capacity,
      entryIds: moved,
    });
  }
  return plans;
};

const splitStatements = (
  plan: SplitPlan,
  eventId: string,
  commandId: string,
  now: string,
  env: Env,
): D1PreparedStatement[] => {
  const commandCommitted = `EXISTS (
    SELECT 1 FROM race_commands rc
     WHERE rc.id = ? AND rc.event_id = ? AND rc.command_type = 'REOPEN_REGISTRATION'
  )`;
  const statements: D1PreparedStatement[] = [
    // The replacement heat only appears when the exact rows the plan intends to
    // move are still beyond `target_size`, and only while round-one heats still
    // fit inside the final's capacity, which is the same guard pairing puts on
    // its own heat insert so the invariant is never even transiently broken. If
    // the heat does not appear, the moves below point at a heat that does not
    // exist and the foreign key aborts the batch, so a split is all-or-nothing
    // without needing a post-commit repair.
    env.DB.prepare(
      `INSERT INTO heats (id, event_id, round, heat_number, status, target_size, source_command_id)
       SELECT ?, e.id, 'ROUND_ONE', ?, 'PLANNED', e.round_one_heat_capacity, ?
         FROM events e
        WHERE e.id = ?
          AND ${commandCommitted}
          AND (
            SELECT COUNT(*) FROM heat_entries he
             WHERE he.event_id = e.id AND he.heat_id = ? AND he.slot_number > ?
          ) = ?
          AND (
            SELECT COUNT(*) FROM heats h
             WHERE h.event_id = e.id AND h.round = 'ROUND_ONE'
          ) < e.final_heat_capacity
          AND EXISTS (
            SELECT 1 FROM heats source
             WHERE source.id = ? AND source.event_id = e.id AND source.round = 'ROUND_ONE'
               AND source.status = 'PLANNED' AND source.roster_locked_at IS NULL
          )`,
    ).bind(
      plan.newHeatId,
      plan.newHeatNumber,
      commandId,
      eventId,
      commandId,
      eventId,
      plan.sourceHeatId,
      plan.sourceTargetSize,
      plan.entryIds.length,
      plan.sourceHeatId,
    ),
    // Restore the slots the merge borrowed. Pairing reads the event capacity
    // rather than `target_size` when it looks for room, so putting the capacity
    // back keeps the merge marker honest for the next close.
    env.DB.prepare(
      `UPDATE heats
          SET target_size = ?, revision = revision + 1, source_command_id = ?, updated_at = ?
        WHERE heats.id = ? AND heats.event_id = ? AND heats.round = 'ROUND_ONE'
          AND heats.status = 'PLANNED' AND heats.roster_locked_at IS NULL
          AND ${commandCommitted}`,
    ).bind(
      plan.capacity,
      commandId,
      now,
      plan.sourceHeatId,
      eventId,
      commandId,
      eventId,
    ),
  ];
  for (const [index, entryId] of plan.entryIds.entries()) {
    statements.push(env.DB.prepare(
      `UPDATE heat_entries
          SET heat_id = ?, slot_number = ?, source_command_id = ?
        WHERE id = ? AND event_id = ? AND heat_id = ?
          AND ${commandCommitted}`,
    ).bind(
      plan.newHeatId,
      index + 1,
      commandId,
      entryId,
      eventId,
      plan.sourceHeatId,
      commandId,
      eventId,
    ));
  }
  return statements;
};

// Starting a round takes its rosters out of the operators' hands: every planned
// heat is locked and advanced to LOADING in the same guarded batch as the event
// transition, which is what replaces the retired manual lock-roster control.
// The retired manual lock refused a roster holding a non-ACTIVE registration,
// so this keeps that refusal: a heat with a withdrawn racer on it is never
// locked, which makes the whole transition fail rather than silently locking a
// stale roster, because the start command below carries the same predicate.
const lockRoundStatement = (
  round: "ROUND_ONE" | "FINAL",
  commandType: string,
  eventId: string,
  commandId: string,
  actorId: string,
  now: string,
  env: Env,
): D1PreparedStatement => env.DB.prepare(
  `UPDATE heats
      SET status = 'LOADING', roster_locked_at = ?, roster_locked_by_staff_profile_id = ?,
          revision = revision + 1, source_command_id = ?, updated_at = ?
    WHERE heats.event_id = ? AND heats.round = ? AND heats.status = 'PLANNED'
      AND heats.roster_locked_at IS NULL
      AND EXISTS (SELECT 1 FROM heat_entries he WHERE he.heat_id = heats.id)
      AND NOT ${inactiveRosterEntryExists("heats.id")}
      AND EXISTS (
        SELECT 1 FROM race_commands rc
         WHERE rc.id = ? AND rc.event_id = ? AND rc.command_type = ?
      )`,
).bind(now, actorId, commandId, now, eventId, round, commandId, eventId, commandType);

interface LifecycleSideEffects {
  statements: D1PreparedStatement[];
  audits: Record<string, unknown>[];
}

const lifecycleSideEffects = async (
  definition: LifecycleDefinition,
  eventId: string,
  commandId: string,
  now: string,
  env: Env,
  actor: StaffActor,
): Promise<LifecycleSideEffects> => {
  if (definition.action === "close-registration") {
    const plans = await planTailMerges(eventId, env);
    return {
      statements: plans.flatMap((plan) => mergeStatements(plan, eventId, commandId, now, env)),
      audits: plans.map((plan) => ({
        action: "ROUND_ONE_TAIL_MERGED",
        merged_heat_number: plan.tailHeatNumber,
        into_heat_number: plan.targetHeatNumber,
        moved_entry_count: plan.entryIds.length,
        resulting_roster_size: plan.targetEntryCount + plan.entryIds.length,
      })),
    };
  }
  if (definition.action === "reopen-registration") {
    const plans = await planTailSplits(eventId, env);
    return {
      statements: plans.flatMap((plan) => splitStatements(plan, eventId, commandId, now, env)),
      audits: plans.map((plan) => ({
        action: "ROUND_ONE_TAIL_SPLIT",
        restored_heat_number: plan.newHeatNumber,
        moved_entry_count: plan.entryIds.length,
      })),
    };
  }
  if (definition.action === "start-round-one" || definition.action === "start-final") {
    const round = definition.action === "start-round-one" ? "ROUND_ONE" : "FINAL";
    return {
      statements: [
        lockRoundStatement(round, definition.commandType, eventId, commandId, actor.id, now, env),
      ],
      audits: [{ action: "HEAT_ROSTERS_LOCKED", round }],
    };
  }
  return { statements: [], audits: [] };
};

const sideEffectAuditStatement = (
  audit: Record<string, unknown>,
  definition: LifecycleDefinition,
  eventId: string,
  commandId: string,
  actorId: string,
  now: string,
  env: Env,
): D1PreparedStatement => {
  // Heat numbers, roster sizes, and the round name only: no participant,
  // contact, or token material ever reaches an audit detail.
  const { action, ...details } = audit;
  return env.DB.prepare(
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
    String(action),
    eventId,
    now,
    JSON.stringify({ staff_profile_id: actorId, command_id: commandId, ...details }),
    commandId,
    eventId,
    definition.commandType,
  );
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
      : lifecycleResponse(replay, definition, true, false);
  }

  const event = await getEvent(eventId, env);
  if (event === null) return json({ error: "Event not found." }, 404);
  if (
    event.status === definition.to
    && await hasCompletedLifecycleTransition(eventId, definition, fingerprint, env)
  ) {
    return lifecycleResponse(event, definition, false, false);
  }
  const stats = await getReadinessStats(eventId, env);
  if (stats === null) return json({ error: "Event readiness could not be calculated." }, 409);
  const readiness = readinessFor(event, stats, definition);
  if (readiness.allowed !== true) return json({ error: "Event is not ready for this transition.", readiness }, 409);

  const now = new Date().toISOString();
  // Round-one tail rebalancing and automatic roster locking ride in the same
  // guarded batch as the status change, so the heats and the event status can
  // never disagree. Every added statement carries the same command-committed
  // guard as `updateSql`, so a transition that loses its race writes nothing.
  const sideEffects = await lifecycleSideEffects(definition, eventId, commandId, now, env, actor);
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(definition.commandSql).bind(commandId, now, now, fingerprint, eventId),
      env.DB.prepare(definition.updateSql).bind(now, eventId, commandId),
      ...sideEffects.statements,
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
      ...sideEffects.audits.map(
        (audit) => sideEffectAuditStatement(audit, definition, eventId, commandId, actor.id, now, env),
      ),
    ]);
  } catch {
    const resolved = await safelyResolveLifecycleRace(commandId, eventId, fingerprint, definition, env);
    return resolved
      ?? json({ error: "The event transition conflicted with another update. Refresh and try again." }, 409);
  }
  if (results[0]?.meta.changes === 0 || results[1]?.meta.changes === 0) {
    const resolved = await safelyResolveLifecycleRace(commandId, eventId, fingerprint, definition, env);
    return resolved
      ?? json({ error: "The event transition conflicted with another update. Refresh and try again." }, 409);
  }

  const transitioned: EventRow = {
    ...event,
    status: definition.to,
    revision: event.revision + 1,
    updated_at: now,
  };
  return lifecycleResponse(transitioned, definition, false, true, 201);
};

interface DraftSafetyRow {
  registration_count: number;
  race_entry_count: number;
  event_duck_count: number;
  duck_assignment_count: number;
  heat_count: number;
  heat_entry_count: number;
  heat_result_count: number;
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
    + safety.heat_result_count;
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

// Force delete removes the complete event dataset in any status. It is the one
// and only cleanup path: there is no readiness gate, purge claim, or physical
// reconciliation step, just an administrator confirming the event name. It does
// keep a single-dataset prerequisite: several statements below delete globally
// (ducks, duck tags, browser collections, audit events), which is safe only
// while this event is the only race dataset.
//
// Idempotency semantics: the whole batch deletes command history, audit rows,
// and the event itself, so a successful force delete leaves no replay record.
// A surviving race command with this identifier therefore always belongs to a
// different operation and returns 409. A well-formed retry against the now
// missing event returns a deterministic already-deleted success instead of a
// stored replay.
const forceDeleteEvent = async (
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
  const confirmName = payload?.confirmName;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !Number.isInteger(revision) || (revision as number) < 0
    || typeof confirmName !== "string" || confirmName.length === 0 || confirmName.length > 120
  ) {
    return json({ error: "Command, revision, and the typed event name are required." }, 400);
  }
  if (await findCommand(commandId, env) !== null) {
    return json({ error: "This command identifier was already used for another operation." }, 409);
  }

  const event = await getEvent(eventId, env);
  if (event === null) {
    return json({ deleted: true, alreadyDeleted: true });
  }
  if (event.revision !== revision) {
    return json({ error: "The event changed. Refresh before deleting it.", event: eventResponse(event) }, 409);
  }
  if (confirmName !== event.name) {
    return json({ error: "Type the exact event name to confirm permanent deletion." }, 422);
  }
  const otherEvent = await env.DB.prepare(
    "SELECT id FROM events WHERE id != ? LIMIT 1",
  ).bind(eventId).first<{ id: string }>();
  if (otherEvent !== null) {
    return json({ error: "Force delete requires this to be the only race dataset." }, 409);
  }

  const now = new Date().toISOString();
  const fingerprint = canonicalFingerprint({ operation: "FORCE_DELETE_EVENT", eventId, revision });
  // Every later statement is guarded so a stale-revision race deletes nothing.
  // The sentinel row is also what `heat_entries_delete_unlocked` looks for, so
  // a locked roster is deletable here and nowhere else.
  const sentinel = `EXISTS (
    SELECT 1 FROM race_commands
     WHERE id = ? AND event_id = ? AND command_type = 'FORCE_DELETE_EVENT'
  )`;
  const scoped = (table: string): D1PreparedStatement =>
    env.DB.prepare(`DELETE FROM ${table} WHERE event_id = ? AND ${sentinel}`)
      .bind(eventId, commandId, eventId);
  const global = (table: string): D1PreparedStatement =>
    env.DB.prepare(`DELETE FROM ${table} WHERE ${sentinel}`).bind(commandId, eventId);
  let results: D1Result<unknown>[];
  try {
    results = await env.DB.batch([
      // The sentinel insert re-checks the single-dataset invariant inside the
      // batch so the whole deletion no-ops if a second event appears between
      // preflight and commit; every later statement depends on the sentinel.
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
         SELECT ?, e.id, 'FORCE_DELETE_EVENT', e.id, ?, ?, ?
           FROM events e
          WHERE e.id = ? AND e.revision = ?
            AND NOT EXISTS (SELECT 1 FROM events WHERE id != ?)`,
      ).bind(commandId, now, now, fingerprint, eventId, revision, eventId),
      scoped("email_attempts"),
      scoped("email_notifications"),
      scoped("heat_result_history"),
      scoped("heat_results"),
      scoped("heat_entries"),
      scoped("heats"),
      scoped("duck_assignments"),
      scoped("event_ducks"),
      scoped("duck_inventory_events"),
      global("browser_collection_registrations"),
      global("browser_registration_collections"),
      // `duck_tags.supersedes_tag_id` is the only self-reference in this delete
      // set, and it is declared ON DELETE RESTRICT. Once a tag has been
      // replaced, the ACTIVE replacement still points at its RETIRED parent, so
      // the multi-row delete below hits the parent row while a child still
      // references it and SQLite aborts the whole batch. Clearing the column
      // for every row first drops all of those links at once, so it is
      // chain-safe at any replacement depth (t1 <- t2 <- t3) and cannot violate
      // `CHECK (supersedes_tag_id IS NULL OR supersedes_tag_id != id)`. It
      // carries the same sentinel guard as its neighbours and runs inside the
      // same batch, so a refused delete still leaves every link intact.
      env.DB.prepare(
        `UPDATE duck_tags SET supersedes_tag_id = NULL WHERE ${sentinel}`,
      ).bind(commandId, eventId),
      global("duck_tags"),
      global("ducks"),
      global("audit_events"),
      scoped("race_entries"),
      scoped("registrations"),
      // The last two statements clear the sentinel row itself, so they cannot
      // read it back. They re-check the sentinel insert's own condition
      // instead — the event still at the expected revision, and still the only
      // one. Nothing in this batch changes `events.revision` or creates an
      // event, and a D1 batch is a single transaction, so those statements fire
      // exactly when the sentinel insert did.
      env.DB.prepare(
        `DELETE FROM race_commands
          WHERE event_id = ?
            AND EXISTS (
              SELECT 1 FROM events e
               WHERE e.id = ? AND e.revision = ?
                 AND NOT EXISTS (SELECT 1 FROM events other WHERE other.id != ?)
            )`,
      ).bind(eventId, eventId, revision, eventId),
      env.DB.prepare(
        `DELETE FROM events
          WHERE id = ? AND revision = ?
            AND NOT EXISTS (SELECT 1 FROM events other WHERE other.id != ?)`,
      ).bind(eventId, revision, eventId),
    ]);
  } catch {
    return json({ error: "Event deletion did not complete. No partial deletion was accepted." }, 409);
  }
  if (results[0]?.meta.changes === 0 || results[results.length - 1]?.meta.changes === 0) {
    return json({ error: "Event deletion conflicted with another update. Refresh and try again." }, 409);
  }
  return json({ deleted: true, alreadyDeleted: false });
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
    new RegExp(`^/api/v1/staff/events/${eventIdPattern}/(open-registration|close-registration|reopen-registration|start-round-one|start-final|complete)$`),
  );
  if (lifecycleMatch !== null && request.method === "POST") {
    const action = lifecycleMatch[2] as LifecycleAction;
    return runLifecycleCommand(request, lifecycleMatch[1], lifecycleDefinitions[action], env, actor);
  }

  const forceDeleteMatch = url.pathname.match(
    new RegExp(`^/api/v1/staff/events/${eventIdPattern}/force-delete$`),
  );
  if (forceDeleteMatch !== null && request.method === "POST") {
    return forceDeleteEvent(request, forceDeleteMatch[1], env, actor);
  }

  const detailMatch = url.pathname.match(new RegExp(`^/api/v1/staff/events/${eventIdPattern}$`));
  if (detailMatch !== null) {
    if (request.method === "GET") {
      const denied = requireAnyRole(actor, operationalRoles);
      return denied ?? eventDetail(detailMatch[1], env);
    }
    if (request.method === "DELETE") return deleteDraft(request, detailMatch[1], env, actor);
  }
  return null;
};
