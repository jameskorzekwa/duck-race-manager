import type { Env } from "./types.ts";

const encoder = new TextEncoder();
const notificationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const tokenPattern = /^[0-9a-f]{64}$/;

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const unsubscribeSecret = (env: Env): string => {
  if (typeof env.UNSUBSCRIBE_SECRET !== "string" || env.UNSUBSCRIBE_SECRET.length < 32) {
    throw new Error("UNSUBSCRIBE_CONFIGURATION_INVALID");
  }
  return env.UNSUBSCRIBE_SECRET;
};

export const unsubscribeTokenFor = async (notificationId: string, env: Env): Promise<string> => {
  if (!notificationIdPattern.test(notificationId)) throw new Error("UNSUBSCRIBE_ID_INVALID");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(unsubscribeSecret(env)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`quickducks-email-unsubscribe\0${notificationId}`),
  )));
};

const equalToken = (left: string, right: string): boolean => {
  if (!tokenPattern.test(left) || !tokenPattern.test(right)) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

export const unsubscribeUrlFor = async (notificationId: string, env: Env): Promise<string> => {
  const token = await unsubscribeTokenFor(notificationId, env);
  return new URL(`/notifications/unsubscribe/${notificationId}/${token}`, env.APP_ORIGIN).toString();
};

interface UnsubscribeTarget {
  event_id: string;
  registration_id: string;
}

const targetFor = (notificationId: string, env: Env): Promise<UnsubscribeTarget | null> => env.DB.prepare(
  `SELECT event_id, registration_id
     FROM participant_notifications
    WHERE id = ? AND channel = 'EMAIL'
   UNION ALL
   SELECT event_id, registration_id
     FROM email_notifications
    WHERE id = ?
   LIMIT 1`,
).bind(notificationId, notificationId).first<UnsubscribeTarget>();

export const emailSuppressedForRegistration = async (
  env: Env,
  eventId: string,
  registrationId: string,
): Promise<boolean> => await env.DB.prepare(
  `SELECT 1 AS suppressed
     FROM participant_notification_suppressions
    WHERE event_id = ? AND registration_id = ? AND channel = 'EMAIL'
    LIMIT 1`,
).bind(eventId, registrationId).first<{ suppressed: number }>() !== null;

const headers = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
} as const;

const page = (action: string, completed: boolean): Response => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email updates</title>`
    + "<style>body{font:16px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.75rem 1rem}</style></head><body><main>"
    + (completed
      ? "<h1>Email updates are off</h1><p>QuickDucks will not send more participant email updates for this registration. SMS preferences were not changed.</p>"
      : `<h1>Stop email updates?</h1><p>This turns off participant email updates for this registration. SMS preferences will not change.</p><form method="post" action="${action}"><button type="submit">Stop email updates</button></form>`)
    + "</main></body></html>",
  { headers },
);

const invalid = (): Response => new Response(
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>Email updates</title></head><body><h1>This unsubscribe link is not available.</h1></body></html>",
  { status: 404, headers },
);

// GET is intentionally read-only because mailbox security scanners follow
// links. The signed capability authorizes only the idempotent POST below.
export const handleEmailUnsubscribe = async (
  request: Request,
  env: Env,
  notificationId: string,
  suppliedToken: string,
): Promise<Response> => {
  if (!notificationIdPattern.test(notificationId) || !tokenPattern.test(suppliedToken)) return invalid();
  let expectedToken: string;
  try {
    expectedToken = await unsubscribeTokenFor(notificationId, env);
  } catch {
    return invalid();
  }
  if (!equalToken(suppliedToken, expectedToken)) return invalid();
  const target = await targetFor(notificationId, env);
  if (target === null) return invalid();
  const action = new URL(request.url).pathname;
  if (request.method === "GET") return page(action, false);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...headers, allow: "GET, POST" } });

  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO participant_notification_suppressions
        (event_id, registration_id, channel, source, created_at)
       VALUES (?, ?, 'EMAIL', 'EMAIL_UNSUBSCRIBE', ?)
       ON CONFLICT(event_id, registration_id, channel) DO NOTHING`,
    ).bind(target.event_id, target.registration_id, now),
    env.DB.prepare(
      `UPDATE registrations
          SET email_notifications_enabled = 0, revision = revision + 1, updated_at = ?
        WHERE event_id = ? AND id = ? AND email_notifications_enabled != 0`,
    ).bind(now, target.event_id, target.registration_id),
    env.DB.prepare(
      `UPDATE participant_notifications
          SET status = 'SUPPRESSED', terminal_at = ?, status_reason = 'EMAIL_UNSUBSCRIBED',
              retry_after = NULL, last_error_code = NULL, updated_at = ?
        WHERE event_id = ? AND registration_id = ? AND channel = 'EMAIL'
          AND status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')`,
    ).bind(now, now, target.event_id, target.registration_id),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'CANCELLED', terminal_at = ?, status_reason = 'EMAIL_UNSUBSCRIBED',
              retry_after = NULL, last_error_code = NULL, updated_at = ?
        WHERE event_id = ? AND registration_id = ?
          AND status IN ('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING')`,
    ).bind(now, now, target.event_id, target.registration_id),
  ]);
  return page(action, true);
};
