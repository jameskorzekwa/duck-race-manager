import type { Env } from "./types.ts";

export const HEAT_ASSIGNED_NOTIFICATION = "HEAT_ASSIGNED";
export const HEAT_UPCOMING_NOTIFICATION = "HEAT_UPCOMING";

const sendingLeaseMilliseconds = 5 * 60_000;
const defaultRetrySeconds = 60;

interface NotificationDeliveryRow {
  id: string;
  event_id: string;
  registration_id: string;
  heat_id: string;
  notification_type: string;
  template_version: number;
  status: string;
  sending_started_at: string | null;
  event_name: string;
  event_status: string;
  first_name: string;
  last_name: string;
  email: string | null;
  email_notifications_enabled: number;
  registration_status: string;
  round: "ROUND_ONE" | "FINAL";
  heat_number: number;
  heat_status: string;
  visible_number: number | null;
}

export interface RenderedRaceReminder {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: RenderedRaceReminder, env: Env): Promise<{ messageId: string | null }>;
}

export class EmailDeliveryError extends Error {
  readonly code: string;
  readonly temporary: boolean;

  constructor(code: string, temporary: boolean) {
    super(code);
    this.name = "EmailDeliveryError";
    this.code = code;
    this.temporary = temporary;
  }
}

interface QueueMessageLike {
  body: unknown;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

interface QueueBatchLike {
  messages: readonly QueueMessageLike[];
}

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();

const roundLabel = (round: NotificationDeliveryRow["round"]): string =>
  round === "FINAL" ? "Final" : "Round One";

export const renderRaceReminder = (row: NotificationDeliveryRow, appOrigin: string): RenderedRaceReminder | null => {
  if (row.email === null || row.visible_number === null) return null;
  const eventName = oneLine(row.event_name).slice(0, 120);
  const participantName = oneLine(`${row.first_name} ${row.last_name}`).slice(0, 161);
  const round = roundLabel(row.round);
  const heat = `${round} / Heat ${row.heat_number}`;
  const publicRaceUrl = new URL("/race", appOrigin).toString();
  const assignment = row.notification_type === HEAT_ASSIGNED_NOTIFICATION;
  if (!assignment && row.notification_type !== HEAT_UPCOMING_NOTIFICATION) return null;
  const running = !assignment && row.heat_status === "RUNNING";

  const subject = assignment
    ? `${eventName}: Duck #${row.visible_number} is assigned to ${heat}`
    : `${eventName}: ${heat} ${running ? "is running now" : "is being called"}`;
  const detail = assignment
    ? `Your duck is #${row.visible_number}, assigned to ${heat}. Keep this number and heat handy, listen for announcements, and return to the pond when your heat is called.`
    : `Duck #${row.visible_number} is racing in ${heat}, which ${running ? "is running now" : "is being called now"}. Please head back to the pond.`;
  const text = [
    `Hi ${participantName},`,
    "",
    detail,
    "",
    `Event: ${eventName}`,
    `Duck: #${row.visible_number}`,
    `Race: ${heat}`,
    "",
    "Heat timing can change, so this email does not promise a start time. Onsite announcements remain authoritative.",
    `Public race status: ${publicRaceUrl}`,
    "You can turn off future email reminders from your owned My Ducks card on the device that registered you.",
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body>`
    + `<p>Hi ${escapeHtml(participantName)},</p>`
    + `<p>${escapeHtml(detail)}</p>`
    + `<dl><dt>Event</dt><dd>${escapeHtml(eventName)}</dd>`
    + `<dt>Duck</dt><dd>#${row.visible_number}</dd>`
    + `<dt>Race</dt><dd>${escapeHtml(heat)}</dd></dl>`
    + `<p>Heat timing can change, so this email does not promise a start time. Onsite announcements remain authoritative.</p>`
    + `<p><a href="${escapeHtml(publicRaceUrl)}">View public race status</a></p>`
    + `<p>You can turn off future email reminders from your owned My Ducks card on the device that registered you.</p>`
    + `</body></html>`;
  return { to: row.email, subject: subject.slice(0, 200), text, html };
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const hmac = async (key: Uint8Array, value: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(value)));
};

const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sesRequest = async (message: RenderedRaceReminder, env: Env): Promise<Request> => {
  if (!/^[a-z0-9-]{3,32}$/.test(env.AWS_REGION)) throw new EmailDeliveryError("SES_CONFIGURATION", false);
  if (!/^[^\s@\r\n]+@quickducks\.com$/i.test(env.SES_FROM_ADDRESS)) {
    throw new EmailDeliveryError("SES_CONFIGURATION", false);
  }
  const host = `email.${env.AWS_REGION}.amazonaws.com`;
  const path = "/v2/email/outbound-emails";
  const body = JSON.stringify({
    FromEmailAddress: env.SES_FROM_ADDRESS,
    Destination: { ToAddresses: [message.to] },
    Content: {
      Simple: {
        Subject: { Data: message.subject, Charset: "UTF-8" },
        Body: {
          Text: { Data: message.text, Charset: "UTF-8" },
          Html: { Data: message.html, Charset: "UTF-8" },
        },
      },
    },
  });
  const instant = new Date();
  const amzDate = instant.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = await sha256(body);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${env.AWS_REGION}/ses/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${await sha256(canonicalRequest)}`;
  const dateKey = await hmac(new TextEncoder().encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmac(dateKey, env.AWS_REGION);
  const serviceKey = await hmac(regionKey, "ses");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  return new Request(`https://${host}${path}`, {
    method: "POST",
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "content-type": "application/json",
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    },
    body,
  });
};

export const createSesEmailSender = (requestFetch: typeof fetch = fetch): EmailSender => ({
  async send(message, env) {
    let response: Response;
    try {
      response = await requestFetch(await sesRequest(message, env));
    } catch (error) {
      if (error instanceof EmailDeliveryError) throw error;
      throw new EmailDeliveryError("SES_NETWORK", true);
    }
    if (!response.ok) {
      if (response.status === 408) throw new EmailDeliveryError("SES_TIMEOUT", true);
      if (response.status === 429) throw new EmailDeliveryError("SES_THROTTLED", true);
      if (response.status >= 500) throw new EmailDeliveryError("SES_UNAVAILABLE", true);
      throw new EmailDeliveryError("SES_REJECTED", false);
    }
    let messageId: string | null = null;
    try {
      const value = await response.json<{ MessageId?: unknown }>();
      if (typeof value.MessageId === "string" && /^[A-Za-z0-9._-]{1,200}$/.test(value.MessageId)) {
        messageId = value.MessageId;
      }
    } catch {
      // SES acceptance is still authoritative when its optional response ID is unreadable.
    }
    return { messageId };
  },
});

export const sesEmailSender = createSesEmailSender();

const loadNotification = (env: Env, id: string): Promise<NotificationDeliveryRow | null> => env.DB.prepare(
  `SELECT n.id, n.event_id, n.registration_id, n.heat_id, n.notification_type, n.template_version,
          n.status, n.sending_started_at, e.name AS event_name, e.status AS event_status,
          r.first_name, r.last_name, r.email, r.email_notifications_enabled,
          r.status AS registration_status, h.round, h.heat_number, h.status AS heat_status,
          d.visible_number
     FROM email_notifications n
     JOIN events e ON e.id = n.event_id
     JOIN registrations r ON r.id = n.registration_id AND r.event_id = n.event_id
     JOIN heats h ON h.id = n.heat_id AND h.event_id = n.event_id
     JOIN race_entries re ON re.registration_id = r.id AND re.event_id = n.event_id
     JOIN heat_entries he ON he.heat_id = h.id AND he.race_entry_id = re.id
     LEFT JOIN duck_assignments da
       ON da.event_id = n.event_id AND da.race_entry_id = re.id AND da.valid_to IS NULL
     LEFT JOIN ducks d ON d.id = da.duck_id
    WHERE n.id = ?
    LIMIT 1`,
).bind(id).first<NotificationDeliveryRow>();

const isCurrentReminder = (row: NotificationDeliveryRow): boolean => {
  if (
    row.template_version !== 1
    || row.email_notifications_enabled !== 1
    || row.email === null
    || row.registration_status !== "ACTIVE"
    || row.visible_number === null
  ) return false;
  if (row.notification_type === HEAT_ASSIGNED_NOTIFICATION) {
    return ["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL"].includes(row.event_status);
  }
  if (row.notification_type === HEAT_UPCOMING_NOTIFICATION) {
    return ["CALLING", "RUNNING"].includes(row.heat_status)
      && ((row.round === "ROUND_ONE" && row.event_status === "ROUND_ONE")
        || (row.round === "FINAL" && row.event_status === "FINAL"));
  }
  return false;
};

const cancelNotification = async (env: Env, id: string, code: string): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE email_notifications
        SET status = 'CANCELLED', terminal_at = ?, status_reason = ?,
            last_error_code = ?, retry_after = NULL, updated_at = ?
      WHERE id = ? AND status IN ('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING', 'SENDING')`,
  ).bind(now, code, code, now, id).run();
};

const staleSending = (startedAt: string | null): boolean => {
  if (startedAt === null) return true;
  const started = Date.parse(startedAt);
  return !Number.isFinite(started) || Date.now() - started >= sendingLeaseMilliseconds;
};

const failUnknownSending = async (env: Env, row: NotificationDeliveryRow): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = 'DELIVERY_OUTCOME_UNKNOWN'
        WHERE notification_id = ? AND status = 'SENDING'`,
    ).bind(now, row.id),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'FAILED', terminal_at = ?, last_error_code = 'DELIVERY_OUTCOME_UNKNOWN',
              status_reason = 'DELIVERY_OUTCOME_UNKNOWN', retry_after = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING'`,
    ).bind(now, now, row.id),
  ]);
};

const deliveryError = (error: unknown): EmailDeliveryError => error instanceof EmailDeliveryError
  ? error
  : new EmailDeliveryError("SES_NETWORK", true);

const processQueueMessage = async (
  message: QueueMessageLike,
  env: Env,
  sender: EmailSender,
): Promise<void> => {
  const id = typeof message.body === "string" ? message.body : "";
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    message.ack();
    return;
  }
  let row = await loadNotification(env, id);
  if (row === null) {
    // The event may already be deleted (no row to update), or the registration
    // may no longer have this heat/assignment. Either way the ID is terminally
    // harmless and must not poison-retry forever.
    await cancelNotification(env, id, "REMINDER_DATA_UNAVAILABLE");
    message.ack();
    return;
  }
  if (["SENT", "DELIVERED", "FAILED", "BOUNCED", "COMPLAINED", "SUPPRESSED", "CANCELLED"].includes(row.status)) {
    message.ack();
    return;
  }
  if (row.status === "SENDING") {
    if (!staleSending(row.sending_started_at)) {
      message.retry({ delaySeconds: defaultRetrySeconds });
      return;
    }
    await failUnknownSending(env, row);
    message.ack();
    return;
  }
  if (!isCurrentReminder(row)) {
    await cancelNotification(env, id, "RECIPIENT_NOT_ELIGIBLE");
    message.ack();
    return;
  }

  const attemptId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO email_attempts
        (id, event_id, notification_id, attempt_number, stage, status, started_at)
       SELECT ?, n.event_id, n.id,
              COALESCE((SELECT MAX(previous.attempt_number) FROM email_attempts previous
                         WHERE previous.notification_id = n.id), 0) + 1,
              'DELIVERY', 'SENDING', ?
         FROM email_notifications n
        WHERE n.id = ? AND n.status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')`,
    ).bind(attemptId, startedAt, id),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'SENDING', sending_started_at = ?, retry_after = NULL, updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')`,
    ).bind(startedAt, startedAt, id),
  ]);
  const claimed = await env.DB.prepare(
    "SELECT 1 AS claimed FROM email_attempts WHERE id = ? AND status = 'SENDING' LIMIT 1",
  ).bind(attemptId).first<{ claimed: number }>();
  if (claimed === null) {
    message.retry({ delaySeconds: defaultRetrySeconds });
    return;
  }

  // Consent and race state are read again after the durable claim and immediately
  // before the irreversible provider call. Contact updates also cancel all work
  // that has not reached this claim, closing the ordinary opt-out race.
  row = await loadNotification(env, id);
  if (row === null || !isCurrentReminder(row)) {
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts
            SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = 'RECIPIENT_NOT_ELIGIBLE'
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(now, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = 'CANCELLED', terminal_at = ?, status_reason = 'RECIPIENT_NOT_ELIGIBLE',
                last_error_code = 'RECIPIENT_NOT_ELIGIBLE', updated_at = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(now, now, id),
    ]);
    message.ack();
    return;
  }
  const rendered = renderRaceReminder(row, env.APP_ORIGIN);
  if (rendered === null) {
    await cancelNotification(env, id, "REMINDER_DATA_UNAVAILABLE");
    message.ack();
    return;
  }

  try {
    const accepted = await sender.send(rendered, env);
    const now = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE email_attempts
              SET status = 'SENT', completed_at = ?, provider_message_id = ?, error_code = NULL
            WHERE id = ? AND status = 'SENDING'`,
        ).bind(now, accepted.messageId, attemptId),
        env.DB.prepare(
          `UPDATE email_notifications
              SET status = 'SENT', sent_at = ?, last_error_code = NULL,
                  status_reason = NULL, retry_after = NULL, updated_at = ?
            WHERE id = ? AND status = 'SENDING'`,
        ).bind(now, now, id),
      ]);
    } catch {
      // SES may have accepted the message. Leave SENDING for the lease recovery
      // policy rather than making an unsafe second provider call.
      message.retry({ delaySeconds: defaultRetrySeconds });
      return;
    }
    message.ack();
  } catch (error) {
    const failure = deliveryError(error);
    const now = new Date().toISOString();
    const retryAfter = new Date(Date.now() + defaultRetrySeconds * 1000).toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE email_attempts
              SET status = ?, completed_at = ?, error_code = ?
            WHERE id = ? AND status = 'SENDING'`,
        ).bind(failure.temporary ? "TEMPORARY_FAILURE" : "PERMANENT_FAILURE", now, failure.code, attemptId),
        env.DB.prepare(
          `UPDATE email_notifications
              SET status = ?, terminal_at = ?, last_error_code = ?, status_reason = ?,
                  retry_after = ?, updated_at = ?
            WHERE id = ? AND status = 'SENDING'`,
        ).bind(
          failure.temporary ? "RETRY_PENDING" : "FAILED",
          failure.temporary ? null : now,
          failure.code,
          failure.code,
          failure.temporary ? retryAfter : null,
          now,
          id,
        ),
      ]);
    } catch {
      message.retry({ delaySeconds: defaultRetrySeconds });
      return;
    }
    if (failure.temporary) message.retry({ delaySeconds: defaultRetrySeconds });
    else message.ack();
  }
};

export const processEmailQueue = async (
  batch: QueueBatchLike,
  env: Env,
  sender: EmailSender = sesEmailSender,
): Promise<void> => {
  for (const message of batch.messages) await processQueueMessage(message, env, sender);
};

interface OutboxRow { id: string }

export const publishPendingEmailNotifications = async (env: Env, limit = 50): Promise<void> => {
  const boundedLimit = Number.isInteger(limit) ? Math.max(1, Math.min(100, limit)) : 50;
  const now = new Date().toISOString();
  const staleQueued = new Date(Date.now() - 2 * 60_000).toISOString();
  const due = await env.DB.prepare(
    `SELECT id FROM email_notifications
      WHERE status = 'PENDING'
         OR (status = 'RETRY_PENDING' AND last_error_code = 'QUEUE_PUBLISH_FAILED'
             AND (retry_after IS NULL OR retry_after <= ?))
         OR (status = 'QUEUED' AND (queued_at IS NULL OR queued_at <= ?))
      ORDER BY created_at, id
      LIMIT ?`,
  ).bind(now, staleQueued, boundedLimit).all<OutboxRow>();

  for (const notification of due.results) {
    const attemptId = crypto.randomUUID();
    const queuedAt = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO email_attempts
            (id, event_id, notification_id, attempt_number, stage, status, started_at)
           SELECT ?, n.event_id, n.id,
                  COALESCE((SELECT MAX(previous.attempt_number) FROM email_attempts previous
                             WHERE previous.notification_id = n.id), 0) + 1,
                  'QUEUE', 'PENDING', ?
             FROM email_notifications n
            WHERE n.id = ? AND (
              n.status = 'PENDING'
              OR (n.status = 'RETRY_PENDING' AND n.last_error_code = 'QUEUE_PUBLISH_FAILED')
              OR (n.status = 'QUEUED' AND (n.queued_at IS NULL OR n.queued_at <= ?))
            )`,
        ).bind(attemptId, queuedAt, notification.id, staleQueued),
        env.DB.prepare(
          `UPDATE email_notifications
              SET status = 'QUEUED', queued_at = ?, retry_after = NULL, updated_at = ?
            WHERE id = ? AND (
              status = 'PENDING'
              OR (status = 'RETRY_PENDING' AND last_error_code = 'QUEUE_PUBLISH_FAILED')
              OR (status = 'QUEUED' AND (queued_at IS NULL OR queued_at <= ?))
            )`,
        ).bind(queuedAt, queuedAt, notification.id, staleQueued),
      ]);
      const claimed = await env.DB.prepare(
        "SELECT 1 AS claimed FROM email_attempts WHERE id = ? AND status = 'PENDING' LIMIT 1",
      ).bind(attemptId).first<{ claimed: number }>();
      if (claimed === null) continue;
      // Queue messages contain only the durable notification identifier.
      await env.EMAIL_QUEUE.send(notification.id);
      const completedAt = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE email_attempts
              SET status = 'QUEUED', completed_at = ?, error_code = NULL
            WHERE id = ? AND status = 'PENDING'`,
        ).bind(completedAt, attemptId),
        env.DB.prepare(
          `UPDATE email_notifications
              SET last_error_code = NULL, status_reason = NULL, updated_at = ?
            WHERE id = ? AND status = 'QUEUED'`,
        ).bind(completedAt, notification.id),
      ]);
    } catch {
      const failedAt = new Date().toISOString();
      const retryAfter = new Date(Date.now() + defaultRetrySeconds * 1000).toISOString();
      try {
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE email_attempts
                SET status = 'TEMPORARY_FAILURE', completed_at = ?, error_code = 'QUEUE_PUBLISH_FAILED'
              WHERE id = ? AND status = 'PENDING'`,
          ).bind(failedAt, attemptId),
          env.DB.prepare(
            `UPDATE email_notifications
                SET status = 'RETRY_PENDING', last_error_code = 'QUEUE_PUBLISH_FAILED',
                    status_reason = 'QUEUE_PUBLISH_FAILED', retry_after = ?, updated_at = ?
              WHERE id = ? AND status = 'QUEUED'`,
          ).bind(retryAfter, failedAt, notification.id),
        ]);
      } catch {
        // A later scheduled scan safely republishes a stale QUEUED record.
      }
    }
  }
};

export const scheduleEmailOutbox = (env: Env, ctx: ExecutionContext | undefined): void => {
  if (ctx === undefined) return;
  const publication = publishPendingEmailNotifications(env).catch(() => undefined);
  try {
    ctx.waitUntil(publication);
  } catch {
    // A scheduled scan is the durable fallback; never replace a committed race response.
  }
};

export const listLocalEmailInbox = async (env: Env): Promise<RenderedRaceReminder[]> => {
  const rows = await env.DB.prepare(
    `SELECT n.id FROM email_notifications n
      WHERE n.status = 'SENT'
      ORDER BY n.sent_at, n.id
      LIMIT 500`,
  ).all<{ id: string }>();
  const messages: RenderedRaceReminder[] = [];
  for (const { id } of rows.results) {
    const row = await loadNotification(env, id);
    if (row === null || row.template_version !== 1) continue;
    const rendered = renderRaceReminder(row, env.APP_ORIGIN);
    if (rendered !== null) messages.push(rendered);
  }
  return messages;
};
