import type { StaffActor } from "./auth.ts";
import {
  hashToken,
  isCommandId,
  isPrivateToken,
  randomLookupCode,
  validateRegistration,
  type DuckKeepPreference,
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
  duck_keep_preference: DuckKeepPreference;
  race_entry_revision: number;
  assignment_id: string | null;
  assignment_valid_from: string | null;
  duck_id: string | null;
  duck_visible_number: number | null;
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
         re.duck_keep_preference, re.revision AS race_entry_revision,
         da.id AS assignment_id, da.valid_from AS assignment_valid_from,
         d.id AS duck_id, d.visible_number AS duck_visible_number
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
  duckKeepPreference: row.duck_keep_preference,
  notes: row.staff_notes,
  createdVia: row.created_via,
  submittedAt: row.submitted_at,
  statusChangedAt: row.status_changed_at,
  updatedAt: row.updated_at,
  revision: row.registration_revision,
  raceEntryRevision: row.race_entry_revision,
  assignment: row.assignment_id === null ? null : {
    id: row.assignment_id,
    assignedAt: row.assignment_valid_from,
    duck: {
      id: row.duck_id,
      visibleNumber: row.duck_visible_number,
    },
  },
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
  const preference = hasOwn(payload, "duckKeepPreference")
    ? payload.duckKeepPreference
    : current?.duck_keep_preference ?? "UNDECIDED";
  if (preference !== "KEEP" && preference !== "RETURN" && preference !== "UNDECIDED") {
    errors.duckKeepPreference = "Choose keep, return, or undecided.";
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
  form.set("duck_keep_preference", preference as string);
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
        `INSERT INTO race_entries (id, event_id, registration_id, duck_keep_preference)
         VALUES (?, ?, ?, ?)`,
      ).bind(raceEntryId, eventId, registrationId, value.input.duckKeepPreference),
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
    "duckKeepPreference",
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
  if (value.input.duckKeepPreference !== current.duck_keep_preference) changedFields.push("duck_keep_preference");
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
  if (value.input.duckKeepPreference !== current.duck_keep_preference) {
    statements.push(env.DB.prepare(
      `UPDATE race_entries
          SET duck_keep_preference = ?, updated_at = ?, revision = revision + 1
        WHERE id = ? AND revision = ?`,
    ).bind(value.input.duckKeepPreference, now, current.race_entry_id, current.race_entry_revision));
  }
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
  if ((operation === "reactivate" || operation === "disqualify") && !actor.isSystemAdmin) {
    return json({ error: "Administrator permission required." }, 403);
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
      ).bind(targetStatus, now, now, registrationId, expectedRevision, current.status),
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
    return listRegistrations(url, env, eventRegistrationsMatch[1]);
  }
  if (eventRegistrationsMatch !== null && request.method === "POST") {
    return createWalkUp(request, env, actor, eventRegistrationsMatch[1]);
  }

  const registrationMatch = url.pathname.match(
    /^\/api\/v1\/staff\/registrations\/([^/]{1,128})(?:\/(withdraw|reactivate|disqualify))?$/,
  );
  if (registrationMatch === null) return null;
  const [, registrationId, operation] = registrationMatch;
  if (registrationId === "search" && operation === undefined) return null;
  if (operation === undefined && request.method === "GET") {
    return detailRegistration(env, registrationId);
  }
  if (operation === undefined && request.method === "PATCH") {
    return editRegistration(request, env, actor, registrationId);
  }
  if (operation !== undefined && request.method === "POST") {
    return changeRegistrationStatus(request, env, actor, registrationId, operation as StatusOperation);
  }
  return null;
};
