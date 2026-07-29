import type { StaffActor } from "./auth.ts";
import { requireAnyRole } from "./authorization.ts";
import {
  hasSupportedDuckNameCharacters,
  isAllowedDuckName,
  publicDuckName,
} from "./duck-name-filter.ts";
import {
  cleanDuckName,
  DELETABLE_EVENT_STATUSES,
  DUCK_NAME_MAX_LENGTH,
  hashToken,
  isCommandId,
  isPrivateToken,
  randomLookupCode,
  registrationDeletionAuditStatement,
  registrationDeletionCommitted,
  registrationDeletionStatements,
  removableRegistrationSql,
  validateRegistration,
  type RegistrationInput,
} from "./registration.ts";
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
  if (Number.isFinite(length) && length > 16_384) return null;
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

interface EventRow {
  id: string;
  name: string;
  status: string;
  event_date: string | null;
  email_required: number;
  registration_opens_at: string | null;
  registration_closes_at: string | null;
}

interface RegistrationRow {
  registration_id: string;
  event_id: string;
  event_name: string;
  event_status: string;
  event_date: string | null;
  email_required: number;
  race_entry_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  status: string;
  lookup_code: string;
  private_token_hash: string;
  email_notifications_enabled: number;
  created_via: string;
  staff_notes: string | null;
  submitted_at: string;
  status_changed_at: string;
  updated_at: string;
  registration_revision: number;
  race_entry_revision: number;
  duck_name: string | null;
  assignment_id: string | null;
  assignment_valid_from: string | null;
  duck_id: string | null;
  duck_visible_number: number | null;
  is_deletable: number;
  heat_assignment_pending: number;
}

const registrationSelect = `
  SELECT r.id AS registration_id, r.event_id,
         e.name AS event_name, e.status AS event_status, e.event_date,
         e.email_required,
         re.id AS race_entry_id, r.first_name, r.last_name, r.email, r.phone,
         r.status, r.lookup_code, r.private_token_hash,
         r.email_notifications_enabled, r.created_via, r.staff_notes,
         r.submitted_at, r.status_changed_at, r.updated_at,
         r.revision AS registration_revision,
         re.revision AS race_entry_revision, re.duck_name,
         da.id AS assignment_id, da.valid_from AS assignment_valid_from,
         d.id AS duck_id, d.visible_number AS duck_visible_number,
         -- The exact predicate the delete endpoint re-checks inside its guarded
         -- write, so the console's Delete control and the write that follows it
         -- can never disagree about whether a participant is still removable.
         (${removableRegistrationSql}) AS is_deletable,
         -- "This race entry holds no place in any heat", stated exactly as the
         -- pairing response states it. A heat is a physical numbered bag, so
         -- this is the only thing that licenses a staff surface to say a duck
         -- is in one; without it the console would have to guess, and a wrong
         -- reason on a race-day panel is a lie a staffer acts on.
         (NOT EXISTS (
            SELECT 1 FROM heat_entries he WHERE he.race_entry_id = re.id
          )) AS heat_assignment_pending
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    JOIN race_entries re ON re.registration_id = r.id
    LEFT JOIN duck_assignments da
      ON da.race_entry_id = re.id AND da.valid_to IS NULL
    LEFT JOIN ducks d ON d.id = da.duck_id`;

const registrationJson = (row: RegistrationRow): Record<string, unknown> => ({
  registrationId: row.registration_id,
  eventId: row.event_id,
  raceEntryId: row.race_entry_id,
  firstName: row.first_name,
  lastName: row.last_name,
  email: row.email,
  phone: row.phone,
  status: row.status,
  lookupCode: row.lookup_code,
  emailNotificationsEnabled: row.email_notifications_enabled === 1,
  notes: row.staff_notes,
  createdVia: row.created_via,
  submittedAt: row.submitted_at,
  statusChangedAt: row.status_changed_at,
  updatedAt: row.updated_at,
  revision: row.registration_revision,
  raceEntryRevision: row.race_entry_revision,
  // Staff moderate this name, so they see exactly what is stored, plus whether
  // the read-time filter is already hiding it from the public surfaces. Both
  // fields require the same REGISTRATION/RACE_DIRECTOR access as the rest of
  // this projection, which already carries participant contact details.
  duckName: row.duck_name,
  duckNamePubliclyHidden: row.duck_name !== null && publicDuckName(row.duck_name) === null,
  assignment: row.assignment_id === null ? null : {
    id: row.assignment_id,
    assignedAt: row.assignment_valid_from,
    duck: {
      id: row.duck_id,
      visibleNumber: row.duck_visible_number,
    },
  },
  // The two lifecycle answers the console needs, stated explicitly rather than
  // inferred from `status` or from the shape of `assignment`.
  //
  // `currentlyPaired` is "a physical duck is in this participant's hands right
  // now": a duck assignment that is still open. It is exactly
  // `assignment !== null` and is deliberately independent of registration
  // status, because a reactivated participant is `SUBMITTED` while still
  // holding their duck, and a withdrawn one keeps theirs.
  //
  // `deletable` is the stricter question the Delete control must ask. A
  // participant whose duck was already unassigned still has an ended assignment
  // row and a heat place, so their duck went into a heat bag and the
  // registration can no longer be removed; they are withdrawn or disqualified
  // instead.
  currentlyPaired: row.assignment_id !== null,
  deletable: row.is_deletable === 1,
  // The third question, and the only one that decides whether a duck may be
  // described as sealed in a heat bag: a paired participant with no heat place
  // has a duck in their hands and no bag to put it in yet.
  heatAssignmentPending: row.heat_assignment_pending === 1,
});

const eventJson = (row: EventRow | RegistrationRow): Record<string, unknown> => ({
  id: "registration_id" in row ? row.event_id : row.id,
  name: "registration_id" in row ? row.event_name : row.name,
  status: "registration_id" in row ? row.event_status : row.status,
  eventDate: row.event_date,
});

const getRegistration = (env: Env, registrationId: string): Promise<RegistrationRow | null> =>
  env.DB.prepare(
    `${registrationSelect}
      WHERE r.id = ?
      LIMIT 1`,
  ).bind(registrationId).first<RegistrationRow>();

interface ExistingCommand {
  event_id: string;
  command_type: string;
  result_id: string | null;
}

const findCommand = (env: Env, commandId: string): Promise<ExistingCommand | null> =>
  env.DB.prepare(
    "SELECT event_id, command_type, result_id FROM race_commands WHERE id = ?",
  ).bind(commandId).first<ExistingCommand>();

const registrationResult = (
  row: RegistrationRow,
  replayed: boolean,
  status = 200,
  extra: Record<string, unknown> = {},
): Response => json({
  registration: registrationJson(row),
  event: eventJson(row),
  replayed,
  ...extra,
}, status);

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");

const listRegistrations = async (url: URL, env: Env, eventId: string): Promise<Response> => {
  const event = await env.DB.prepare(
    `SELECT id, name, status, event_date, email_required,
            registration_opens_at, registration_closes_at
       FROM events
      WHERE id = ?
      LIMIT 1`,
  ).bind(eventId).first<EventRow>();
  if (event === null) return json({ error: "Event not found." }, 404);

  const query = url.searchParams.get("q")?.trim() ?? "";
  const status = url.searchParams.get("status")?.trim().toUpperCase() || null;
  const createdVia = url.searchParams.get("createdVia")?.trim().toUpperCase() || null;
  const assignment = url.searchParams.get("assignment")?.trim().toUpperCase() || null;
  const limitValue = url.searchParams.get("limit");
  const limit = limitValue === null ? 100 : Number(limitValue);
  const statuses = ["SUBMITTED", "ACTIVE", "WITHDRAWN", "DISQUALIFIED"];
  if (
    query.length > 80
    || (status !== null && !statuses.includes(status))
    || (createdVia !== null && createdVia !== "PUBLIC" && createdVia !== "STAFF")
    || (assignment !== null && assignment !== "ASSIGNED" && assignment !== "UNASSIGNED")
    || !Number.isInteger(limit) || limit < 1 || limit > 200
  ) {
    return json({ error: "Invalid registration filters." }, 400);
  }

  const exactCode = query.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const like = `%${escapeLike(query)}%`;
  const result = await env.DB.prepare(
    `${registrationSelect}
      WHERE r.event_id = ?
        AND (? IS NULL OR r.status = ?)
        AND (? IS NULL OR r.created_via = ?)
        AND (
          ? IS NULL
          OR (? = 'ASSIGNED' AND da.id IS NOT NULL)
          OR (? = 'UNASSIGNED' AND da.id IS NULL)
        )
        AND (
          ? = ''
          OR r.lookup_code = ? COLLATE NOCASE
          OR r.first_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR r.last_name LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR (r.first_name || ' ' || r.last_name) LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR COALESCE(r.email, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
          OR COALESCE(r.phone, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
        )
      ORDER BY r.last_name COLLATE NOCASE, r.first_name COLLATE NOCASE, r.submitted_at
      LIMIT ?`,
  ).bind(
    eventId,
    status,
    status,
    createdVia,
    createdVia,
    assignment,
    assignment,
    assignment,
    query,
    exactCode,
    like,
    like,
    like,
    like,
    like,
    limit,
  ).all<RegistrationRow>();

  return json({
    event: eventJson(event),
    registrations: result.results.map(registrationJson),
  });
};

const detailRegistration = async (env: Env, registrationId: string): Promise<Response> => {
  const registration = await getRegistration(env, registrationId);
  return registration === null
    ? json({ error: "Registration not found." }, 404)
    : registrationResult(registration, false);
};

interface ValidatedParticipant {
  input: RegistrationInput;
  staffNotes: string | null;
}

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const validateParticipant = (
  payload: Record<string, unknown>,
  emailRequired: boolean,
  current?: RegistrationRow,
): { value?: ValidatedParticipant; errors: Record<string, string> } => {
  const errors: Record<string, string> = {};
  const stringFields = ["firstName", "lastName"] as const;
  const nullableStringFields = ["email", "phone", "notes"] as const;
  for (const field of stringFields) {
    if (hasOwn(payload, field) && typeof payload[field] !== "string") errors[field] = "Must be text.";
  }
  for (const field of nullableStringFields) {
    if (hasOwn(payload, field) && payload[field] !== null && typeof payload[field] !== "string") {
      errors[field] = "Must be text or null.";
    }
  }
  if (hasOwn(payload, "emailNotificationsEnabled") && typeof payload.emailNotificationsEnabled !== "boolean") {
    errors.emailNotificationsEnabled = "Must be true or false.";
  }
  const noteValue = hasOwn(payload, "notes") ? payload.notes : current?.staff_notes ?? null;
  const staffNotes = typeof noteValue === "string" ? noteValue.trim() || null : null;
  if (staffNotes !== null && staffNotes.length > 2000) errors.notes = "Use 2000 characters or fewer.";
  if (Object.keys(errors).length > 0) return { errors };

  const firstName = hasOwn(payload, "firstName") ? payload.firstName : current?.first_name;
  const lastName = hasOwn(payload, "lastName") ? payload.lastName : current?.last_name;
  const email = hasOwn(payload, "email") ? payload.email : current?.email;
  const phone = hasOwn(payload, "phone") ? payload.phone : current?.phone;
  const notifications = hasOwn(payload, "emailNotificationsEnabled")
    ? payload.emailNotificationsEnabled
    : current?.email_notifications_enabled === 1;
  const form = new FormData();
  if (typeof firstName === "string") form.set("first_name", firstName);
  if (typeof lastName === "string") form.set("last_name", lastName);
  if (typeof email === "string") form.set("email", email);
  if (typeof phone === "string") form.set("phone", phone);
  if (notifications === true) form.set("email_notifications_enabled", "on");
  const validation = validateRegistration(form, emailRequired);
  if (validation.value === undefined) return { errors: validation.errors };
  return { value: { input: validation.value, staffNotes }, errors };
};

const getOpenEvent = (env: Env, eventId: string, now: string): Promise<EventRow | null> =>
  env.DB.prepare(
    `SELECT id, name, status, event_date, email_required,
            registration_opens_at, registration_closes_at
       FROM events
      WHERE id = ?
        AND status = 'REGISTRATION_OPEN'
        AND (registration_opens_at IS NULL OR registration_opens_at <= ?)
        AND (registration_closes_at IS NULL OR registration_closes_at > ?)
      LIMIT 1`,
  ).bind(eventId, now, now).first<EventRow>();

const createWalkUp = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  const privateToken = payload.privateToken;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || typeof privateToken !== "string" || !isPrivateToken(privateToken)
  ) {
    return json({ error: "A valid command and private token are required." }, 400);
  }

  const tokenHash = await hashToken(privateToken);
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    if (
      previous.event_id !== eventId
      || previous.command_type !== "CREATE_STAFF_REGISTRATION"
      || previous.result_id === null
    ) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getRegistration(env, previous.result_id);
    if (replay === null || replay.private_token_hash !== tokenHash) {
      return json({ error: "This command identifier does not match this registration." }, 409);
    }
    return registrationResult(replay, true, 200, { privateStatusPath: `/r/${privateToken}` });
  }

  const now = new Date().toISOString();
  const event = await getOpenEvent(env, eventId, now);
  if (event === null) return json({ error: "Walk-up registration is not open for this event." }, 409);
  const validation = validateParticipant(payload, event.email_required === 1);
  if (validation.value === undefined) {
    return json({ error: "Registration validation failed.", fields: validation.errors }, 422);
  }

  const registrationId = crypto.randomUUID();
  const raceEntryId = crypto.randomUUID();
  const lookupCode = randomLookupCode();
  const value = validation.value;
  const requestedAt = typeof payload.clientTimestamp === "string" && !Number.isNaN(Date.parse(payload.clientTimestamp))
    ? new Date(payload.clientTimestamp).toISOString()
    : now;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, id, 'CREATE_STAFF_REGISTRATION', ?, ?, ?
           FROM events
          WHERE id = ?
            AND status = 'REGISTRATION_OPEN'
            AND (registration_opens_at IS NULL OR registration_opens_at <= ?)
            AND (registration_closes_at IS NULL OR registration_closes_at > ?)`,
      ).bind(commandId, registrationId, requestedAt, now, eventId, now, now),
      env.DB.prepare(
        `INSERT INTO registrations
          (id, event_id, first_name, last_name, email, phone, status, lookup_code,
           private_token_hash, email_notifications_enabled, created_via, staff_notes,
           submitted_at, status_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, 'STAFF', ?, ?, ?)`,
      ).bind(
        registrationId,
        eventId,
        value.input.firstName,
        value.input.lastName,
        value.input.email,
        value.input.phone,
        lookupCode,
        tokenHash,
        value.input.emailNotificationsEnabled ? 1 : 0,
        value.staffNotes,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO race_entries (id, event_id, registration_id)
         VALUES (?, ?, ?)`,
      ).bind(raceEntryId, eventId, registrationId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, 'REGISTRATION_CREATED', 'REGISTRATION', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        commandId,
        registrationId,
        now,
        JSON.stringify({ staff_profile_id: actor.id, created_via: "STAFF" }),
      ),
    ]);
  } catch {
    const replayCommand = await findCommand(env, commandId);
    if (
      replayCommand?.event_id === eventId
      && replayCommand.command_type === "CREATE_STAFF_REGISTRATION"
      && replayCommand.result_id !== null
    ) {
      const replay = await getRegistration(env, replayCommand.result_id);
      if (replay !== null && replay.private_token_hash === tokenHash) {
        return registrationResult(replay, true, 200, { privateStatusPath: `/r/${privateToken}` });
      }
    }
    return json({ error: "Walk-up registration conflicted with another update. Retry with the same command." }, 409);
  }

  const created = await getRegistration(env, registrationId);
  if (created === null) return json({ error: "The saved registration could not be loaded." }, 500);
  return registrationResult(created, false, 201, { privateStatusPath: `/r/${privateToken}` });
};

const mutableEventStatuses = ["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL"];

const editRegistration = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  registrationId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  const expectedRevision = payload.expectedRevision;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !Number.isInteger(expectedRevision) || (expectedRevision as number) < 0
  ) {
    return json({ error: "A valid command and expected revision are required." }, 400);
  }
  const editableFields = [
    "firstName",
    "lastName",
    "email",
    "phone",
    "emailNotificationsEnabled",
    "notes",
  ];
  if (!editableFields.some((field) => hasOwn(payload, field))) {
    return json({ error: "At least one editable registration field is required." }, 400);
  }

  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    if (previous.command_type !== "UPDATE_REGISTRATION" || previous.result_id !== registrationId) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getRegistration(env, registrationId);
    return replay === null
      ? json({ error: "Registration not found." }, 404)
      : registrationResult(replay, true);
  }

  const current = await getRegistration(env, registrationId);
  if (current === null) return json({ error: "Registration not found." }, 404);
  if (!mutableEventStatuses.includes(current.event_status)) {
    return json({ error: "Participant details cannot be changed in this event state." }, 409);
  }
  if (current.registration_revision !== expectedRevision) {
    return json({ error: "Registration changed since it was loaded.", currentRevision: current.registration_revision }, 409);
  }
  const validation = validateParticipant(payload, current.email_required === 1, current);
  if (validation.value === undefined) {
    return json({ error: "Registration validation failed.", fields: validation.errors }, 422);
  }

  const value = validation.value;
  const changedFields: string[] = [];
  if (value.input.firstName !== current.first_name) changedFields.push("first_name");
  if (value.input.lastName !== current.last_name) changedFields.push("last_name");
  if (value.input.email !== current.email) changedFields.push("email");
  if (value.input.phone !== current.phone) changedFields.push("phone");
  if ((value.input.emailNotificationsEnabled ? 1 : 0) !== current.email_notifications_enabled) {
    changedFields.push("email_notifications_enabled");
  }
  if (value.staffNotes !== current.staff_notes) changedFields.push("staff_notes");

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at)
       SELECT ?, r.event_id, 'UPDATE_REGISTRATION', r.id, ?, ?
         FROM registrations r
         JOIN events e ON e.id = r.event_id
        WHERE r.id = ? AND r.revision = ?
          AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')`,
    ).bind(commandId, now, now, registrationId, expectedRevision),
    env.DB.prepare(
      `UPDATE registrations
          SET first_name = ?, last_name = ?, email = ?, phone = ?,
              email_notifications_enabled = ?, staff_notes = ?,
              updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?
          AND event_id IN (
            SELECT id FROM events
             WHERE status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')
          )`,
    ).bind(
      value.input.firstName,
      value.input.lastName,
      value.input.email,
      value.input.phone,
      value.input.emailNotificationsEnabled ? 1 : 0,
      value.staffNotes,
      now,
      registrationId,
      expectedRevision,
    ),
  ];
  statements.push(env.DB.prepare(
    `INSERT INTO audit_events
      (id, event_id, command_id, action, subject_type, subject_id,
       actor_type, occurred_at, details_json)
     VALUES (?, ?, ?, 'REGISTRATION_UPDATED', 'REGISTRATION', ?, 'STAFF', ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    current.event_id,
    commandId,
    registrationId,
    now,
    JSON.stringify({
      staff_profile_id: actor.id,
      changed_fields: changedFields,
      previous_revision: current.registration_revision,
      revision: current.registration_revision + 1,
    }),
  ));

  try {
    await env.DB.batch(statements);
  } catch {
    const replayCommand = await findCommand(env, commandId);
    if (replayCommand?.command_type === "UPDATE_REGISTRATION" && replayCommand.result_id === registrationId) {
      const replay = await getRegistration(env, registrationId);
      if (replay !== null) return registrationResult(replay, true);
    }
    return json({ error: "Registration changed during the update. Refresh and try again." }, 409);
  }
  const updated = await getRegistration(env, registrationId);
  return updated === null
    ? json({ error: "The saved registration could not be loaded." }, 500)
    : registrationResult(updated, false);
};

type StatusOperation = "withdraw" | "reactivate" | "disqualify";

// Withdrawal and disqualification are the only way to remove a paired
// participant from the race, and they are deliberately bookkeeping-only. The
// batch below writes exactly three things: the guarded command row, the
// registration status, and the audit event. It never closes the duck
// assignment, never deletes the heat entry, and never renumbers, rebalances, or
// reorders any heat, slot, or lane, because the duck is physically inside a
// sealed heat bag and re-sorting the bags would mean rescanning every duck.
//
// The duck therefore still floats down the water; it simply stops existing on
// every public surface (board, leaderboard, podium, name search, duck pages)
// and can never be recorded as a winner.
//
// Because the write disturbs nothing physical, it is available at every point in
// the event lifecycle the event-status gate admits: a heat that is PLANNED,
// LOADING, locked, READY, CALLING, RUNNING, AWAITING_RESULT, or FINALIZED is
// left byte for byte as it was. A non-`ACTIVE` roster entry is a normal,
// expected state — that duck rides in the bag and simply cannot win.
const statusConfiguration = {
  withdraw: {
    commandType: "WITHDRAW_REGISTRATION",
    action: "REGISTRATION_WITHDRAWN",
    allowedStatuses: ["SUBMITTED", "ACTIVE"],
  },
  reactivate: {
    commandType: "REACTIVATE_REGISTRATION",
    action: "REGISTRATION_REACTIVATED",
    allowedStatuses: ["WITHDRAWN", "DISQUALIFIED"],
  },
  disqualify: {
    commandType: "DISQUALIFY_REGISTRATION",
    action: "REGISTRATION_DISQUALIFIED",
    allowedStatuses: ["SUBMITTED", "ACTIVE"],
  },
} as const;

const changeRegistrationStatus = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  registrationId: string,
  operation: StatusOperation,
): Promise<Response> => {
  if (operation === "reactivate" || operation === "disqualify") {
    const denied = requireAnyRole(actor, ["RACE_DIRECTOR"]);
    if (denied !== null) return denied;
  }
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  const expectedRevision = payload.expectedRevision;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !Number.isInteger(expectedRevision) || (expectedRevision as number) < 0
  ) {
    return json({ error: "A valid command and expected revision are required." }, 400);
  }

  const configuration = statusConfiguration[operation];
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    if (previous.command_type !== configuration.commandType || previous.result_id !== registrationId) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getRegistration(env, registrationId);
    return replay === null
      ? json({ error: "Registration not found." }, 404)
      : registrationResult(replay, true);
  }

  const current = await getRegistration(env, registrationId);
  if (current === null) return json({ error: "Registration not found." }, 404);
  if (!mutableEventStatuses.includes(current.event_status)) {
    return json({ error: "Registration status cannot be changed in this event state." }, 409);
  }
  if (current.registration_revision !== expectedRevision) {
    return json({ error: "Registration changed since it was loaded.", currentRevision: current.registration_revision }, 409);
  }
  if (!(configuration.allowedStatuses as readonly string[]).includes(current.status)) {
    return json({ error: "This registration cannot make that status transition." }, 409);
  }
  // There is deliberately no heat guard here, and removing one from a guarded
  // batch is not something to do casually, so this records why the heat stopped
  // being protective.
  //
  // The old model refused withdrawal once the participant's heat was locked,
  // running, awaiting its result, or finalized, because a withdrawn racer had to
  // come off the roster and a locked roster is immovable. That model is gone.
  // The duck is sealed into a numbered heat bag at pairing, nobody unpacks a bag
  // on the bank, and heat entries may never be reordered because the only way to
  // identify a duck is to physically scan it. So the racer stays on the roster
  // forever and is merely ineligible to win.
  //
  // With nothing to remove, the heat's state protects nothing: this operation
  // writes only the command row, the registration status, and the audit event,
  // and a locked, running, or finalized heat is no more disturbed by it than a
  // planned one. Refusing here instead made the whole feature unreachable — a
  // racer paired into a locked heat could never leave, and one who left before
  // the lock stopped the race from starting at all.
  //
  // Every other guard stays exactly where it was: the event-status gate above,
  // the revision check, the allowed-transition check, command idempotency, and
  // the audit write. Eligibility to *win* is guarded separately and untouched,
  // in `winnerByTagCandidate`, `validateResultSet`, the selected-result SQL, and
  // the finish-line scan.
  //
  // Reactivation restores the status the participant would have had if they had
  // never left: `ACTIVE` while a current duck assignment still exists, otherwise
  // `SUBMITTED`. It reads the open assignment, never the ended one and never the
  // heat entry, so a participant whose duck was unassigned returns to the
  // pairing queue rather than pretending to still hold a duck.
  const targetStatus = operation === "withdraw"
    ? "WITHDRAWN"
    : operation === "disqualify"
    ? "DISQUALIFIED"
    : current.assignment_id === null ? "SUBMITTED" : "ACTIVE";
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, r.event_id, ?, r.id, ?, ?
           FROM registrations r
           JOIN events e ON e.id = r.event_id
           WHERE r.id = ? AND r.revision = ? AND r.status = ?
             AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')`,
      ).bind(
        commandId,
        configuration.commandType,
        now,
        now,
        registrationId,
        expectedRevision,
        current.status,
      ),
      env.DB.prepare(
        `UPDATE registrations
            SET status = ?, status_changed_at = ?, updated_at = ?, revision = revision + 1
           WHERE id = ? AND revision = ? AND status = ?
             AND event_id IN (
               SELECT id FROM events
                WHERE status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL')
             )`,
      ).bind(
        targetStatus, now, now, registrationId, expectedRevision, current.status,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, ?, 'REGISTRATION', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        current.event_id,
        commandId,
        configuration.action,
        registrationId,
        now,
        JSON.stringify({
          staff_profile_id: actor.id,
          previous_status: current.status,
          status: targetStatus,
          previous_revision: current.registration_revision,
          revision: current.registration_revision + 1,
        }),
      ),
    ]);
  } catch {
    const replayCommand = await findCommand(env, commandId);
    if (replayCommand?.command_type === configuration.commandType && replayCommand.result_id === registrationId) {
      const replay = await getRegistration(env, registrationId);
      if (replay !== null) return registrationResult(replay, true);
    }
    return json({ error: "Registration status conflicted with another update. Refresh and try again." }, 409);
  }
  const updated = await getRegistration(env, registrationId);
  return updated === null
    ? json({ error: "The saved registration could not be loaded." }, 500)
    : registrationResult(updated, false, 201);
};

// Staff removal of a registration that should never have existed. It is a real
// delete, not a status change, and it is available only while the participant
// has never been paired with a duck.
//
// The rule is physical, not bookkeeping. Pairing puts the duck into a heat bag,
// and on race day nobody is going to unpack a bag to find one duck again. So a
// participant who has been paired can no longer be deleted at all: they are
// withdrawn or disqualified instead, their duck stays exactly where it is, and
// every public surface simply stops showing them. An already-unassigned duck
// does not reopen this path either — the ended assignment row and the heat place
// both survive, and they are the evidence that this entry did enter the race.
//
// Both refusals are `409`, matching every other lifecycle/state conflict in this
// file (revision mismatch, event status, illegal status transition). The request
// is well formed and would have been accepted a moment earlier in the
// participant's life, so it is a state conflict rather than a `422` semantic
// failure of the submitted values.
//
// The guarded command insert re-checks both conditions inside the batch, so the
// preflight below only produces the message and the roster-lock trigger on
// `heat_entries` is never reachable from this path at all.
const deleteRegistration = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  registrationId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  const expectedRevision = payload.expectedRevision;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || !Number.isInteger(expectedRevision) || (expectedRevision as number) < 0
  ) {
    return json({ error: "A valid command and expected revision are required." }, 400);
  }

  // The registration is gone after a committed delete, so a retry is answered
  // from command history alone rather than by re-reading the subject.
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    return previous.command_type === "DELETE_REGISTRATION" && previous.result_id === registrationId
      ? json({ deleted: true, registrationId, replayed: true })
      : json({ error: "This command identifier was already used for another operation." }, 409);
  }

  const current = await getRegistration(env, registrationId);
  if (current === null) return json({ error: "Registration not found." }, 404);
  if (!(DELETABLE_EVENT_STATUSES as readonly string[]).includes(current.event_status)) {
    return json({ error: "Registrations cannot be deleted in this event state." }, 409);
  }
  if (current.registration_revision !== expectedRevision) {
    return json({ error: "Registration changed since it was loaded.", currentRevision: current.registration_revision }, 409);
  }

  const blocking = await env.DB.prepare(
    `SELECT EXISTS (
              SELECT 1 FROM duck_assignments da WHERE da.race_entry_id = ?
            ) AS has_assignment,
            EXISTS (
              SELECT 1 FROM heat_entries he WHERE he.race_entry_id = ?
            ) AS has_heat_entry`,
  ).bind(current.race_entry_id, current.race_entry_id).first<{
    has_assignment: number;
    has_heat_entry: number;
  }>();
  if (blocking?.has_assignment === 1) {
    return json({
      error: "This participant has been paired with a duck, so they can no longer be deleted. Their duck is already in a heat bag and stays there. Withdraw or disqualify them instead.",
    }, 409);
  }
  if (blocking?.has_heat_entry === 1) {
    return json({
      error: "This participant is on a heat roster, so they can no longer be deleted. The heat stays exactly as it is. Withdraw or disqualify them instead.",
    }, 409);
  }

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
         SELECT ?, r.event_id, 'DELETE_REGISTRATION', r.id, ?, ?, ?
           FROM registrations r
           JOIN events e ON e.id = r.event_id
           JOIN race_entries re ON re.registration_id = r.id
          WHERE r.id = ? AND r.revision = ?
            AND ${removableRegistrationSql}`,
      ).bind(commandId, now, now, actor.id, registrationId, expectedRevision),
      registrationDeletionAuditStatement(env, commandId, registrationId, "STAFF", now, {
        staff_profile_id: actor.id,
        created_via: current.created_via,
        previous_revision: current.registration_revision,
      }),
      ...registrationDeletionStatements(env, commandId, registrationId),
    ]);
  } catch {
    return json({ error: "Registration deletion conflicted with another update. Refresh and try again." }, 409);
  }

  return await registrationDeletionCommitted(env, commandId, registrationId)
    ? json({ deleted: true, registrationId, replayed: false })
    : json({ error: "Registration deletion conflicted with another update. Refresh and try again." }, 409);
};

// Staff naming of a duck, used at the desk for a participant who cannot do it
// themselves — a walk-up with no phone, or a device that lost its saved list.
//
// It writes through exactly the gates the public endpoint applies, in the same
// order, so a name staff can set is a name a participant could have set. The
// duck must already be paired: a name with no duck has nothing to label, and
// every surface that shows a name resolves it through the current assignment.
//
// The rejected text is never echoed, logged, or audited, exactly as on the
// public path.
//
// Like the public endpoint, this is last write wins and takes no expected
// revision. A duck name is one field that is visible the moment it is saved, so
// an overwrite is seen and corrected immediately; refusing the desk's save
// because the owner renamed the duck a second earlier would cost more than it
// protects. The command identifier is what makes a retry a replay.
const setDuckName = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  registrationId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  if (typeof commandId !== "string" || !isCommandId(commandId) || typeof payload.duckName !== "string") {
    return json({ error: "A valid command and duck name are required." }, 400);
  }
  const duckName = cleanDuckName(payload.duckName);
  if (duckName === null) {
    return json({
      error: `Enter a duck name of 1 to ${DUCK_NAME_MAX_LENGTH} characters.`,
    }, 422);
  }
  if (!hasSupportedDuckNameCharacters(duckName)) {
    return json({ error: "That duck name uses characters QuickDucks cannot show." }, 422);
  }
  if (!isAllowedDuckName(duckName)) {
    return json({ error: "That duck name cannot be shown on the public race board." }, 422);
  }

  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    if (previous.command_type !== "SET_DUCK_NAME" || previous.result_id !== registrationId) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getRegistration(env, registrationId);
    return replay === null
      ? json({ error: "Registration not found." }, 404)
      : registrationResult(replay, true);
  }

  const current = await getRegistration(env, registrationId);
  if (current === null) return json({ error: "Registration not found." }, 404);
  if (current.assignment_id === null) {
    return json({ error: "Pair a duck with this participant before naming it." }, 409);
  }

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      // Guarded on the assignment still being open, so a duck unpaired between
      // the preflight and the write cannot end up with a name.
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
         SELECT ?, r.event_id, 'SET_DUCK_NAME', r.id, ?, ?, ?
           FROM registrations r
           JOIN race_entries re ON re.registration_id = r.id
           JOIN duck_assignments da ON da.race_entry_id = re.id AND da.valid_to IS NULL
          WHERE r.id = ?`,
      ).bind(commandId, now, now, actor.id, registrationId),
      env.DB.prepare(
        `UPDATE race_entries
            SET duck_name = ?, updated_at = ?
          WHERE registration_id = ?
            AND EXISTS (
              SELECT 1 FROM race_commands rc
               WHERE rc.id = ? AND rc.command_type = 'SET_DUCK_NAME' AND rc.result_id = ?
            )`,
      ).bind(duckName, now, registrationId, commandId, registrationId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, rc.event_id, rc.id, 'DUCK_NAME_SET', 'REGISTRATION', rc.result_id, 'STAFF', ?, ?
           FROM race_commands rc
          WHERE rc.id = ? AND rc.command_type = 'SET_DUCK_NAME' AND rc.result_id = ?`,
      ).bind(
        crypto.randomUUID(),
        now,
        JSON.stringify({
          staff_profile_id: actor.id,
          changed_fields: ["duck_name"],
          named_via: "STAFF_DESK",
        }),
        commandId,
        registrationId,
      ),
    ]);
  } catch {
    return json({ error: "The duck name could not be saved. Refresh and try again." }, 409);
  }

  const updated = await getRegistration(env, registrationId);
  if (updated === null) return json({ error: "The saved registration could not be loaded." }, 500);
  return updated.duck_name === duckName
    ? registrationResult(updated, false)
    : json({ error: "The duck name could not be saved. Refresh and try again." }, 409);
};

// Staff moderation of a duck name. No filter is perfect and the name is shown
// publicly at a community event, so staff must be able to remove one that should
// never have been on the board.
//
// Clearing is separate from setting on purpose: it must never fail, so it
// applies none of the naming preconditions. The duck falls back to the canonical
// "Duck #N" on every surface, and the participant may name it again afterwards.
//
// No expected revision is required. Clearing is idempotent and always safe, and
// a moderation action must not fail because the owner renamed the duck a second
// earlier; the command identifier is what makes a retry a replay.
const clearDuckName = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  registrationId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  if (payload === null) return json({ error: "A valid JSON request is required." }, 400);
  const commandId = payload.commandId;
  if (typeof commandId !== "string" || !isCommandId(commandId)) {
    return json({ error: "A valid command is required." }, 400);
  }

  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    if (previous.command_type !== "CLEAR_DUCK_NAME" || previous.result_id !== registrationId) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getRegistration(env, registrationId);
    return replay === null
      ? json({ error: "Registration not found." }, 404)
      : registrationResult(replay, true);
  }

  const current = await getRegistration(env, registrationId);
  if (current === null) return json({ error: "Registration not found." }, 404);

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, actor_staff_profile_id)
         SELECT ?, r.event_id, 'CLEAR_DUCK_NAME', r.id, ?, ?, ?
           FROM registrations r
           JOIN race_entries re ON re.registration_id = r.id
          WHERE r.id = ?`,
      ).bind(commandId, now, now, actor.id, registrationId),
      env.DB.prepare(
        `UPDATE race_entries
            SET duck_name = NULL, updated_at = ?
          WHERE registration_id = ?
            AND EXISTS (
              SELECT 1 FROM race_commands rc
               WHERE rc.id = ? AND rc.command_type = 'CLEAR_DUCK_NAME' AND rc.result_id = ?
            )`,
      ).bind(now, registrationId, commandId, registrationId),
      // The audit records that a name was cleared and by whom. It never records
      // the offending text, and neither does the command row.
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, rc.event_id, rc.id, 'DUCK_NAME_CLEARED', 'REGISTRATION', rc.result_id, 'STAFF', ?, ?
           FROM race_commands rc
          WHERE rc.id = ? AND rc.command_type = 'CLEAR_DUCK_NAME' AND rc.result_id = ?`,
      ).bind(
        crypto.randomUUID(),
        now,
        JSON.stringify({
          staff_profile_id: actor.id,
          changed_fields: ["duck_name"],
          cleared_via: "STAFF_MODERATION",
          had_name: current.duck_name !== null,
        }),
        commandId,
        registrationId,
      ),
    ]);
  } catch {
    return json({ error: "The duck name could not be cleared. Refresh and try again." }, 409);
  }

  const updated = await getRegistration(env, registrationId);
  return updated === null
    ? json({ error: "The saved registration could not be loaded." }, 500)
    : registrationResult(updated, false);
};

export const handleParticipantOperations = async (
  request: Request,
  env: Env,
  actor: StaffActor,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const eventRegistrationsMatch = url.pathname.match(
    /^\/api\/v1\/staff\/events\/([^/]{1,128})\/registrations$/,
  );
  if (eventRegistrationsMatch !== null && request.method === "GET") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return listRegistrations(url, env, eventRegistrationsMatch[1]);
  }
  if (eventRegistrationsMatch !== null && request.method === "POST") {
    const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return createWalkUp(request, env, actor, eventRegistrationsMatch[1]);
  }

  const registrationMatch = url.pathname.match(
    /^\/api\/v1\/staff\/registrations\/([^/]{1,128})(?:\/(withdraw|reactivate|disqualify|set-duck-name|clear-duck-name))?$/,
  );
  if (registrationMatch === null) return null;
  const [, registrationId, operation] = registrationMatch;
  if (registrationId === "search" && operation === undefined) return null;
  const denied = requireAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);
  if (denied !== null) return denied;
  if (operation === undefined && request.method === "GET") {
    return detailRegistration(env, registrationId);
  }
  if (operation === undefined && request.method === "PATCH") {
    return editRegistration(request, env, actor, registrationId);
  }
  if (operation === undefined && request.method === "DELETE") {
    return deleteRegistration(request, env, actor, registrationId);
  }
  // Naming and clearing a duck name are both work at the registration desk, so
  // they are available to the same registration and race-director roles (and
  // administrators) that own the rest of this participant surface.
  if (operation === "set-duck-name" && request.method === "POST") {
    return setDuckName(request, env, actor, registrationId);
  }
  if (operation === "clear-duck-name" && request.method === "POST") {
    return clearDuckName(request, env, actor, registrationId);
  }
  if (operation !== undefined && request.method === "POST") {
    return changeRegistrationStatus(request, env, actor, registrationId, operation as StatusOperation);
  }
  return null;
};
