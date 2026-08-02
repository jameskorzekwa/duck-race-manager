import type { Env } from "./types.ts";
import { normalizeUsPhone } from "./registration.ts";

export const EMAIL_NOTIFICATION_TYPES = [
  "REGISTRATION_CONFIRMATION",
  "HEAT_ASSIGNED",
  "FINAL_ASSIGNED",
  "HEAT_UPCOMING",
  "RESULT",
] as const;

export type ParticipantNotificationType = typeof EMAIL_NOTIFICATION_TYPES[number];
export type ParticipantNotificationChannel = "EMAIL" | "SMS";

const sendableStatuses = new Set<string>(["PENDING", "QUEUED", "RETRY_PENDING"]);
const notificationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const textEncoder = new TextEncoder();
const currentEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export interface OutboundSms {
  to: string;
  text: string;
}

export type SmsSender = (sms: OutboundSms, env: Env) => Promise<EmailSendResult>;

export class SmsSendError extends Error {
  readonly safeCode: string;
  readonly retryable: boolean;

  constructor(safeCode: string, retryable: boolean) {
    super(safeCode);
    this.safeCode = safeCode;
    this.retryable = retryable;
  }
}

export interface ParticipantNotificationInsert {
  ids: string[];
  statements: D1PreparedStatement[];
}

interface ParticipantNotificationInput {
  eventId: string;
  registrationId: string;
  heatId?: string | null;
  duckAssignmentId?: string | null;
  notificationType: ParticipantNotificationType;
  commandId: string;
  now: string;
}

// Each domain command asks for both channels in the same D1 batch as its race
// mutation. The SELECT admits only a channel that is opted in and currently has
// a contact value. Delivery performs the same check again after claiming. The
// unique index is the final authority when a command or reconciliation replays.
export const participantNotificationStatements = (
  env: Env,
  input: ParticipantNotificationInput,
): ParticipantNotificationInsert => {
  const ids: string[] = [];
  const statements: D1PreparedStatement[] = [];
  for (const channel of ["EMAIL", "SMS"] as const) {
    const id = crypto.randomUUID();
    ids.push(id);
    const contactGuard = channel === "EMAIL"
      ? "r.email IS NOT NULL AND r.email_notifications_enabled = 1"
      : "r.phone IS NOT NULL AND r.sms_notifications_enabled = 1";
    // Prefix SMS storage types so a Worker rollback that predates `channel`
    // rejects the row as an unsupported template instead of accidentally
    // rendering it through the old email-only path. Support/API projections
    // remove the compatibility prefix and expose the logical lifecycle type.
    const storedNotificationType = channel === "EMAIL"
      ? input.notificationType
      : `SMS_${input.notificationType}`;
    statements.push(env.DB.prepare(
      `INSERT INTO email_notifications
        (id, event_id, registration_id, heat_id, duck_assignment_id,
         notification_type, channel, status, template_version,
         created_by_command_id, scheduled_at, updated_at)
       SELECT ?, r.event_id, r.id, ?, ?, ?, ?, 'PENDING', 1, ?, ?, ?
         FROM registrations r
        WHERE r.id = ? AND r.event_id = ?
          AND r.status IN ('SUBMITTED', 'ACTIVE')
          AND ${contactGuard}
          AND EXISTS (
            SELECT 1 FROM race_commands rc
             WHERE rc.id = ? AND rc.event_id = r.event_id
          )
       ON CONFLICT DO NOTHING`,
    ).bind(
      id,
      input.heatId ?? null,
      input.duckAssignmentId ?? null,
      storedNotificationType,
      channel,
      input.commandId,
      input.now,
      input.now,
      input.registrationId,
      input.eventId,
      input.commandId,
    ));
  }
  return { ids, statements };
};

interface NotificationRow {
  id: string;
  event_id: string;
  registration_id: string;
  duck_assignment_id: string | null;
  active_duck_assignment_id: string | null;
  notification_type: string;
  channel: ParticipantNotificationChannel;
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
  phone: string | null;
  sms_notifications_enabled: number;
  registration_status: string;
  heat_id: string | null;
  heat_entry_id: string | null;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  visible_number: number | null;
  result_place: number | null;
  advanced_to_final: number;
  earlier_unfinished_heat_count: number;
}

interface NotificationClaimRow {
  status: string;
  sending_started_at: string | null;
  retry_after: string | null;
  delivery_claim_token: string | null;
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
    || typeof env.AWS_ACCESS_KEY_ID !== "string"
    || env.AWS_ACCESS_KEY_ID.length < 16
    || typeof env.AWS_SECRET_ACCESS_KEY !== "string"
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
    // SES has no idempotency key. A network exception may follow provider
    // acceptance, so retrying would break the participant-visible at-most-once
    // guarantee. Fail closed and retain only this redacted uncertainty code.
    throw new EmailSendError("DELIVERY_OUTCOME_UNKNOWN", false);
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

const canonicalPhone = (value: string): string | null => {
  const normalized = normalizeUsPhone(value);
  if (normalized === null) return null;
  const digits = normalized.replace(/\D/g, "");
  return digits.length === 10 ? `+1${digits}` : null;
};

// AWS does provide carrier SMS: SNS direct-to-phone publishing uses AWS End
// User Messaging SMS for origination, carrier registration, and STOP handling.
// A single provider keeps credentials, suppression, and operational ownership
// beside the existing SES integration. SNS applies its managed opt-out list as
// part of Publish, immediately before accepting a delivery.
export const sendSmsWithSns: SmsSender = async (sms, env) => {
  const region = env.AWS_REGION;
  const phone = canonicalPhone(sms.to);
  if (
    region !== "us-east-1"
    || phone === null
    || typeof env.AWS_ACCESS_KEY_ID !== "string"
    || env.AWS_ACCESS_KEY_ID.length < 16
    || typeof env.AWS_SECRET_ACCESS_KEY !== "string"
    || env.AWS_SECRET_ACCESS_KEY.length < 32
  ) throw new SmsSendError("SNS_CONFIGURATION_INVALID", false);

  const parameters = new URLSearchParams();
  parameters.set("Action", "Publish");
  parameters.set("Message", sms.text);
  parameters.set("MessageAttributes.entry.1.Name", "AWS.SNS.SMS.SMSType");
  parameters.set("MessageAttributes.entry.1.Value.DataType", "String");
  parameters.set("MessageAttributes.entry.1.Value.StringValue", "Transactional");
  parameters.set("PhoneNumber", phone);
  parameters.set("Version", "2010-03-31");
  const body = parameters.toString();
  const host = `sns.${region}.amazonaws.com`;
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";
  const payloadHash = hex(await sha256(body));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${region}/sns/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(textEncoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, "sns");
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));

  let response: Response;
  try {
    response = await fetch(`https://${host}/`, {
      method: "POST",
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "content-type": contentType,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      body,
    });
  } catch {
    // Publish has no idempotency key. A connection loss can happen after AWS
    // accepted the SMS, so retrying it would violate the participant-visible
    // at-most-once promise. Record ambiguity terminally instead.
    throw new SmsSendError("DELIVERY_OUTCOME_UNKNOWN", false);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new SmsSendError(retryable ? "SNS_TEMPORARY_FAILURE" : "SNS_REJECTED", retryable);
  }
  let providerMessageId: string | null = null;
  try {
    const responseText = await response.text();
    const match = responseText.match(/<MessageId>([A-Za-z0-9._:/+=-]{1,256})<\/MessageId>/);
    providerMessageId = match?.[1] ?? null;
  } catch {
    // A 2xx response is acceptance even when its optional identifier is absent.
  }
  return { providerMessageId };
};

const notificationRow = (env: Env, notificationId: string): Promise<NotificationRow | null> =>
  env.DB.prepare(
    `SELECT n.id, n.event_id, n.registration_id, n.duck_assignment_id,
            da.id AS active_duck_assignment_id, n.notification_type,
            n.channel, n.template_version, n.status,
            n.sending_started_at, n.retry_after,
            e.name AS event_name, e.status AS event_status,
            r.first_name, r.last_name, r.email, r.email_notifications_enabled,
            r.phone, r.sms_notifications_enabled,
            r.status AS registration_status, n.heat_id,
            he.id AS heat_entry_id, h.round AS heat_round,
            h.heat_number, h.status AS heat_status, d.visible_number,
            hr.place AS result_place,
            CASE WHEN EXISTS (
              SELECT 1 FROM heat_entries promoted
               WHERE promoted.event_id = n.event_id
                 AND promoted.race_entry_id = re.id AND promoted.round = 'FINAL'
            ) THEN 1 ELSE 0 END AS advanced_to_final,
            CASE WHEN h.id IS NULL THEN 0 ELSE (
              SELECT COUNT(*) FROM heats earlier
               WHERE earlier.event_id = h.event_id AND earlier.round = h.round
                 AND earlier.heat_number < h.heat_number
                 AND earlier.status NOT IN ('FINALIZED', 'CANCELLED')
            ) END AS earlier_unfinished_heat_count
       FROM email_notifications n
       JOIN events e ON e.id = n.event_id
       JOIN registrations r ON r.id = n.registration_id AND r.event_id = n.event_id
       JOIN race_entries re ON re.registration_id = r.id AND re.event_id = n.event_id
       LEFT JOIN heats h ON h.id = n.heat_id AND h.event_id = n.event_id
       LEFT JOIN heat_entries he
         ON he.heat_id = n.heat_id AND he.race_entry_id = re.id AND he.event_id = n.event_id
        LEFT JOIN duck_assignments da
          ON da.race_entry_id = re.id AND da.event_id = n.event_id AND da.valid_to IS NULL
        LEFT JOIN duck_assignments originating_assignment
          ON originating_assignment.id = n.duck_assignment_id
         AND originating_assignment.event_id = n.event_id
        LEFT JOIN ducks d ON d.id = originating_assignment.duck_id
        LEFT JOIN heat_results hr
          ON hr.event_id = n.event_id AND hr.heat_id = n.heat_id
         AND hr.race_entry_id = re.id AND hr.status = 'FINALIZED'
      WHERE n.id = ?
      LIMIT 1`,
  ).bind(notificationId).first<NotificationRow>();

const notificationClaimRow = (env: Env, notificationId: string): Promise<NotificationClaimRow | null> =>
  env.DB.prepare(
    `SELECT status, sending_started_at, retry_after, delivery_claim_token
       FROM email_notifications
      WHERE id = ?
      LIMIT 1`,
  ).bind(notificationId).first<NotificationClaimRow>();

const cancelNotification = async (
  env: Env,
  notificationId: string,
  claimToken: string,
  reason: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = ?
        WHERE id = ? AND notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'`,
    ).bind(now, reason, claimToken, notificationId),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'CANCELLED', terminal_at = ?, status_reason = ?,
              last_error_code = NULL, retry_after = NULL,
              sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(now, reason, now, notificationId, claimToken),
  ]);
};

const failNotification = async (
  env: Env,
  notificationId: string,
  claimToken: string,
  code: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = ?
        WHERE id = ? AND notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'`,
    ).bind(now, code, claimToken, notificationId),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'FAILED', terminal_at = ?, last_error_code = ?,
              retry_after = NULL, sending_started_at = NULL,
              delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(now, code, now, notificationId, claimToken),
  ]);
};

// A stale SENDING row may mean the invocation stopped before calling its AWS
// provider, but it may also mean SES or SNS accepted delivery and D1 failed
// while recording that fact. Neither operation has an idempotency key, so retrying the ambiguous case can send
// a duplicate. Prefer a missed reminder to a duplicate: make the uncertainty a
// terminal, non-retryable support fact without calling the sender again.
const failAmbiguousDelivery = async (
  env: Env,
  notificationId: string,
  sendingStartedAt: string | null,
  claimToken: string | null,
): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?,
              error_code = 'DELIVERY_OUTCOME_UNKNOWN'
        WHERE notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'
          AND (id = ? OR ? IS NULL)`,
    ).bind(now, notificationId, claimToken, claimToken),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'FAILED', terminal_at = ?,
              status_reason = 'DELIVERY_OUTCOME_UNKNOWN',
              last_error_code = 'DELIVERY_OUTCOME_UNKNOWN', retry_after = NULL,
              sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING'
          AND (sending_started_at = ? OR (sending_started_at IS NULL AND ? IS NULL))
          AND (delivery_claim_token = ? OR (delivery_claim_token IS NULL AND ? IS NULL))`,
    ).bind(
      now,
      now,
      notificationId,
      sendingStartedAt,
      sendingStartedAt,
      claimToken,
      claimToken,
    ),
  ]);
};

const validationFailure = (row: NotificationRow): string | null => {
  const notificationType = logicalNotificationType(row);
  if (!(EMAIL_NOTIFICATION_TYPES as readonly string[]).includes(notificationType)) return "UNSUPPORTED_TEMPLATE";
  if (row.template_version !== 1) return "UNSUPPORTED_TEMPLATE";
  if (
    row.channel === "EMAIL"
    && (row.email_notifications_enabled !== 1 || row.email === null
      || row.email.length > 254 || !currentEmailPattern.test(row.email))
  ) {
    return "EMAIL_NOT_OPTED_IN";
  }
  if (
    row.channel === "SMS"
    && (row.sms_notifications_enabled !== 1 || row.phone === null || normalizeUsPhone(row.phone) === null)
  ) {
    return "SMS_NOT_OPTED_IN";
  }
  if (notificationType === "REGISTRATION_CONFIRMATION") {
    return new Set(["SUBMITTED", "ACTIVE"]).has(row.registration_status) ? null : "REGISTRATION_NOT_ACTIVE";
  }
  if (row.registration_status !== "ACTIVE") return "REGISTRATION_NOT_ACTIVE";
  if (
    row.duck_assignment_id === null
    || row.heat_id === null || row.heat_entry_id === null || row.heat_round === null
    || row.heat_number === null || row.visible_number === null
  ) return "RACE_ASSIGNMENT_CHANGED";
  if (
    notificationType !== "RESULT"
    && (row.active_duck_assignment_id === null || row.duck_assignment_id !== row.active_duck_assignment_id)
  ) return "RACE_ASSIGNMENT_CHANGED";
  if (
    notificationType === "HEAT_ASSIGNED"
    && (row.heat_round !== "ROUND_ONE"
      || !new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? ""))
  ) return "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  if (
    notificationType === "FINAL_ASSIGNED"
    && (row.heat_round !== "FINAL" || new Set(["FINALIZED", "CANCELLED"]).has(row.heat_status ?? ""))
  ) return "FINAL_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  if (
    notificationType === "HEAT_UPCOMING"
    && (!new Set(["LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
      || row.earlier_unfinished_heat_count !== 0
      || (row.heat_round === "ROUND_ONE" && row.event_status !== "ROUND_ONE")
      || (row.heat_round === "FINAL" && row.event_status !== "FINAL"))
  ) {
    return "HEAT_NO_LONGER_UPCOMING";
  }
  if (notificationType === "RESULT" && row.heat_status !== "FINALIZED") {
    return "RESULT_NO_LONGER_OFFICIAL";
  }
  return null;
};

const ordinal = (place: number): string => {
  const remainder = place % 100;
  if (remainder >= 11 && remainder <= 13) return `${place}th`;
  const suffix = place % 10 === 1 ? "st" : place % 10 === 2 ? "nd" : place % 10 === 3 ? "rd" : "th";
  return `${place}${suffix}`;
};

const logicalNotificationType = (row: Pick<NotificationRow, "channel" | "notification_type">): string =>
  row.channel === "SMS" && row.notification_type.startsWith("SMS_")
    ? row.notification_type.slice(4)
    : row.notification_type;

const notificationCopy = (row: NotificationRow): { subject: string; action: string } => {
  const round = row.heat_round === "FINAL" ? "Final" : "Round One";
  const heat = `${round}, Heat ${row.heat_number}`;
  const duck = `Duck #${row.visible_number}`;
  switch (logicalNotificationType(row)) {
    case "REGISTRATION_CONFIRMATION":
      return {
        subject: `Registration confirmed for ${singleLine(row.event_name)}`,
        action: "Your registration is confirmed. Keep My Ducks available for race updates and your current status.",
      };
    case "HEAT_ASSIGNED":
      return {
        subject: `${duck} is assigned to ${heat}`,
        action: `${duck} is assigned to ${heat}. Please stay near the pond and listen for your heat to be called.`,
      };
    case "FINAL_ASSIGNED":
      return {
        subject: `${duck} advanced to the Final`,
        action: `${duck} advanced and is assigned to ${heat}. Please stay near the pond.`,
      };
    case "HEAT_UPCOMING":
      return {
        subject: `${heat} is next to race`,
        action: `${heat} is next to race. Please bring ${duck} to the pond.`,
      };
    case "RESULT":
      if (row.heat_round === "ROUND_ONE") {
        return row.advanced_to_final === 1
          ? { subject: `${duck} advanced to the Final`, action: `${duck} won ${heat} and advanced to the Final.` }
          : { subject: `${heat} result is official`, action: `${heat} is official. ${duck} did not advance to the Final.` };
      }
      return row.result_place === null
        ? { subject: "The Final result is official", action: `The Final result is official. ${duck} finished outside the podium.` }
        : {
          subject: `${duck} finished ${ordinal(row.result_place)} in the Final`,
          action: `${duck} finished ${ordinal(row.result_place)} in the Final.`,
        };
    default:
      return { subject: "QuickDucks race update", action: "Your race status has changed." };
  }
};

const renderEmail = (row: NotificationRow, env: Env): OutboundEmail => {
  const eventName = singleLine(row.event_name);
  const participantName = singleLine(`${row.first_name} ${row.last_name}`);
  const raceUrl = new URL("/race", env.APP_ORIGIN).toString();
  const { subject, action } = notificationCopy(row);
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

const renderSms = (row: NotificationRow, env: Env): OutboundSms => {
  const { action } = notificationCopy(row);
  return {
    to: row.phone!,
    text: singleLine(`QuickDucks: ${action} Status: ${new URL("/race", env.APP_ORIGIN)} Reply STOP to stop texts.`),
  };
};

export const processEmailNotification = async (
  env: Env,
  notificationId: string,
  sender: EmailSender = sendEmailWithSes,
  queueDeliveryAttempt = 1,
  smsSender: SmsSender = sendSmsWithSns,
): Promise<EmailProcessingResult> => {
  if (!notificationIdPattern.test(notificationId)) return "NOOP";
  const claimRow = await notificationClaimRow(env, notificationId);
  if (claimRow === null) return "NOOP";
  const staleSendingBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  if (claimRow.status === "SENDING") {
    if (
      claimRow.sending_started_at !== null
      && claimRow.sending_started_at >= staleSendingBefore
    ) return "RETRY";
    await failAmbiguousDelivery(
      env,
      notificationId,
      claimRow.sending_started_at,
      claimRow.delivery_claim_token,
    );
    return "FAILED";
  }
  if (!sendableStatuses.has(claimRow.status)) return "NOOP";
  if (claimRow.retry_after !== null && claimRow.retry_after > new Date().toISOString()) return "RETRY";

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
        `UPDATE email_notifications
            SET status = 'SENDING', sending_started_at = ?,
                delivery_claim_token = ?, updated_at = ?
          WHERE id = ? AND status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')
            AND (retry_after IS NULL OR retry_after <= ?)`,
      ).bind(now, attemptId, now, notificationId, now),
      env.DB.prepare(
        `INSERT INTO email_attempts
          (id, event_id, notification_id, attempt_number, stage, status, started_at)
         SELECT ?, event_id, id, ?, 'DELIVERY', 'SENDING', ?
            FROM email_notifications
           WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(attemptId, attemptNumber, now, notificationId, attemptId),
    ]);
  } catch {
    return "RETRY";
  }
  const claimed = await env.DB.prepare(
    "SELECT 1 AS claimed FROM email_attempts WHERE id = ? AND status = 'SENDING' LIMIT 1",
  ).bind(attemptId).first<{ claimed: number }>();
  if (claimed === null) return "RETRY";

  // Recipient, consent, assignment, and lifecycle state can all change while a
  // queue message is waiting. Claim first, then reload the authoritative join
  // so no pre-claim snapshot is rendered or sent.
  const row = await notificationRow(env, notificationId);
  if (row === null) {
    await cancelNotification(env, notificationId, attemptId, "RACE_ASSIGNMENT_CHANGED");
    return "CANCELLED";
  }
  const invalid = validationFailure(row);
  if (invalid === "UNSUPPORTED_TEMPLATE") {
    await failNotification(env, notificationId, attemptId, invalid);
    return "FAILED";
  }
  if (invalid !== null) {
    await cancelNotification(env, notificationId, attemptId, invalid);
    return "CANCELLED";
  }

  let result: EmailSendResult;
  try {
    result = row.channel === "EMAIL"
      ? await sender(renderEmail(row, env), env)
      : await smsSender(renderSms(row, env), env);
  } catch (error) {
    const failure = error instanceof EmailSendError || error instanceof SmsSendError
      ? error
      : new EmailSendError("NOTIFICATION_SENDER_FAILURE", true);
    const completedAt = new Date().toISOString();
    const retryAttempt = Math.max(attemptNumber, queueDeliveryAttempt);
    const exhausted = failure.retryable && retryAttempt >= 5;
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
            SET status = ?, sending_started_at = NULL,
                delivery_claim_token = NULL, terminal_at = ?,
                last_error_code = ?, retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(
        retryable ? "QUEUED" : "FAILED",
        retryable ? null : completedAt,
        code,
        retryable ? isoAfter(Math.min(15 * 60_000, 60_000 * (2 ** Math.max(0, retryAttempt - 1)))) : null,
        completedAt,
        notificationId,
        attemptId,
      ),
    ]);
    return retryable ? "RETRY" : "FAILED";
  }

  const providerMessageId = typeof result.providerMessageId === "string"
      && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.providerMessageId)
    ? result.providerMessageId
    : null;
  const sentAt = new Date().toISOString();
  // Keep this outside the sender-error catch. Once AWS has accepted delivery,
  // a D1 failure is an ambiguous post-send outcome, not a temporary send
  // failure. The row remains SENDING and stale recovery terminally fails it
  // rather than ever calling the provider a second time.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'SENT', completed_at = ?, provider_message_id = ?, error_code = NULL
        WHERE id = ? AND status = 'SENDING'`,
    ).bind(sentAt, providerMessageId, attemptId),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'SENT', sent_at = ?, sending_started_at = NULL,
              delivery_claim_token = NULL, status_reason = ?,
              last_error_code = NULL, retry_after = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(sentAt, row.channel === "EMAIL" ? "SES_ACCEPTED" : "SNS_ACCEPTED", sentAt, notificationId, attemptId),
  ]);
  return "SENT";
};

const publishEmailNotificationUnsafe = async (env: Env, notificationId: string): Promise<void> => {
  if (!notificationIdPattern.test(notificationId)) return;
  const staleQueuedBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  const now = new Date().toISOString();
  const notification = await env.DB.prepare(
    `SELECT id, event_id, status
       FROM email_notifications
      WHERE id = ?
        AND (status IN ('PENDING', 'RETRY_PENDING')
          OR (status = 'QUEUED' AND queued_at <= ?
            AND (retry_after IS NULL OR retry_after <= ?)))
      LIMIT 1`,
  ).bind(notificationId, staleQueuedBefore, now).first<{ id: string; event_id: string; status: string }>();
  if (notification === null) return;

  const startedAt = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  const lastAttempt = await env.DB.prepare(
    "SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt FROM email_attempts WHERE notification_id = ? AND stage = 'QUEUE'",
  ).bind(notificationId).first<AttemptNumberRow>();
  const attemptNumber = Number(lastAttempt?.last_attempt ?? 0) + 1;
  if (attemptNumber > 5) {
    await env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'FAILED', terminal_at = ?, last_error_code = 'QUEUE_RETRIES_EXHAUSTED',
              retry_after = NULL, updated_at = ?
        WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING', 'QUEUED')`,
    ).bind(now, now, notificationId).run();
    return;
  }
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
          WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING', 'QUEUED')`,
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
              SET status = ?, terminal_at = ?,
                  last_error_code = ?, retry_after = ?, updated_at = ?
            WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING', 'QUEUED')`,
        ).bind(
          attemptNumber >= 5 ? "FAILED" : "RETRY_PENDING",
          attemptNumber >= 5 ? completedAt : null,
          attemptNumber >= 5 ? "QUEUE_RETRIES_EXHAUSTED" : "QUEUE_PUBLISH_FAILED",
          attemptNumber >= 5 ? null : isoAfter(Math.min(15 * 60_000, 60_000 * (2 ** (attemptNumber - 1)))),
          completedAt,
          notificationId,
        ),
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

export const publishParticipantNotifications = async (env: Env, notificationIds: readonly string[]): Promise<void> => {
  for (const notificationId of notificationIds) await publishEmailNotification(env, notificationId);
};

export const dispatchPendingEmailNotifications = async (env: Env): Promise<void> => {
  const now = new Date().toISOString();
  const staleQueuedBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  const pending = await env.DB.prepare(
    `SELECT id
       FROM email_notifications
      WHERE (status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= ?))
          OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?))
          OR (status = 'QUEUED' AND queued_at <= ?
            AND (retry_after IS NULL OR retry_after <= ?))
      ORDER BY created_at, id
      LIMIT 100`,
  ).bind(now, now, staleQueuedBefore, now).all<{ id: string }>();
  for (const notification of pending.results) await publishEmailNotification(env, notification.id);
};

export const handleEmailQueue = async (
  batch: MessageBatch<unknown>,
  env: Env,
  sender: EmailSender = sendEmailWithSes,
  smsSender: SmsSender = sendSmsWithSns,
): Promise<void> => {
  for (const message of batch.messages) {
    if (typeof message.body !== "string" || !notificationIdPattern.test(message.body)) {
      message.ack();
      continue;
    }
    try {
      const result = await processEmailNotification(env, message.body, sender, message.attempts, smsSender);
      if (result === "RETRY") {
        message.retry({ delaySeconds: Math.min(900, 60 * (2 ** Math.max(0, message.attempts - 1))) });
      }
      else message.ack();
    } catch {
      // Unexpected infrastructure failures are left to the bounded queue retry
      // policy and then the configured DLQ. No provider/request material is
      // logged or copied into the retry request.
      message.retry({ delaySeconds: Math.min(900, 60 * (2 ** Math.max(0, message.attempts - 1))) });
    }
  }
};
