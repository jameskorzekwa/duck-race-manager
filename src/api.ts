import {
  cleanDuckName,
  DUCK_NAME_MAX_LENGTH,
  hashToken,
  isCommandId,
  isPrivateToken,
  isRegistrationId,
  randomLookupCode,
  registrationDeletionAuditStatement,
  registrationDeletionCommitted,
  registrationDeletionStatements,
  removableRegistrationSql,
  validateRegistration,
} from "./registration.ts";
import { authenticateStaff } from "./auth.ts";
import {
  hasSupportedDuckNameCharacters,
  isAllowedDuckName,
  publicDuckName,
} from "./duck-name-filter.ts";
import {
  browserCollectionCookie,
  clearBrowserCollectionCookie,
  collectionStatements,
  followStatements,
  getBrowserCollection,
  prepareBrowserCollection,
  refreshBrowserCollection,
} from "./browser-collection.ts";
import {
  getPublicStatusByDuckNumber,
  getPublicStatusByRaceEntry,
  getPublicStatusByTag,
  type PublicFollowState,
  type PublicRaceStatus,
} from "./race-status.ts";
import { handleDuckOperations } from "./duck-operations.ts";
import { handleEventOperations } from "./event-operations.ts";
import { handleHeatOperations } from "./heat-operations.ts";
import { isLocalPreviewOrigin } from "./local-preview.ts";
import { optionalParticipantQrGeometry } from "./participant-qr.ts";
import { handleParticipantOperations } from "./participant-operations.ts";
import { handleStaffApi } from "./staff-api.ts";
import { handleStaffLifecycleOperations } from "./staff-lifecycle-operations.ts";
import { handleSupportOperations } from "./support-operations.ts";
import {
  handleLiveConnection,
  mutationRefreshDomains,
  scheduleRaceUpdate,
} from "./live-updates.ts";
import { getCurrentPublicEvent, getPublicRaceBoard, publicDisplayName } from "./race-board.ts";
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
        'COMPLETED'
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

// Canonical positive integers only. A non-canonical or oversized value resolves
// to nothing rather than being coerced, so one duck number has one address.
export const isDuckVisibleNumber = (value: string): boolean => /^[1-9][0-9]{0,8}$/.test(value);

// Resolves a board-visible duck number inside the current public event. It
// returns the same public projection as the tag lookup and never widens it.
export const findDuckNumberRaceStatus = async (
  visibleNumber: string,
  env: Env,
): Promise<PublicRaceStatus | null> => {
  if (!isDuckVisibleNumber(visibleNumber)) return null;
  const event = await getCurrentPublicEvent(env);
  if (event === null) return null;
  return getPublicStatusByDuckNumber(env, event.id, Number(visibleNumber));
};

// Follow eligibility is deliberately a separate question from status
// visibility. A withdrawn or disqualified registration still has a public race
// status by tag or number, but it has left the public name search and the
// follow endpoint refuses it, so the predicate below is the follow endpoint's
// own and is re-evaluated instead of inferred from the rendered status. It
// therefore emits `followId` for exactly the entries the public name search
// already exposes, and never for one it hides.
//
// `source` and `selector` are fixed internal SQL fragments; every external
// value stays bound.
const followableDuckSql = (source: string, selector: string): string => `
    SELECT re.id AS race_entry_id,
           EXISTS (
             SELECT 1
               FROM browser_collection_registrations bcr
              WHERE bcr.collection_id = ? AND bcr.registration_id = r.id
           ) AS in_collection
      FROM race_entries re
      JOIN registrations r ON r.id = re.registration_id
      JOIN events e ON e.id = re.event_id
      JOIN duck_assignments da ON da.race_entry_id = re.id AND da.valid_to IS NULL
      JOIN ducks d ON d.id = da.duck_id
      ${source}
     WHERE ${selector}
       AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
       AND r.status IN ('SUBMITTED', 'ACTIVE')
     LIMIT 1`;

interface FollowableRow {
  race_entry_id: string;
  in_collection: number;
}

const followStateFrom = (row: FollowableRow | null): PublicFollowState | null =>
  row === null ? null : { followId: row.race_entry_id, inMyDucks: row.in_collection === 1 };

// Read-only membership probe for this browser's own collection, exactly like
// the public search: it never refreshes the collection and never issues a
// cookie, so a duck page stays a plain anonymous read.
export const findTagFollowState = async (
  request: Request,
  env: Env,
  token: string,
): Promise<PublicFollowState | null> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return null;
  const collection = await getBrowserCollection(request, env);
  return followStateFrom(await env.DB.prepare(followableDuckSql(
    "JOIN duck_tags dt ON dt.duck_id = d.id",
    "dt.token = ? AND dt.status = 'ACTIVE'",
  )).bind(collection?.id ?? "", token).first<FollowableRow>());
};

export const findDuckNumberFollowState = async (
  request: Request,
  env: Env,
  visibleNumber: string,
): Promise<PublicFollowState | null> => {
  if (!isDuckVisibleNumber(visibleNumber)) return null;
  const event = await getCurrentPublicEvent(env);
  if (event === null) return null;
  const collection = await getBrowserCollection(request, env);
  return followStateFrom(await env.DB.prepare(followableDuckSql(
    "",
    "re.event_id = ? AND d.visible_number = ?",
  )).bind(collection?.id ?? "", event.id, Number(visibleNumber)).first<FollowableRow>());
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

  // A local preview has no Turnstile secret and no route to Cloudflare, so
  // remote verification is waived there and only there. The check stays
  // fail-closed everywhere else: an unconfigured deployment still refuses
  // registrations rather than accepting unverified ones. `isLocalPreviewOrigin`
  // admits only loopback and private network addresses, never a public name, so
  // production cannot reach this branch.
  const turnstileSecret = env.TURNSTILE_SECRET_KEY;
  if (turnstileSecret === undefined && !isLocalPreviewOrigin(env.APP_ORIGIN)) {
    return json({ error: "Registration protection is not configured." }, 503);
  }
  if (typeof payload.turnstileToken !== "string" || payload.turnstileToken.length === 0) {
    return json({ error: "Anti-bot verification is required." }, 422);
  }
  if (turnstileSecret !== undefined && !await verifyTurnstile(
    request,
    payload.turnstileToken,
    turnstileSecret,
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

// `followId` and `inMyDucks` ride on the same object the public search already
// puts them on, so a duck page and a search result read one identical shape.
// They are present only when this entry is genuinely followable; a caller must
// therefore treat their absence as "no follow control", never as "not followed".
const followableStatus = (
  status: PublicRaceStatus,
  follow: PublicFollowState | null,
): Record<string, unknown> => follow === null ? { ...status } : { ...status, ...follow };

const getDuck = async (request: Request, token: string, env: Env): Promise<Response> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return json({ destination: "HOME" });
  const status = await getPublicStatusByTag(env, token);
  if (status === null) return json({ destination: "HOME" });
  return json({
    destination: "RACE_STATUS",
    raceStatus: followableStatus(status, await findTagFollowState(request, env, token)),
  });
};

// Unknown, unpaired, and out-of-event numbers are indistinguishable here: all
// three return the same 404, so this adds no enumeration signal beyond the
// duck numbers the public board already publishes.
const getDuckByNumber = async (
  request: Request,
  visibleNumber: string,
  env: Env,
): Promise<Response> => {
  const status = await findDuckNumberRaceStatus(visibleNumber, env);
  if (status === null) return json({ error: "Not found." }, 404);
  return json({
    raceStatus: followableStatus(status, await findDuckNumberFollowState(request, env, visibleNumber)),
  });
};

// The single duck-naming predicate. The My Ducks projection and the guarded
// naming write both build on it, so the form this projection enables can never
// disagree with the write that follows it. Naming requires a link this browser
// holds as 'REGISTRATION' (never a followed one), a public event, and a duck
// that is currently paired to this entry: a name is meaningless before there is
// a duck to carry it. Both users join `bcr`, `r`, `re`, and `e` under these
// exact aliases.
const nameableRaceEntrySql = `bcr.added_via = 'REGISTRATION'
              AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
              AND EXISTS (
                SELECT 1
                  FROM duck_assignments da
                 WHERE da.race_entry_id = re.id AND da.valid_to IS NULL
              )`;

const getMyRegistrations = async (request: Request, env: Env): Promise<Response> => {
  const existingCollection = await getBrowserCollection(request, env);
  if (existingCollection === null) {
    return json({ registrations: [] }, 200, {
      "set-cookie": clearBrowserCollectionCookie(),
    });
  }
  const collection = await refreshBrowserCollection(env, existingCollection);

  // `is_deletable` is the exact predicate the delete endpoint re-checks inside
  // its guarded write, so the button this projection enables can never disagree
  // with the write that follows it. A followed link is excluded here rather
  // than only in the client: it is someone else's registration.
  const registrations = await env.DB.prepare(
    `SELECT r.id AS registration_id, re.id AS race_entry_id,
            r.first_name, r.last_name, r.lookup_code, r.status,
            bcr.added_via, e.public_name_policy, re.duck_name,
            EXISTS (
              SELECT 1
                FROM duck_assignments da
               WHERE da.race_entry_id = re.id AND da.valid_to IS NULL
            ) AS is_paired,
            (
              bcr.added_via = 'REGISTRATION'
              AND ${removableRegistrationSql}
            ) AS is_deletable,
            (${nameableRaceEntrySql}) AS is_nameable
       FROM browser_collection_registrations bcr
       JOIN registrations r ON r.id = bcr.registration_id
       JOIN race_entries re ON re.registration_id = r.id
       JOIN events e ON e.id = r.event_id
      WHERE bcr.collection_id = ?
      ORDER BY bcr.added_at`,
  ).bind(collection.id).all<{
    registration_id: string;
    race_entry_id: string;
    first_name: string;
    last_name: string;
    lookup_code: string;
    status: string;
    added_via: string | null;
    public_name_policy: string;
    duck_name: string | null;
    is_paired: number;
    is_deletable: number;
    is_nameable: number;
  }>();

  // A followed entry came from the public name search, which exposes neither a
  // lookup code nor an unfiltered name. Projecting it back must not grant more
  // than that search already did.
  const items = await Promise.all(registrations.results.map(async (row) => {
    const followed = row.added_via === "FOLLOWED";
    return {
      registrationId: row.registration_id,
      firstName: followed ? null : row.first_name,
      lastName: followed ? null : row.last_name,
      displayName: followed
        ? publicDisplayName(row.public_name_policy, row.first_name, row.last_name)
        : `${row.first_name} ${row.last_name}`,
      lookupCode: followed ? null : row.lookup_code,
      // Drawing geometry for the same QR the private status page renders, so a
      // participant can be scanned straight from My Ducks without having kept
      // the one-time private link. It encodes the lookup code already on the
      // line above and nothing else, so it discloses nothing new, and a
      // followed registration has no lookup code to encode.
      qr: optionalParticipantQrGeometry(followed ? null : row.lookup_code),
      followed,
      registrationStatus: row.status,
      paired: row.is_paired === 1,
      deletable: !followed && row.is_deletable === 1,
      // The owner's own card shows the name it wrote, and a followed card shows
      // nothing: the name belongs to the participant's own duck card here, while
      // the public surfaces identify it by number first. The read-time filter
      // runs even for the owner, so a name that staff cleared or that the
      // wordlist now rejects disappears from the card and its rename form too.
      duckName: followed ? null : publicDuckName(row.duck_name),
      nameable: !followed && row.is_nameable === 1,
      raceStatus: await getPublicStatusByRaceEntry(env, row.race_entry_id),
    };
  }));

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

  // Read-only membership probe for this browser's own collection so a result
  // can render its already-added state. It never refreshes or issues a cookie.
  const collection = await getBrowserCollection(request, env);
  const matches = await env.DB.prepare(
    `SELECT DISTINCT re.id AS race_entry_id,
            EXISTS (
              SELECT 1
                FROM browser_collection_registrations bcr
               WHERE bcr.collection_id = ? AND bcr.registration_id = r.id
            ) AS in_collection
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
  ).bind(collection?.id ?? "", eventId, name, name, name).all<{
    race_entry_id: string;
    in_collection: number;
  }>();

  // `followId` is the only identifier this projection exposes. It is inert on
  // its own: it unlocks nothing except the same public status already returned
  // here, and the follow endpoint revalidates it against this same predicate.
  const results = (await Promise.all(matches.results.map(async (row) => {
    const status = await getPublicStatusByRaceEntry(env, row.race_entry_id);
    return status === null ? null : {
      ...status,
      followId: row.race_entry_id,
      inMyDucks: row.in_collection === 1,
    };
  }))).filter((status) => status !== null);
  return json({ results });
};

interface FollowPayload {
  followId?: unknown;
}

const isFollowId = (value: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const followRegistration = async (request: Request, env: Env): Promise<Response> => {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 1_024) {
    return json({ error: "Request body is too large." }, 413);
  }

  // This mutation is authenticated only by the browser collection cookie, so it
  // requires the exact application origin rather than merely tolerating one.
  if (request.headers.get("origin") !== new URL(env.APP_ORIGIN).origin) {
    return json({ error: "Same-origin request required." }, 403);
  }

  let payload: FollowPayload;
  try {
    const body = await request.text();
    if (body.length > 1_024) return json({ error: "Request body is too large." }, 413);
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "Request body must be a JSON object." }, 400);
    }
    payload = parsed as FollowPayload;
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  if (typeof payload.followId !== "string" || !isFollowId(payload.followId)) {
    return json({ error: "Invalid participant identifier." }, 400);
  }

  const clientKey = request.headers.get("cf-connecting-ip") ?? "unknown-client";
  const rateLimit = await env.PUBLIC_SEARCH_RATE_LIMITER.limit({ key: `follow:${clientKey}` });
  if (!rateLimit.success) {
    return json({ error: "Too many requests. Please wait and try again." }, 429);
  }

  const event = await getCurrentEvent(env);
  if (event === null) return json({ error: "That participant cannot be added." }, 404);

  // The identifier must still resolve to a publicly searchable entry of the
  // current public event, so this endpoint can never reach an arbitrary
  // internal race entry.
  const entry = await env.DB.prepare(
    `SELECT re.registration_id
       FROM race_entries re
       JOIN registrations r ON r.id = re.registration_id
       JOIN events e ON e.id = re.event_id
      WHERE re.id = ?
        AND re.event_id = ?
        AND r.status IN ('SUBMITTED', 'ACTIVE')
        AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
      LIMIT 1`,
  ).bind(payload.followId, event.id).first<{ registration_id: string }>();
  if (entry === null) return json({ error: "That participant cannot be added." }, 404);

  const collection = await prepareBrowserCollection(request, env);
  const existing = collection.isNew ? null : await env.DB.prepare(
    `SELECT 1 AS present
       FROM browser_collection_registrations
      WHERE collection_id = ? AND registration_id = ?
      LIMIT 1`,
  ).bind(collection.id, entry.registration_id).first<{ present: number }>();

  await env.DB.batch(await followStatements(
    env,
    collection,
    entry.registration_id,
    new Date().toISOString(),
  ));

  return json({ followed: true, alreadyInCollection: existing !== null }, 200, {
    "set-cookie": browserCollectionCookie(collection.cookieToken),
  });
};

interface DeleteRegistrationPayload {
  commandId?: unknown;
  registrationId?: unknown;
}

// Self-service removal of a registration this browser created, for the person
// who registered by mistake. The browser collection cookie is the only
// credential, so this endpoint mirrors the follow endpoint's transport rules
// exactly: same-origin only, small body, validation before any database access,
// and the same public rate limiter.
//
// Authorization is deliberately narrow. The caller may remove a registration
// only through a link this browser holds as 'REGISTRATION', never a 'FOLLOWED'
// link, and only while the entry has no duck assignment and no heat place. The
// preflight read below exists to produce a useful message; the guarded command
// insert inside the batch re-checks the identical conditions and is what
// actually authorizes the write.
const deleteMyRegistration = async (request: Request, env: Env): Promise<Response> => {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 1_024) {
    return json({ error: "Request body is too large." }, 413);
  }

  if (request.headers.get("origin") !== new URL(env.APP_ORIGIN).origin) {
    return json({ error: "Same-origin request required." }, 403);
  }

  let payload: DeleteRegistrationPayload;
  try {
    const body = await request.text();
    if (body.length > 1_024) return json({ error: "Request body is too large." }, 413);
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return json({ error: "Request body must be a JSON object." }, 400);
    }
    payload = parsed as DeleteRegistrationPayload;
  } catch {
    return json({ error: "Request body must be valid JSON." }, 400);
  }

  const { commandId, registrationId } = payload;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || typeof registrationId !== "string" || !isRegistrationId(registrationId)
  ) {
    return json({ error: "Invalid command or registration identifier." }, 400);
  }

  const clientKey = request.headers.get("cf-connecting-ip") ?? "unknown-client";
  const rateLimit = await env.PUBLIC_SEARCH_RATE_LIMITER.limit({ key: `delete:${clientKey}` });
  if (!rateLimit.success) {
    return json({ error: "Too many requests. Please wait and try again." }, 429);
  }

  // Replay is resolved before anything else touches the collection, because a
  // committed delete leaves no registration and no collection link to re-read.
  // A retry of the same command therefore has to be answered from the command
  // history alone, which is what makes deleting twice a deterministic success.
  const previous = await env.DB.prepare(
    "SELECT command_type, result_id FROM race_commands WHERE id = ?",
  ).bind(commandId).first<{ command_type: string; result_id: string | null }>();
  if (previous !== null) {
    return previous.command_type === "DELETE_REGISTRATION" && previous.result_id === registrationId
      ? json({ deleted: true, replayed: true })
      : json({ error: "Command identifier has already been used." }, 409);
  }

  const collection = await getBrowserCollection(request, env);
  // A missing or unknown collection, an unrelated registration, and a followed
  // link are one indistinguishable 404, so this never reports whether some
  // other browser's registration exists.
  if (collection === null) return json({ error: "That registration cannot be deleted." }, 404);

  const target = await env.DB.prepare(
    `SELECT r.id AS registration_id,
            EXISTS (
              SELECT 1 FROM duck_assignments da WHERE da.race_entry_id = re.id
            ) AS has_assignment,
            EXISTS (
              SELECT 1 FROM heat_entries he WHERE he.race_entry_id = re.id
            ) AS has_heat_entry
       FROM browser_collection_registrations bcr
       JOIN registrations r ON r.id = bcr.registration_id
       JOIN race_entries re ON re.registration_id = r.id
       JOIN events e ON e.id = r.event_id
      WHERE bcr.collection_id = ?
        AND bcr.registration_id = ?
        AND bcr.added_via = 'REGISTRATION'
        AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
      LIMIT 1`,
  ).bind(collection.id, registrationId).first<{
    registration_id: string;
    has_assignment: number;
    has_heat_entry: number;
  }>();
  if (target === null) return json({ error: "That registration cannot be deleted." }, 404);
  if (target.has_assignment === 1 || target.has_heat_entry === 1) {
    return json({
      error: "This registration already has a race duck, so it can no longer be deleted here. Ask race staff for help.",
    }, 409);
  }

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, r.event_id, 'DELETE_REGISTRATION', r.id, ?, ?
           FROM registrations r
           JOIN events e ON e.id = r.event_id
           JOIN race_entries re ON re.registration_id = r.id
           JOIN browser_collection_registrations bcr
             ON bcr.registration_id = r.id
            AND bcr.collection_id = ?
            AND bcr.added_via = 'REGISTRATION'
          WHERE r.id = ?
            AND ${removableRegistrationSql}`,
      ).bind(commandId, now, now, collection.id, registrationId),
      registrationDeletionAuditStatement(env, commandId, registrationId, "PUBLIC", now, {
        deleted_via: "PUBLIC_COLLECTION",
      }),
      ...registrationDeletionStatements(env, commandId, registrationId),
    ]);
  } catch {
    return json({ error: "That registration could not be deleted. Please try again." }, 409);
  }

  return await registrationDeletionCommitted(env, commandId, registrationId)
    ? json({ deleted: true, replayed: false })
    : json({ error: "That registration cannot be deleted." }, 409);
};

// Shared transport gate for the browser-collection mutations added alongside
// the follow and delete endpoints. It repeats their rules exactly rather than
// relaxing any of them: JSON only, a small body checked before and after
// reading, and the exact application origin, because the collection cookie is
// the only credential these endpoints have.
type PublicCommandBody =
  | { payload: Record<string, unknown>; error?: undefined }
  | { payload?: undefined; error: Response };

const readPublicCommandBody = async (request: Request, env: Env): Promise<PublicCommandBody> => {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return { error: json({ error: "Content-Type must be application/json." }, 415) };
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 1_024) {
    return { error: json({ error: "Request body is too large." }, 413) };
  }

  if (request.headers.get("origin") !== new URL(env.APP_ORIGIN).origin) {
    return { error: json({ error: "Same-origin request required." }, 403) };
  }

  try {
    const body = await request.text();
    if (body.length > 1_024) return { error: json({ error: "Request body is too large." }, 413) };
    const parsed = JSON.parse(body) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: json({ error: "Request body must be a JSON object." }, 400) };
    }
    return { payload: parsed as Record<string, unknown> };
  } catch {
    return { error: json({ error: "Request body must be valid JSON." }, 400) };
  }
};

const publicRateLimit = (request: Request, env: Env, scope: string): Promise<RateLimitOutcome> => {
  const clientKey = request.headers.get("cf-connecting-ip") ?? "unknown-client";
  return env.PUBLIC_SEARCH_RATE_LIMITER.limit({ key: `${scope}:${clientKey}` });
};

const commandCommitted = async (
  env: Env,
  commandId: string,
  commandType: string,
  resultId: string,
): Promise<boolean> => await env.DB.prepare(
  `SELECT 1 AS committed
     FROM race_commands
    WHERE id = ? AND command_type = ? AND result_id = ?
    LIMIT 1`,
).bind(commandId, commandType, resultId).first<{ committed: number }>() !== null;

// Removing a followed participant from this browser's list. It deletes one
// collection link and nothing else: the statement is scoped to this collection,
// to this registration, and to `added_via = 'FOLLOWED'`, so it can never remove
// an entry this browser registered itself — that has its own delete flow — and
// can never touch the registration, the race entry, or another browser's list.
const unfollowRegistration = async (request: Request, env: Env): Promise<Response> => {
  const parsed = await readPublicCommandBody(request, env);
  if (parsed.error !== undefined) return parsed.error;

  const { commandId, registrationId } = parsed.payload;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || typeof registrationId !== "string" || !isRegistrationId(registrationId)
  ) {
    return json({ error: "Invalid command or registration identifier." }, 400);
  }

  const rateLimit = await publicRateLimit(request, env, "unfollow");
  if (!rateLimit.success) {
    return json({ error: "Too many requests. Please wait and try again." }, 429);
  }

  // Replay is resolved before the collection is read, because a committed
  // unfollow leaves no link to re-read. A retry of the same command is
  // therefore answered from the command history alone.
  const previous = await env.DB.prepare(
    "SELECT command_type, result_id FROM race_commands WHERE id = ?",
  ).bind(commandId).first<{ command_type: string; result_id: string | null }>();
  if (previous !== null) {
    return previous.command_type === "UNFOLLOW_REGISTRATION" && previous.result_id === registrationId
      ? json({ unfollowed: true, replayed: true })
      : json({ error: "Command identifier has already been used." }, 409);
  }

  const collection = await getBrowserCollection(request, env);
  // A missing collection, an unrelated registration, and an entry this browser
  // registered itself are one indistinguishable 404, so this never reports
  // whether some other browser's registration exists.
  if (collection === null) return json({ error: "That participant cannot be unfollowed." }, 404);

  const target = await env.DB.prepare(
    `SELECT 1 AS present
       FROM browser_collection_registrations bcr
      WHERE bcr.collection_id = ?
        AND bcr.registration_id = ?
        AND bcr.added_via = 'FOLLOWED'
      LIMIT 1`,
  ).bind(collection.id, registrationId).first<{ present: number }>();
  if (target === null) return json({ error: "That participant cannot be unfollowed." }, 404);

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      // The guarded command insert is the authorization. It materializes only
      // while this browser still holds a followed link, and the delete below is
      // conditional on that row existing.
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, r.event_id, 'UNFOLLOW_REGISTRATION', r.id, ?, ?
           FROM registrations r
           JOIN browser_collection_registrations bcr
             ON bcr.registration_id = r.id
            AND bcr.collection_id = ?
            AND bcr.added_via = 'FOLLOWED'
          WHERE r.id = ?`,
      ).bind(commandId, now, now, collection.id, registrationId),
      env.DB.prepare(
        `DELETE FROM browser_collection_registrations
          WHERE collection_id = ?
            AND registration_id = ?
            AND added_via = 'FOLLOWED'
            AND EXISTS (
              SELECT 1 FROM race_commands rc
               WHERE rc.id = ?
                 AND rc.command_type = 'UNFOLLOW_REGISTRATION'
                 AND rc.result_id = ?
            )`,
      ).bind(collection.id, registrationId, commandId, registrationId),
    ]);
  } catch {
    return json({ error: "That participant could not be unfollowed. Please try again." }, 409);
  }

  return await commandCommitted(env, commandId, "UNFOLLOW_REGISTRATION", registrationId)
    ? json({ unfollowed: true, replayed: false })
    : json({ error: "That participant cannot be unfollowed." }, 409);
};

// Naming a duck the participant registered on this device. Only a
// 'REGISTRATION' link may name, and only once staff have paired a physical
// duck to that entry. The name is stored on the race entry and read back only
// by this browser's own collection projection.
const nameMyDuck = async (request: Request, env: Env): Promise<Response> => {
  const parsed = await readPublicCommandBody(request, env);
  if (parsed.error !== undefined) return parsed.error;

  const { commandId, registrationId, duckName } = parsed.payload;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || typeof registrationId !== "string" || !isRegistrationId(registrationId)
    || typeof duckName !== "string"
  ) {
    return json({ error: "Invalid command, registration identifier, or name." }, 400);
  }

  const cleanedName = cleanDuckName(duckName);
  if (cleanedName === null) {
    return json({
      error: "Duck name validation failed.",
      fields: {
        duckName: `Enter a name of 1 to ${DUCK_NAME_MAX_LENGTH} characters.`,
      },
    }, 422);
  }

  // The alphabet rule is reported on its own terms. `isAllowedDuckName` covers
  // it too, but telling someone their emoji "can’t be used on the public race
  // board" reads as an accusation rather than as the mechanical rule it is.
  if (!hasSupportedDuckNameCharacters(cleanedName)) {
    return json({
      error: "Duck name validation failed.",
      fields: {
        duckName: "Use letters, numbers, spaces, and simple punctuation only.",
      },
    }, 422);
  }

  // The name is public, so it is filtered before it can be stored. This is a
  // semantic rejection of a well-formed value, so it is a 422 like every other
  // failed name rule. The message never quotes the rejected text back, and the
  // attempted value is never logged: it is refused and forgotten.
  if (!isAllowedDuckName(cleanedName)) {
    return json({
      error: "Duck name validation failed.",
      fields: {
        duckName: "That name can’t be used on the public race board. Please choose another one.",
      },
    }, 422);
  }

  const rateLimit = await publicRateLimit(request, env, "duck-name");
  if (!rateLimit.success) {
    return json({ error: "Too many requests. Please wait and try again." }, 429);
  }

  // The command records a hash of the accepted name, never the name itself, so
  // a retry with the same material replays and a reuse with different material
  // conflicts without the command log carrying participant free text.
  const fingerprint = await hashToken(cleanedName);
  const previous = await env.DB.prepare(
    "SELECT command_type, result_id, request_fingerprint FROM race_commands WHERE id = ?",
  ).bind(commandId).first<{
    command_type: string;
    result_id: string | null;
    request_fingerprint: string | null;
  }>();
  if (previous !== null) {
    return previous.command_type === "NAME_DUCK"
        && previous.result_id === registrationId
        && previous.request_fingerprint === fingerprint
      ? json({ named: true, duckName: cleanedName, replayed: true })
      : json({ error: "Command identifier has already been used." }, 409);
  }

  const collection = await getBrowserCollection(request, env);
  if (collection === null) return json({ error: "That duck cannot be named." }, 404);

  // Preflight for a useful message only. The guarded command insert below
  // re-checks the identical conditions and is what authorizes the write.
  const target = await env.DB.prepare(
    `SELECT EXISTS (
              SELECT 1
                FROM duck_assignments da
               WHERE da.race_entry_id = re.id AND da.valid_to IS NULL
            ) AS is_paired
       FROM browser_collection_registrations bcr
       JOIN registrations r ON r.id = bcr.registration_id
       JOIN race_entries re ON re.registration_id = r.id
       JOIN events e ON e.id = r.event_id
      WHERE bcr.collection_id = ?
        AND bcr.registration_id = ?
        AND bcr.added_via = 'REGISTRATION'
        AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
      LIMIT 1`,
  ).bind(collection.id, registrationId).first<{ is_paired: number }>();
  if (target === null) return json({ error: "That duck cannot be named." }, 404);
  if (target.is_paired !== 1) {
    return json({
      error: "This participant is still waiting for a duck, so there is nothing to name yet.",
    }, 409);
  }

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at, request_fingerprint)
         SELECT ?, r.event_id, 'NAME_DUCK', r.id, ?, ?, ?
           FROM registrations r
           JOIN events e ON e.id = r.event_id
           JOIN race_entries re ON re.registration_id = r.id
           JOIN browser_collection_registrations bcr
             ON bcr.registration_id = r.id
            AND bcr.collection_id = ?
          WHERE r.id = ?
            AND ${nameableRaceEntrySql}`,
      ).bind(commandId, now, now, fingerprint, collection.id, registrationId),
      env.DB.prepare(
        `UPDATE race_entries
            SET duck_name = ?, updated_at = ?
          WHERE registration_id = ?
            AND EXISTS (
              SELECT 1 FROM race_commands rc
               WHERE rc.id = ? AND rc.command_type = 'NAME_DUCK' AND rc.result_id = ?
            )`,
      ).bind(cleanedName, now, registrationId, commandId, registrationId),
      // The audit records that the field changed, never the free text itself.
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         SELECT ?, rc.event_id, rc.id, 'DUCK_NAME_SET', 'REGISTRATION', rc.result_id, 'PUBLIC', ?, ?
           FROM race_commands rc
          WHERE rc.id = ? AND rc.command_type = 'NAME_DUCK' AND rc.result_id = ?`,
      ).bind(
        crypto.randomUUID(),
        now,
        JSON.stringify({ changed_fields: ["duck_name"], named_via: "PUBLIC_COLLECTION" }),
        commandId,
        registrationId,
      ),
    ]);
  } catch {
    return json({ error: "That duck could not be named. Please try again." }, 409);
  }

  return await commandCommitted(env, commandId, "NAME_DUCK", registrationId)
    ? json({ named: true, duckName: cleanedName, replayed: false })
    : json({ error: "That duck cannot be named." }, 409);
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

  if (url.pathname === "/api/v1/registrations/mine/follow" && request.method === "POST") {
    return followRegistration(request, env);
  }

  if (url.pathname === "/api/v1/registrations/mine/unfollow" && request.method === "POST") {
    return unfollowRegistration(request, env);
  }

  if (url.pathname === "/api/v1/registrations/mine/duck-name" && request.method === "POST") {
    return nameMyDuck(request, env);
  }

  if (url.pathname === "/api/v1/registrations/mine/delete" && request.method === "POST") {
    return deleteMyRegistration(request, env);
  }

  if (url.pathname === "/api/v1/race-status/search" && request.method === "GET") {
    return searchPublicRaceStatus(request, url, env);
  }

  const registrationMatch = url.pathname.match(/^\/api\/v1\/registrations\/([A-Za-z0-9_-]+)$/);
  if (registrationMatch !== null && request.method === "GET") {
    return getRegistrationStatus(registrationMatch[1], env);
  }

  // Matched before the single-segment tag route so the tag scan flow keeps its
  // exact shape and can never be reached with a visible duck number.
  const duckNumberMatch = url.pathname.match(/^\/api\/v1\/ducks\/number\/([0-9]{1,9})$/);
  if (duckNumberMatch !== null && request.method === "GET") {
    return getDuckByNumber(request, duckNumberMatch[1], env);
  }

  const duckMatch = url.pathname.match(/^\/api\/v1\/ducks\/([A-Za-z0-9_-]+)$/);
  if (duckMatch !== null && request.method === "GET") {
    return getDuck(request, duckMatch[1], env);
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
