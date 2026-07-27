import {
  hashToken,
  isCommandId,
  isPrivateToken,
  randomLookupCode,
  validateRegistration,
} from "./registration.ts";
import { authenticateStaff } from "./auth.ts";
import {
  browserCollectionCookie,
  clearBrowserCollectionCookie,
  collectionStatements,
  getBrowserCollection,
  prepareBrowserCollection,
  refreshBrowserCollection,
} from "./browser-collection.ts";
import {
  getPublicStatusByRaceEntry,
  getPublicStatusByTag,
  type PublicRaceStatus,
} from "./race-status.ts";
import { handleDuckOperations } from "./duck-operations.ts";
import { handleEventOperations } from "./event-operations.ts";
import { handleHeatOperations } from "./heat-operations.ts";
import { handleParticipantOperations } from "./participant-operations.ts";
import { handleStaffApi } from "./staff-api.ts";
import { handleStaffLifecycleOperations } from "./staff-lifecycle-operations.ts";
import { handleSupportOperations } from "./support-operations.ts";
import {
  handleLiveConnection,
  mutationRefreshDomains,
  scheduleRaceUpdate,
} from "./live-updates.ts";
import { getPublicRaceBoard } from "./race-board.ts";
import type { Env, EventRecord, RegistrationStatusRecord } from "./types.ts";

const apiHeaders = {
  "cache-control": "no-store",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), nfc=(self)",
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
            registration_opens_at, registration_closes_at, email_required,
            public_name_policy
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
            registration_opens_at, registration_closes_at, email_required,
            public_name_policy
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
  publicNamePolicy: event.public_name_policy,
});

export const findDuckRaceStatus = async (
  token: string,
  env: Env,
): Promise<PublicRaceStatus | null> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return null;
  return getPublicStatusByTag(env, token);
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
  turnstileToken?: unknown;
  clientTimestamp?: unknown;
}

const registrationResponse = (
  registrationId: string,
  lookupCode: string,
  privateToken: string,
  replayed: boolean,
  browserToken: string,
): Response => json({
  registrationId,
  status: "SUBMITTED",
  lookupCode,
  privateStatusPath: `/r/${privateToken}`,
  replayed,
}, replayed ? 200 : 201, {
  "set-cookie": browserCollectionCookie(browserToken),
});

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
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "Request body must be a JSON object." }, 400);
    }
    payload = parsed as RegistrationPayload;
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
    `SELECT c.result_id, r.lookup_code, r.private_token_hash
       FROM race_commands c
       JOIN registrations r ON r.id = c.result_id
      WHERE c.id = ? AND c.command_type = 'CREATE_REGISTRATION'`,
  ).bind(payload.commandId).first<{
    result_id: string;
    lookup_code: string;
    private_token_hash: string;
  }>();
  if (previous !== null) {
    if (previous.private_token_hash !== tokenHash) {
      return json({ error: "Command identifier has already been used." }, 409);
    }
    const collection = await prepareBrowserCollection(request, env);
    await env.DB.batch(await collectionStatements(
      env,
      collection,
      previous.result_id,
      new Date().toISOString(),
    ));
    return registrationResponse(
      previous.result_id,
      previous.lookup_code,
      payload.privateToken,
      true,
      collection.cookieToken,
    );
  }

  const event = await getOpenEvent(env, payload.eventId);
  if (event === null) return json({ error: "Registration is not open for this event." }, 409);

  const form = new FormData();
  if (typeof payload.firstName === "string") form.set("first_name", payload.firstName);
  if (typeof payload.lastName === "string") form.set("last_name", payload.lastName);
  if (typeof payload.email === "string") form.set("email", payload.email);
  if (typeof payload.phone === "string") form.set("phone", payload.phone);
  if (payload.emailNotificationsEnabled === true) form.set("email_notifications_enabled", "on");
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
  const collection = await prepareBrowserCollection(request, env);

  try {
    const statements = [
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
        `INSERT INTO race_entries (id, event_id, registration_id)
         VALUES (?, ?, ?)`,
      ).bind(raceEntryId, event.id, registrationId),
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
        JSON.stringify({ created_via: "PUBLIC" }),
      ),
      ...await collectionStatements(env, collection, registrationId, now),
    ];
    await env.DB.batch(statements);
  } catch {
    const replay = await env.DB.prepare(
      `SELECT c.result_id, r.lookup_code, r.private_token_hash
         FROM race_commands c
         JOIN registrations r ON r.id = c.result_id
        WHERE c.id = ? AND c.command_type = 'CREATE_REGISTRATION'`,
    ).bind(payload.commandId).first<{
      result_id: string;
      lookup_code: string;
      private_token_hash: string;
    }>();
    if (replay !== null && replay.private_token_hash === tokenHash) {
      const replayCollection = await prepareBrowserCollection(request, env);
      await env.DB.batch(await collectionStatements(env, replayCollection, replay.result_id, now));
      return registrationResponse(
        replay.result_id,
        replay.lookup_code,
        payload.privateToken,
        true,
        replayCollection.cookieToken,
      );
    }
    return json({ error: "Registration could not be saved. Please retry with the same command identifier." }, 409);
  }

  return registrationResponse(
    registrationId,
    lookupCode,
    payload.privateToken,
    false,
    collection.cookieToken,
  );
};

export interface PrivateRegistrationStatus extends RegistrationStatusRecord {
  raceStatus: PublicRaceStatus | null;
}

export const findRegistrationStatus = async (
  token: string,
  env: Env,
): Promise<PrivateRegistrationStatus | null> => {
  if (!isPrivateToken(token)) return null;
  const tokenHash = await hashToken(token);
  const row = await env.DB.prepare(
    `SELECT r.first_name, r.last_name, r.status, r.lookup_code,
             r.submitted_at, e.name AS event_name, e.event_date,
             re.id AS race_entry_id
       FROM registrations r
       JOIN events e ON e.id = r.event_id
       JOIN race_entries re ON re.registration_id = r.id
       WHERE r.private_token_hash = ?`,
  ).bind(tokenHash).first<RegistrationStatusRecord & { race_entry_id: string }>();
  if (row === null) return null;
  const { race_entry_id: raceEntryId, ...registration } = row;
  return {
    ...registration,
    raceStatus: await getPublicStatusByRaceEntry(env, raceEntryId),
  };
};

const getRegistrationStatus = async (token: string, env: Env): Promise<Response> => {
  const registration = await findRegistrationStatus(token, env);
  if (registration === null) return json({ error: "Not found." }, 404);

  return json({
    firstName: registration.first_name,
    lastName: registration.last_name,
    status: registration.status,
    lookupCode: registration.lookup_code,
    submittedAt: registration.submitted_at,
    eventName: registration.event_name,
    eventDate: registration.event_date,
    raceStatus: registration.raceStatus,
  });
};

const getDuck = async (token: string, env: Env): Promise<Response> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return json({ destination: "HOME" });
  const status = await getPublicStatusByTag(env, token);
  return status === null
    ? json({ destination: "HOME" })
    : json({ destination: "RACE_STATUS", raceStatus: status });
};

const getMyRegistrations = async (request: Request, env: Env): Promise<Response> => {
  const existingCollection = await getBrowserCollection(request, env);
  if (existingCollection === null) {
    return json({ registrations: [] }, 200, {
      "set-cookie": clearBrowserCollectionCookie(),
    });
  }
  const collection = await refreshBrowserCollection(env, existingCollection);

  const registrations = await env.DB.prepare(
    `SELECT r.id AS registration_id, re.id AS race_entry_id,
            r.first_name, r.last_name, r.lookup_code, r.status,
            EXISTS (
              SELECT 1
                FROM duck_assignments da
               WHERE da.race_entry_id = re.id AND da.valid_to IS NULL
            ) AS is_paired
       FROM browser_collection_registrations bcr
       JOIN registrations r ON r.id = bcr.registration_id
       JOIN race_entries re ON re.registration_id = r.id
      WHERE bcr.collection_id = ?
      ORDER BY bcr.added_at`,
  ).bind(collection.id).all<{
    registration_id: string;
    race_entry_id: string;
    first_name: string;
    last_name: string;
    lookup_code: string;
    status: string;
    is_paired: number;
  }>();

  const items = await Promise.all(registrations.results.map(async (row) => ({
    registrationId: row.registration_id,
    firstName: row.first_name,
    lastName: row.last_name,
    lookupCode: row.lookup_code,
    registrationStatus: row.status,
    paired: row.is_paired === 1,
    raceStatus: await getPublicStatusByRaceEntry(env, row.race_entry_id),
  })));

  return json({ registrations: items }, 200, {
    "set-cookie": browserCollectionCookie(collection.cookieToken),
  });
};

const getMyRegistrationPresence = async (request: Request, env: Env): Promise<Response> => {
  const existingCollection = await getBrowserCollection(request, env);
  if (existingCollection === null) {
    return json({ hasRegistrations: false }, 200, {
      "set-cookie": clearBrowserCollectionCookie(),
    });
  }
  const collection = await refreshBrowserCollection(env, existingCollection);
  const registration = await env.DB.prepare(
    `SELECT 1 AS has_registration
       FROM browser_collection_registrations
      WHERE collection_id = ?
      LIMIT 1`,
  ).bind(collection.id).first<{ has_registration: number }>();
  return json({ hasRegistrations: registration !== null }, 200, {
    "set-cookie": browserCollectionCookie(collection.cookieToken),
  });
};

const searchPublicRaceStatus = async (request: Request, url: URL, env: Env): Promise<Response> => {
  const eventId = url.searchParams.get("eventId")?.trim() ?? "";
  const name = url.searchParams.get("name")?.trim().replace(/\s+/g, " ") ?? "";
  if (eventId.length === 0 || eventId.length > 128 || name.length < 2 || name.length > 161) {
    return json({ error: "Event and at least two name characters are required." }, 400);
  }
  const clientKey = request.headers.get("cf-connecting-ip") ?? "unknown-client";
  const rateLimit = await env.PUBLIC_SEARCH_RATE_LIMITER.limit({ key: `${eventId}:${clientKey}` });
  if (!rateLimit.success) return json({ error: "Too many searches. Please wait and try again." }, 429);
  const matches = await env.DB.prepare(
    `SELECT DISTINCT re.id AS race_entry_id
       FROM registrations r
       JOIN race_entries re ON re.registration_id = r.id
       JOIN events e ON e.id = r.event_id
      WHERE r.event_id = ?
        AND r.status IN ('SUBMITTED', 'ACTIVE')
        AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
        AND (
          r.first_name = ? COLLATE NOCASE
          OR r.last_name = ? COLLATE NOCASE
          OR (r.first_name || ' ' || r.last_name) = ? COLLATE NOCASE
        )
      ORDER BY r.last_name COLLATE NOCASE, r.first_name COLLATE NOCASE
      LIMIT 10`,
  ).bind(eventId, name, name, name).all<{ race_entry_id: string }>();

  const results = (await Promise.all(
    matches.results.map((row) => getPublicStatusByRaceEntry(env, row.race_entry_id)),
  )).filter((status) => status !== null);
  return json({ results });
};
const handleApiRequest = async (
  request: Request,
  env: Env,
  authenticate: typeof authenticateStaff = authenticateStaff,
): Promise<Response> => {
  const url = new URL(request.url);

  if (url.pathname === "/api/v1/live") return handleLiveConnection(request, env);

  if (url.pathname.startsWith("/api/v1/staff/")) {
    const actor = await authenticate(request, env);
    if (actor === null) {
      return json({ error: "Staff authentication required." }, 401, {
        "www-authenticate": "Bearer",
      });
    }
    if (
      actor.authentication === "cookie"
      && request.method !== "GET"
      && request.method !== "HEAD"
      && request.headers.get("origin") !== new URL(env.APP_ORIGIN).origin
    ) {
      return json({ error: "Same-origin staff request required." }, 403);
    }
    if (url.pathname === "/api/v1/staff/session" && request.method === "GET") {
      return json({
        access: {
          isSystemAdmin: actor.isSystemAdmin,
          roles: actor.roles,
        },
      });
    }
    const operationHandlers = [
      handleStaffLifecycleOperations,
      handleEventOperations,
      handleParticipantOperations,
      handleDuckOperations,
      handleHeatOperations,
      handleSupportOperations,
    ] as const;
    for (const handler of operationHandlers) {
      const response = await handler(request, env, actor);
      if (response !== null) return response;
    }
    return handleStaffApi(request, env, actor);
  }

  if (url.pathname === "/api/v1/events/current" && request.method === "GET") {
    const event = await getCurrentEvent(env);
    return event === null ? json({ event: null }) : json({ event: eventResponse(event) });
  }

  if (url.pathname === "/api/v1/race-board" && request.method === "GET") {
    return json(await getPublicRaceBoard(env));
  }

  if (url.pathname === "/api/v1/registrations" && request.method === "POST") {
    return createRegistration(request, env);
  }

  if (url.pathname === "/api/v1/registrations/mine" && request.method === "GET") {
    return getMyRegistrations(request, env);
  }

  if (url.pathname === "/api/v1/registrations/mine/presence" && request.method === "GET") {
    return getMyRegistrationPresence(request, env);
  }

  if (url.pathname === "/api/v1/race-status/search" && request.method === "GET") {
    return searchPublicRaceStatus(request, url, env);
  }

  const registrationMatch = url.pathname.match(/^\/api\/v1\/registrations\/([A-Za-z0-9_-]+)$/);
  if (registrationMatch !== null && request.method === "GET") {
    return getRegistrationStatus(registrationMatch[1], env);
  }

  const duckMatch = url.pathname.match(/^\/api\/v1\/ducks\/([A-Za-z0-9_-]+)$/);
  if (duckMatch !== null && request.method === "GET") {
    return getDuck(duckMatch[1], env);
  }

  return json({ error: "Not found." }, 404);
};

export const handleApi = async (
  request: Request,
  env: Env,
  authenticate: typeof authenticateStaff = authenticateStaff,
  ctx?: ExecutionContext,
): Promise<Response> => {
  const response = await handleApiRequest(request, env, authenticate);
  const refreshDomains = mutationRefreshDomains(request);
  if (response.ok && refreshDomains !== null) scheduleRaceUpdate(env, ctx, refreshDomains);
  return response;
};
