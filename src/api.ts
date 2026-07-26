import {
  hashToken,
  isCommandId,
  isPrivateToken,
  randomLookupCode,
  validateRegistration,
} from "./registration.ts";
import { registrationCookie } from "./browser-registrations.ts";
import type { Env, EventRecord, PublicRaceStatusRecord, RegistrationStatusRecord } from "./types.ts";

const apiHeaders = {
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
} as const;

const json = (value: unknown, status = 200, extraHeaders: HeadersInit = {}): Response =>
  Response.json(value, {
    status,
    headers: {
      ...apiHeaders,
      ...extraHeaders,
    },
  });

const getCurrentEvent = (env: Env): Promise<EventRecord | null> =>
  env.DB.prepare(
    `SELECT id, slug, name, event_date, timezone, status,
            registration_opens_at, registration_closes_at, email_required
       FROM events
      WHERE status IN (
        'REGISTRATION_OPEN',
        'REGISTRATION_CLOSED',
        'ROUND_ONE',
        'FINAL',
        'COMPLETED',
        'RETURN_PROCESSING'
      )
      ORDER BY CASE status
        WHEN 'REGISTRATION_OPEN' THEN 0
        WHEN 'REGISTRATION_CLOSED' THEN 1
        WHEN 'ROUND_ONE' THEN 2
        WHEN 'FINAL' THEN 3
        ELSE 5
      END,
      event_date IS NULL,
      event_date
      LIMIT 1`,
  ).first<EventRecord>();

const getOpenEvent = (env: Env, eventId: string): Promise<EventRecord | null> => {
  const now = new Date().toISOString();
  return env.DB.prepare(
    `SELECT id, slug, name, event_date, timezone, status,
            registration_opens_at, registration_closes_at, email_required
       FROM events
      WHERE id = ?
        AND status = 'REGISTRATION_OPEN'
        AND (registration_opens_at IS NULL OR registration_opens_at <= ?)
        AND (registration_closes_at IS NULL OR registration_closes_at > ?)
      LIMIT 1`,
  ).bind(eventId, now, now).first<EventRecord>();
};

const eventResponse = (event: EventRecord): Record<string, unknown> => ({
  id: event.id,
  slug: event.slug,
  name: event.name,
  eventDate: event.event_date,
  timezone: event.timezone,
  status: event.status,
  registrationOpensAt: event.registration_opens_at,
  registrationClosesAt: event.registration_closes_at,
  emailRequired: event.email_required === 1,
});

const publicStatusResponse = (status: PublicRaceStatusRecord): Record<string, unknown> => ({
  displayName: `${status.first_name} ${status.last_name}`,
  registrationStatus: status.registration_status,
  eventName: status.event_name,
  eventStatus: status.event_status,
  duckNumber: status.visible_number,
  assignedHeat: status.heat_number === null ? null : {
    round: status.round_type,
    number: status.heat_number,
    status: status.heat_status,
  },
  currentHeat: status.current_heat_number === null ? null : {
    round: status.current_heat_round,
    number: status.current_heat_number,
  },
  result: status.result_position === null && status.advanced !== 1 ? null : {
    position: status.result_position,
    advanced: status.advanced === 1,
  },
});

const statusSelect = `
  SELECT r.first_name, r.last_name, r.status AS registration_status,
         e.name AS event_name, e.status AS event_status,
         d.visible_number,
         h.round_type, h.heat_number, h.status AS heat_status,
         (SELECT running.heat_number
            FROM heats running
           WHERE running.event_id = e.id AND running.status = 'RUNNING'
           LIMIT 1) AS current_heat_number,
         (SELECT running.round_type
            FROM heats running
           WHERE running.event_id = e.id AND running.status = 'RUNNING'
           LIMIT 1) AS current_heat_round,
         he.result_position, he.advanced
    FROM registrations r
    JOIN events e ON e.id = r.event_id
    JOIN race_entries re ON re.registration_id = r.id
    LEFT JOIN duck_assignments da
      ON da.race_entry_id = re.id AND da.valid_to IS NULL
    LEFT JOIN ducks d ON d.id = da.duck_id
    LEFT JOIN heat_entries he
      ON he.race_entry_id = re.id
     AND he.id = (
       SELECT candidate.id
         FROM heat_entries candidate
         JOIN heats candidate_heat ON candidate_heat.id = candidate.heat_id
        WHERE candidate.race_entry_id = re.id
        ORDER BY CASE candidate_heat.round_type WHEN 'FINAL' THEN 0 ELSE 1 END,
                 CASE candidate_heat.status
                   WHEN 'RUNNING' THEN 0
                   WHEN 'CALLING' THEN 1
                   WHEN 'PLANNED' THEN 2
                   ELSE 3
                 END,
                 candidate_heat.heat_number DESC
        LIMIT 1
     )
    LEFT JOIN heats h ON h.id = he.heat_id`;

export const searchPublicStatuses = async (
  query: string,
  env: Env,
): Promise<PublicRaceStatusRecord[]> => {
  const normalized = query.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > 161) return [];
  const escaped = normalized.toLowerCase().replace(/[\\%_]/g, "\\$&");
  const result = await env.DB.prepare(
    `${statusSelect}
      WHERE e.status NOT IN ('DRAFT', 'ARCHIVED')
        AND lower(r.first_name || ' ' || r.last_name) LIKE '%' || ? || '%' ESCAPE '\\'
      ORDER BY r.last_name COLLATE NOCASE, r.first_name COLLATE NOCASE
      LIMIT 25`,
  ).bind(escaped).all<PublicRaceStatusRecord>();
  return result.results;
};

export const findDuckRaceStatus = async (
  token: string,
  env: Env,
): Promise<PublicRaceStatusRecord | null> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return null;
  return env.DB.prepare(
    `${statusSelect}
      JOIN duck_tags tag ON tag.duck_id = d.id
      WHERE tag.token = ?
        AND tag.status IN ('ACTIVE', 'RETIRED')
        AND da.valid_to IS NULL
        AND e.status NOT IN ('DRAFT', 'ARCHIVED')
      LIMIT 1`,
  ).bind(token).first<PublicRaceStatusRecord>();
};

interface TurnstileResult {
  success?: boolean;
  hostname?: string;
}

const verifyTurnstile = async (
  request: Request,
  responseToken: string,
  secret: string,
  expectedHostname: string,
  commandId: string,
): Promise<boolean> => {
  const body = new URLSearchParams({
    secret,
    response: responseToken,
    idempotency_key: commandId,
  });
  const remoteIp = request.headers.get("cf-connecting-ip");
  if (remoteIp !== null) body.set("remoteip", remoteIp);

  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
    });
    if (!response.ok) return false;
    const result = await response.json<TurnstileResult>();
    return result.success === true && result.hostname === expectedHostname;
  } catch {
    return false;
  }
};

interface RegistrationPayload {
  commandId?: unknown;
  privateToken?: unknown;
  eventId?: unknown;
  firstName?: unknown;
  lastName?: unknown;
  email?: unknown;
  phone?: unknown;
  emailNotificationsEnabled?: unknown;
  duckKeepPreference?: unknown;
  turnstileToken?: unknown;
  clientTimestamp?: unknown;
}

const registrationResponse = (
  request: Request,
  registrationId: string,
  lookupCode: string,
  privateToken: string,
  participantName: string,
  replayed: boolean,
): Response => {
  const privateStatusPath = `/r/${privateToken}`;
  return json({
    registrationId,
    status: "SUBMITTED",
    lookupCode,
    privateStatusPath,
    replayed,
  }, replayed ? 200 : 201, {
    "set-cookie": registrationCookie(request.headers.get("cookie"), {
      name: participantName,
      lookupCode,
      statusPath: privateStatusPath,
    }),
  });
};

const createRegistration = async (request: Request, env: Env): Promise<Response> => {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 16_384) {
    return json({ error: "Request body is too large." }, 413);
  }

  const expectedOrigin = new URL(env.APP_ORIGIN);
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== expectedOrigin.origin) {
    return json({ error: "Cross-origin registration requests are not allowed." }, 403);
  }

  let payload: RegistrationPayload;
  try {
    const body = await request.text();
    if (body.length > 16_384) return json({ error: "Request body is too large." }, 413);
    payload = JSON.parse(body) as RegistrationPayload;
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  if (
    typeof payload.eventId !== "string"
    || typeof payload.commandId !== "string"
    || typeof payload.privateToken !== "string"
    || !isCommandId(payload.commandId)
    || !isPrivateToken(payload.privateToken)
  ) {
    return json({ error: "Invalid event, command, or private token." }, 400);
  }

  const tokenHash = await hashToken(payload.privateToken);
  const previous = await env.DB.prepare(
    `SELECT c.result_id, r.lookup_code, r.private_token_hash,
            r.first_name, r.last_name
       FROM race_commands c
       JOIN registrations r ON r.id = c.result_id
      WHERE c.id = ? AND c.command_type = 'CREATE_REGISTRATION'`,
  ).bind(payload.commandId).first<{
    result_id: string;
    lookup_code: string;
    private_token_hash: string;
    first_name: string;
    last_name: string;
  }>();
  if (previous !== null) {
    return previous.private_token_hash === tokenHash
      ? registrationResponse(
        request,
        previous.result_id,
        previous.lookup_code,
        payload.privateToken,
        `${previous.first_name} ${previous.last_name}`,
        true,
      )
      : json({ error: "Command identifier has already been used." }, 409);
  }

  const event = await getOpenEvent(env, payload.eventId);
  if (event === null) return json({ error: "Registration is not open for this event." }, 409);

  const form = new FormData();
  if (typeof payload.firstName === "string") form.set("first_name", payload.firstName);
  if (typeof payload.lastName === "string") form.set("last_name", payload.lastName);
  if (typeof payload.email === "string") form.set("email", payload.email);
  if (typeof payload.phone === "string") form.set("phone", payload.phone);
  if (payload.emailNotificationsEnabled === true) form.set("email_notifications_enabled", "on");
  if (typeof payload.duckKeepPreference === "string") {
    form.set("duck_keep_preference", payload.duckKeepPreference);
  }
  const validation = validateRegistration(form, event.email_required === 1);
  if (validation.value === undefined) {
    return json({ error: "Registration validation failed.", fields: validation.errors }, 422);
  }

  if (env.TURNSTILE_SECRET_KEY === undefined) {
    return json({ error: "Registration protection is not configured." }, 503);
  }
  if (typeof payload.turnstileToken !== "string" || payload.turnstileToken.length === 0) {
    return json({ error: "Anti-bot verification is required." }, 422);
  }
  if (!await verifyTurnstile(
    request,
    payload.turnstileToken,
    env.TURNSTILE_SECRET_KEY,
    expectedOrigin.hostname,
    payload.commandId,
  )) {
    return json({ error: "Anti-bot verification failed." }, 422);
  }

  const now = new Date().toISOString();
  const clientTimestamp = typeof payload.clientTimestamp === "string" && !Number.isNaN(Date.parse(payload.clientTimestamp))
    ? new Date(payload.clientTimestamp).toISOString()
    : now;
  const registrationId = crypto.randomUUID();
  const raceEntryId = crypto.randomUUID();
  const lookupCode = randomLookupCode();
  const value = validation.value;

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         VALUES (?, ?, 'CREATE_REGISTRATION', ?, ?, ?)`,
      ).bind(payload.commandId, event.id, registrationId, clientTimestamp, now),
      env.DB.prepare(
        `INSERT INTO registrations
          (id, event_id, first_name, last_name, email, phone, status, lookup_code,
           private_token_hash, email_notifications_enabled, created_via, submitted_at, status_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, 'SUBMITTED', ?, ?, ?, 'PUBLIC', ?, ?)`,
      ).bind(
        registrationId,
        event.id,
        value.firstName,
        value.lastName,
        value.email,
        value.phone,
        lookupCode,
        tokenHash,
        value.emailNotificationsEnabled ? 1 : 0,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO race_entries (id, event_id, registration_id, duck_keep_preference)
         VALUES (?, ?, ?, ?)`,
      ).bind(raceEntryId, event.id, registrationId, value.duckKeepPreference),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, 'REGISTRATION_CREATED', 'REGISTRATION', ?, 'PUBLIC', ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        event.id,
        payload.commandId,
        registrationId,
        now,
        JSON.stringify({ created_via: "PUBLIC", duck_keep_preference: value.duckKeepPreference }),
      ),
    ]);
  } catch {
    const replay = await env.DB.prepare(
      `SELECT c.result_id, r.lookup_code, r.private_token_hash,
              r.first_name, r.last_name
         FROM race_commands c
         JOIN registrations r ON r.id = c.result_id
        WHERE c.id = ? AND c.command_type = 'CREATE_REGISTRATION'`,
    ).bind(payload.commandId).first<{
      result_id: string;
      lookup_code: string;
      private_token_hash: string;
      first_name: string;
      last_name: string;
    }>();
    if (replay !== null && replay.private_token_hash === tokenHash) {
      return registrationResponse(
        request,
        replay.result_id,
        replay.lookup_code,
        payload.privateToken,
        `${replay.first_name} ${replay.last_name}`,
        true,
      );
    }
    return json({ error: "Registration could not be saved. Please retry with the same command identifier." }, 409);
  }

  return registrationResponse(
    request,
    registrationId,
    lookupCode,
    payload.privateToken,
    `${value.firstName} ${value.lastName}`,
    false,
  );
};

export const findRegistrationStatus = async (
  token: string,
  env: Env,
): Promise<RegistrationStatusRecord | null> => {
  if (!isPrivateToken(token)) return null;
  const tokenHash = await hashToken(token);
  return env.DB.prepare(
    `SELECT r.first_name, r.last_name, r.email, r.phone, r.status, r.lookup_code,
            r.submitted_at, e.name AS event_name, e.event_date,
            re.duck_keep_preference
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       JOIN race_entries re ON re.registration_id = r.id
       WHERE r.private_token_hash = ?`,
  ).bind(tokenHash).first<RegistrationStatusRecord>();
};

const getRegistrationStatus = async (token: string, env: Env): Promise<Response> => {
  const registration = await findRegistrationStatus(token, env);
  if (registration === null) return json({ error: "Not found." }, 404);

  return json({
    firstName: registration.first_name,
    lastName: registration.last_name,
    email: registration.email,
    phone: registration.phone,
    status: registration.status,
    lookupCode: registration.lookup_code,
    submittedAt: registration.submitted_at,
    eventName: registration.event_name,
    eventDate: registration.event_date,
    duckKeepPreference: registration.duck_keep_preference,
  });
};

export const handleApi = async (request: Request, env: Env): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === "/api/v1/events/current" && request.method === "GET") {
    const event = await getCurrentEvent(env);
    return event === null ? json({ event: null }) : json({ event: eventResponse(event) });
  }

  if (url.pathname === "/api/v1/registrations" && request.method === "POST") {
    return createRegistration(request, env);
  }

  const registrationMatch = url.pathname.match(/^\/api\/v1\/registrations\/([A-Za-z0-9_-]+)$/);
  if (registrationMatch !== null && request.method === "GET") {
    return getRegistrationStatus(registrationMatch[1], env);
  }

  const duckMatch = url.pathname.match(/^\/api\/v1\/ducks\/([A-Za-z0-9_-]+)$/);
  if (duckMatch !== null && request.method === "GET") {
    const status = await findDuckRaceStatus(duckMatch[1], env);
    return status === null ? json({ error: "Not found." }, 404) : json(publicStatusResponse(status));
  }

  if (url.pathname === "/api/v1/status/search" && request.method === "GET") {
    const query = url.searchParams.get("q") ?? "";
    const statuses = await searchPublicStatuses(query, env);
    return json({ results: statuses.map(publicStatusResponse) });
  }

  return json({ error: "Not found." }, 404);
};
