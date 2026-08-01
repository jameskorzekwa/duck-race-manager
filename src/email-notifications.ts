import type { Env } from "./types.ts";

export const EMAIL_NOTIFICATION_TYPES = ["HEAT_ASSIGNED", "HEAT_UPCOMING"] as const;

const sendableStatuses = ["PENDING", "QUEUED", "RETRY_PENDING"] as const;
const claimableStatuses = new Set<string>([...sendableStatuses, "SENDING"]);
const notificationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const textEncoder = new TextEncoder();

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSendResult {
  providerMessageId: string | null;
}

export type EmailSender = (email: OutboundEmail, env: Env) => Promise<EmailSendResult>;

export class EmailSendError extends Error {
  readonly safeCode: string;
  readonly retryable: boolean;

  constructor(safeCode: string, retryable: boolean) {
    super(safeCode);
    this.safeCode = safeCode;
    this.retryable = retryable;
  }
}

interface NotificationRow {
  id: string;
  event_id: string;
  registration_id: string;
  notification_type: string;
  template_version: number;
  status: string;
  sending_started_at: string | null;
  retry_after: string | null;
  event_name: string;
  event_status: string;
  first_name: string;
  last_name: string;
  email: string | null;
  email_notifications_enabled: number;
  registration_status: string;
  heat_id: string | null;
  heat_entry_id: string | null;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  visible_number: number | null;
}

interface AttemptNumberRow {
  last_attempt: number;
}

export type EmailProcessingResult = "SENT" | "CANCELLED" | "FAILED" | "NOOP" | "RETRY";

const isoAfter = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

const singleLine = (value: string): string => value
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const sha256 = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));

const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const hmac = async (key: Uint8Array, value: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, textEncoder.encode(value)));
};

// SES v2's structured SendEmail endpoint keeps MIME construction and headers out
// of application code. SigV4 is implemented with Web Crypto so the Worker does
// not need a second AWS SDK bundle merely to make this one request.
export const sendEmailWithSes: EmailSender = async (email, env) => {
  const region = env.AWS_REGION;
  if (
    region !== "us-east-1"
    || env.EMAIL_FROM_ADDRESS !== "race@quickducks.com"
    || email.from !== env.EMAIL_FROM_ADDRESS
    || env.AWS_ACCESS_KEY_ID.length < 16
    || env.AWS_SECRET_ACCESS_KEY.length < 32
  ) {
    throw new EmailSendError("SES_CONFIGURATION_INVALID", false);
  }
  const host = `email.${region}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const body = JSON.stringify({
    FromEmailAddress: email.from,
    Destination: { ToAddresses: [email.to] },
    Content: {
      Simple: {
        Subject: { Data: email.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: email.text, Charset: "UTF-8" },
          Html: { Data: email.html, Charset: "UTF-8" },
        },
      },
    },
  });
  const payloadHash = hex(await sha256(body));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${region}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(textEncoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, "ses");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));

  let response: Response;
  try {
    response = await fetch(`https://${host}${path}`, {
      method: "POST",
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "content-type": "application/json",
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      body,
    });
  } catch {
    throw new EmailSendError("SES_NETWORK_ERROR", true);
  }

  if (!response.ok) {
    // Provider response bodies can repeat recipient or message material. They
    // are deliberately neither parsed nor persisted.
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new EmailSendError(retryable ? "SES_TEMPORARY_FAILURE" : "SES_REJECTED", retryable);
  }

  let providerMessageId: string | null = null;
  try {
    const result = await response.json() as { MessageId?: unknown };
    if (typeof result.MessageId === "string" && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.MessageId)) {
      providerMessageId = result.MessageId;
    }
  } catch {
    // A 2xx response is still SES acceptance even if its optional identifier is
    // missing or malformed; no provider body is retained.
  }
  return { providerMessageId };
};

const notificationRow = (env: Env, notificationId: string): Promise<NotificationRow | null> =>
  env.DB.prepare(
    `SELECT n.id, n.event_id, n.registration_id, n.notification_type,
            n.template_version, n.status,
            n.sending_started_at, n.retry_after,
            e.name AS event_name, e.status AS event_status,
            r.first_name, r.last_name, r.email, r.email_notifications_enabled,
            r.status AS registration_status, n.heat_id,
            he.id AS heat_entry_id, h.round AS heat_round,
            h.heat_number, h.status AS heat_status, d.visible_number
       FROM email_notifications n
       JOIN events e ON e.id = n.event_id
       JOIN registrations r ON r.id = n.registration_id AND r.event_id = n.event_id
       JOIN race_entries re ON re.registration_id = r.id AND re.event_id = n.event_id
       LEFT JOIN heats h ON h.id = n.heat_id AND h.event_id = n.event_id
       LEFT JOIN heat_entries he
         ON he.heat_id = n.heat_id AND he.race_entry_id = re.id AND he.event_id = n.event_id
       LEFT JOIN duck_assignments da
         ON da.race_entry_id = re.id AND da.event_id = n.event_id AND da.valid_to IS NULL
       LEFT JOIN ducks d ON d.id = da.duck_id
      WHERE n.id = ?
      LIMIT 1`,
  ).bind(notificationId).first<NotificationRow>();

const cancelNotification = async (env: Env, notificationId: string, reason: string): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = ?
        WHERE notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'`,
    ).bind(now, reason, notificationId),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'CANCELLED', terminal_at = ?, status_reason = ?,
              last_error_code = NULL, retry_after = NULL, updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'QUEUED', 'SENDING', 'RETRY_PENDING')`,
    ).bind(now, reason, now, notificationId),
  ]);
};

const failNotification = async (env: Env, notificationId: string, code: string): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = ?
        WHERE notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'`,
    ).bind(now, code, notificationId),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'FAILED', terminal_at = ?, last_error_code = ?,
              retry_after = NULL, updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'QUEUED', 'SENDING', 'RETRY_PENDING')`,
    ).bind(now, code, now, notificationId),
  ]);
};

const validationFailure = (row: NotificationRow): string | null => {
  if (!(EMAIL_NOTIFICATION_TYPES as readonly string[]).includes(row.notification_type)) return "UNSUPPORTED_TEMPLATE";
  if (row.template_version !== 1) return "UNSUPPORTED_TEMPLATE";
  if (row.email_notifications_enabled !== 1 || row.email === null) return "EMAIL_NOT_OPTED_IN";
  if (row.registration_status !== "ACTIVE") return "REGISTRATION_NOT_ACTIVE";
  if (
    row.heat_id === null || row.heat_entry_id === null || row.heat_round === null
    || row.heat_number === null || row.visible_number === null
  ) return "RACE_ASSIGNMENT_CHANGED";
  if (!new Set(["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL"]).has(row.event_status)) {
    return "EVENT_NO_LONGER_ACTIVE";
  }
  if (
    row.notification_type === "HEAT_ASSIGNED"
    && !new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
  ) return "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  if (row.notification_type === "HEAT_UPCOMING" && row.heat_status !== "CALLING" && row.heat_status !== "RUNNING") {
    return "HEAT_NO_LONGER_UPCOMING";
  }
  return null;
};

const renderEmail = (row: NotificationRow, env: Env): OutboundEmail => {
  const eventName = singleLine(row.event_name);
  const participantName = singleLine(`${row.first_name} ${row.last_name}`);
  const round = row.heat_round === "FINAL" ? "Final" : "Round One";
  const heat = `${round}, Heat ${row.heat_number}`;
  const duck = `Duck #${row.visible_number}`;
  const raceUrl = new URL("/race", env.APP_ORIGIN).toString();
  const assigned = row.notification_type === "HEAT_ASSIGNED";
  const subject = singleLine(assigned
    ? `${duck} is assigned to ${heat}`
    : `${heat} is being called now`);
  const action = assigned
    ? `${duck} is assigned to ${heat}. Please stay near the pond and listen for your heat to be called.`
    : `${heat} is being called now. Please bring ${duck} to the pond.`;
  const text = [
    `Hi ${participantName},`,
    "",
    action,
    "",
    `Event: ${eventName}`,
    `Race status: ${raceUrl}`,
    "",
    "Race progress can change, so this reminder does not promise a start time.",
    "You can turn off email updates from My Ducks on the device used to register.",
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body><p>Hi ${escapeHtml(participantName)},</p>`
    + `<p><strong>${escapeHtml(action)}</strong></p>`
    + `<p>Event: ${escapeHtml(eventName)}<br><a href="${escapeHtml(raceUrl)}">View race status</a></p>`
    + "<p>Race progress can change, so this reminder does not promise a start time.</p>"
    + "<p>You can turn off email updates from My Ducks on the device used to register.</p></body></html>";
  return {
    from: env.EMAIL_FROM_ADDRESS,
    to: row.email!,
    subject,
    text,
    html,
  };
};

export const processEmailNotification = async (
  env: Env,
  notificationId: string,
  sender: EmailSender = sendEmailWithSes,
  queueDeliveryAttempt = 1,
): Promise<EmailProcessingResult> => {
  if (!notificationIdPattern.test(notificationId)) return "NOOP";
  const row = await notificationRow(env, notificationId);
  if (row === null) return "NOOP";
  if (!claimableStatuses.has(row.status)) return "NOOP";
  // Shorter than the queue's five one-minute attempts, so an invocation that
  // dies after claiming can be recovered before its message reaches the DLQ.
  const staleSendingBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  if (
    row.status === "SENDING" && row.sending_started_at !== null
    && row.sending_started_at >= staleSendingBefore
  ) return "RETRY";
  if (row.retry_after !== null && row.retry_after > new Date().toISOString()) return "RETRY";

  const invalid = validationFailure(row);
  if (invalid === "UNSUPPORTED_TEMPLATE") {
    await failNotification(env, notificationId, invalid);
    return "FAILED";
  }
  if (invalid !== null) {
    await cancelNotification(env, notificationId, invalid);
    return "CANCELLED";
  }

  const now = new Date().toISOString();
  const lastAttempt = await env.DB.prepare(
    `SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt
       FROM email_attempts WHERE notification_id = ? AND stage = 'DELIVERY'`,
  ).bind(notificationId).first<AttemptNumberRow>();
  const attemptNumber = Number(lastAttempt?.last_attempt ?? 0) + 1;
  const attemptId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts
            SET status = 'TEMPORARY_FAILURE', completed_at = ?,
                error_code = 'DELIVERY_LEASE_EXPIRED'
          WHERE notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'
            AND started_at < ?`,
      ).bind(now, notificationId, staleSendingBefore),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = 'SENDING', sending_started_at = ?, updated_at = ?
          WHERE id = ? AND (
            status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')
            OR (status = 'SENDING' AND sending_started_at < ?)
          )`,
      ).bind(now, now, notificationId, staleSendingBefore),
      env.DB.prepare(
        `INSERT INTO email_attempts
          (id, event_id, notification_id, attempt_number, stage, status, started_at)
         SELECT ?, event_id, id, ?, 'DELIVERY', 'SENDING', ?
           FROM email_notifications
          WHERE id = ? AND status = 'SENDING' AND sending_started_at = ?`,
      ).bind(attemptId, attemptNumber, now, notificationId, now),
    ]);
  } catch {
    return "RETRY";
  }
  const claimed = await env.DB.prepare(
    "SELECT 1 AS claimed FROM email_attempts WHERE id = ? AND status = 'SENDING' LIMIT 1",
  ).bind(attemptId).first<{ claimed: number }>();
  if (claimed === null) return "RETRY";

  try {
    const result = await sender(renderEmail(row, env), env);
    const providerMessageId = typeof result.providerMessageId === "string"
        && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.providerMessageId)
      ? result.providerMessageId
      : null;
    const sentAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts
            SET status = 'SENT', completed_at = ?, provider_message_id = ?, error_code = NULL
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(sentAt, providerMessageId, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = 'SENT', sent_at = ?, sending_started_at = NULL,
                status_reason = 'SES_ACCEPTED', last_error_code = NULL,
                retry_after = NULL, updated_at = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(sentAt, sentAt, notificationId),
    ]);
    return "SENT";
  } catch (error) {
    const failure = error instanceof EmailSendError
      ? error
      : new EmailSendError("EMAIL_SENDER_FAILURE", true);
    const completedAt = new Date().toISOString();
    const exhausted = failure.retryable && queueDeliveryAttempt >= 5;
    const retryable = failure.retryable && !exhausted;
    const code = exhausted ? "DELIVERY_RETRIES_EXHAUSTED" : failure.safeCode;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts
            SET status = ?, completed_at = ?, error_code = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(retryable ? "TEMPORARY_FAILURE" : "PERMANENT_FAILURE", completedAt, code, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = ?, sending_started_at = NULL, terminal_at = ?,
                last_error_code = ?, retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(
        retryable ? "QUEUED" : "FAILED",
        retryable ? null : completedAt,
        code,
        retryable ? isoAfter(60_000) : null,
        completedAt,
        notificationId,
      ),
    ]);
    return retryable ? "RETRY" : "FAILED";
  }
};

const publishEmailNotificationUnsafe = async (env: Env, notificationId: string): Promise<void> => {
  if (!notificationIdPattern.test(notificationId)) return;
  const notification = await env.DB.prepare(
    `SELECT id, event_id, status
       FROM email_notifications
      WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING')
      LIMIT 1`,
  ).bind(notificationId).first<{ id: string; event_id: string; status: string }>();
  if (notification === null) return;

  const startedAt = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  const lastAttempt = await env.DB.prepare(
    "SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt FROM email_attempts WHERE notification_id = ? AND stage = 'QUEUE'",
  ).bind(notificationId).first<AttemptNumberRow>();
  const attemptNumber = Number(lastAttempt?.last_attempt ?? 0) + 1;
  try {
    // The queue is an untrusted transport. It receives only this opaque durable
    // ID; the consumer reloads recipient, consent, and race state from D1.
    await env.EMAIL_QUEUE.send(notificationId);
    const completedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO email_attempts
          (id, event_id, notification_id, attempt_number, stage, status, started_at, completed_at)
         VALUES (?, ?, ?, ?, 'QUEUE', 'QUEUED', ?, ?)`,
      ).bind(attemptId, notification.event_id, notificationId, attemptNumber, startedAt, completedAt),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = 'QUEUED', queued_at = COALESCE(queued_at, ?),
                retry_after = NULL, last_error_code = NULL, updated_at = ?
          WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING')`,
      ).bind(completedAt, completedAt, notificationId),
    ]);
  } catch {
    const completedAt = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO email_attempts
            (id, event_id, notification_id, attempt_number, stage, status,
             started_at, completed_at, error_code)
           VALUES (?, ?, ?, ?, 'QUEUE', 'TEMPORARY_FAILURE', ?, ?, 'QUEUE_PUBLISH_FAILED')`,
        ).bind(attemptId, notification.event_id, notificationId, attemptNumber, startedAt, completedAt),
        env.DB.prepare(
          `UPDATE email_notifications
              SET status = 'RETRY_PENDING', last_error_code = 'QUEUE_PUBLISH_FAILED',
                  retry_after = ?, updated_at = ?
            WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING')`,
        ).bind(isoAfter(60_000), completedAt, notificationId),
      ]);
    } catch {
      // A concurrent dispatcher may have won the same attempt. The durable
      // notification remains discoverable, and no race mutation is failed.
    }
  }
};

// Notification transport is never allowed to replace a committed race-command
// response. The cron dispatcher will rediscover a durable PENDING row after any
// D1 or queue exception that escapes the narrower handling above.
export const publishEmailNotification = async (env: Env, notificationId: string): Promise<void> => {
  try {
    await publishEmailNotificationUnsafe(env, notificationId);
  } catch {
    // Intentionally isolated from pairing and heat transitions.
  }
};

export const dispatchPendingEmailNotifications = async (env: Env): Promise<void> => {
  const now = new Date().toISOString();
  const pending = await env.DB.prepare(
    `SELECT id
       FROM email_notifications
      WHERE (status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= ?))
         OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?))
      ORDER BY created_at, id
      LIMIT 100`,
  ).bind(now, now).all<{ id: string }>();
  await Promise.all(pending.results.map((notification) => publishEmailNotification(env, notification.id)));
};

export const handleEmailQueue = async (
  batch: MessageBatch<unknown>,
  env: Env,
  sender: EmailSender = sendEmailWithSes,
): Promise<void> => {
  for (const message of batch.messages) {
    if (typeof message.body !== "string" || !notificationIdPattern.test(message.body)) {
      message.ack();
      continue;
    }
    try {
      const result = await processEmailNotification(env, message.body, sender, message.attempts);
      if (result === "RETRY") message.retry({ delaySeconds: 60 });
      else message.ack();
    } catch {
      // Unexpected infrastructure failures are left to the bounded queue retry
      // policy and then the configured DLQ. No provider/request material is
      // logged or copied into the retry request.
      message.retry({ delaySeconds: 60 });
    }
  }
};
