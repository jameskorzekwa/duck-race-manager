import { normalizeUsPhone } from "./registration.ts";
import type { Env } from "./types.ts";

export const EMAIL_NOTIFICATION_TYPES = [
  "REGISTRATION_CONFIRMED",
  "HEAT_ASSIGNED",
  "FINAL_ASSIGNED",
  "HEAT_UPCOMING",
  "ROUND_RESULT",
  "FINAL_RESULT",
] as const;

export type NotificationType = typeof EMAIL_NOTIFICATION_TYPES[number];
export type NotificationChannel = "EMAIL" | "SMS";

const sendableStatuses = new Set<string>(["PENDING", "QUEUED", "RETRY_PENDING"]);
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

export interface OutboundSms {
  to: string;
  text: string;
}

export interface ParticipantNotificationTarget {
  eventId: string;
  registrationId: string;
  heatId: string | null;
  type: NotificationType;
  lifecycleKey: string;
  commandId: string;
  commandType: string;
  now: string;
  resultRevision?: number | null;
  resultPlace?: number | null;
  requireAuthoritativeUpcoming?: boolean;
}

/**
 * Creates both channel candidates inside the domain transaction that caused the
 * notification. Each INSERT rechecks current consent and the event SMS switch;
 * the dispatcher repeats those checks immediately before provider submission.
 */
export const participantNotificationStatements = (
  env: Env,
  target: ParticipantNotificationTarget,
): { ids: string[]; statements: D1PreparedStatement[] } => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const channels: NotificationChannel[] = ["EMAIL", "SMS"];
  const authoritativeUpcomingGuard = target.requireAuthoritativeUpcoming === true
    ? `AND EXISTS (
         SELECT 1 FROM heats candidate
          WHERE candidate.id = ? AND candidate.event_id = r.event_id
            AND candidate.status IN ('LOADING', 'READY', 'CALLING')
            AND NOT EXISTS (
              SELECT 1 FROM heats earlier
               WHERE earlier.event_id = candidate.event_id AND earlier.round = candidate.round
                 AND earlier.heat_number < candidate.heat_number
                 AND earlier.status NOT IN ('FINALIZED', 'CANCELLED')
            )
            AND NOT EXISTS (
              SELECT 1 FROM heats active
               WHERE active.event_id = candidate.event_id AND active.id <> candidate.id
                 AND active.status IN ('RUNNING', 'AWAITING_RESULT')
            )
       )`
    : "";
  return {
    ids,
    statements: channels.map((channel, index) => env.DB.prepare(
      `INSERT INTO email_notifications
        (id, event_id, registration_id, heat_id, duck_assignment_id,
         notification_type, channel, lifecycle_key, status, template_version,
         result_place, result_revision, advanced_to_final,
         created_by_command_id, scheduled_at, updated_at)
       SELECT ?, r.event_id, r.id, ?,
              CASE WHEN ? IS NULL THEN NULL ELSE (
                SELECT da.id FROM race_entries re
                JOIN duck_assignments da
                  ON da.race_entry_id = re.id AND da.event_id = re.event_id AND da.valid_to IS NULL
                WHERE re.registration_id = r.id LIMIT 1
              ) END,
              ?, ?, ?, 'PENDING', 1, ?, ?, ?, ?, ?, ?
         FROM registrations r JOIN events e ON e.id = r.event_id
        WHERE r.id = ? AND r.event_id = ? AND r.status IN ('SUBMITTED', 'ACTIVE')
          AND EXISTS (SELECT 1 FROM race_commands c
                       WHERE c.id = ? AND c.event_id = r.event_id AND c.command_type = ?)
           AND ((? = 'EMAIL' AND r.email IS NOT NULL AND r.email_notifications_enabled = 1)
             OR (? = 'SMS' AND e.sms_notifications_enabled = 1
               AND r.phone IS NOT NULL AND r.sms_notifications_enabled = 1))
           ${authoritativeUpcomingGuard}
        ON CONFLICT DO UPDATE SET
          duck_assignment_id = excluded.duck_assignment_id,
          status = 'PENDING', terminal_at = NULL, status_reason = NULL,
          last_error_code = NULL, retry_after = NULL,
          created_by_command_id = excluded.created_by_command_id,
          scheduled_at = excluded.scheduled_at, updated_at = excluded.updated_at
        WHERE excluded.notification_type = 'HEAT_UPCOMING'
          AND email_notifications.status = 'CANCELLED'
          AND email_notifications.status_reason = 'HEAT_NO_LONGER_NEXT'`,
    ).bind(
      ids[index], target.heatId, target.heatId,
      target.type, channel, target.lifecycleKey,
      target.resultPlace ?? null,
      target.resultRevision ?? null,
      target.type === "ROUND_RESULT" ? (target.resultPlace === 1 ? 1 : 0) : null,
      target.commandId, target.now, target.now,
      target.registrationId, target.eventId, target.commandId, target.commandType,
      channel, channel,
      ...(target.requireAuthoritativeUpcoming === true ? [target.heatId] : []),
    )),
  };
};

export type SmsSender = (sms: OutboundSms, env: Env) => Promise<EmailSendResult>;

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
  channel: "EMAIL" | "SMS";
  duck_assignment_id: string | null;
  active_duck_assignment_id: string | null;
  notification_type: string;
  lifecycle_key: string | null;
  result_place: number | null;
  result_revision: number | null;
  advanced_to_final: number | null;
  template_version: number;
  status: string;
  sending_started_at: string | null;
  retry_after: string | null;
  event_name: string;
  event_status: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  email_notifications_enabled: number;
  sms_notifications_enabled: number;
  event_sms_notifications_enabled: number;
  registration_status: string;
  heat_id: string | null;
  heat_entry_id: string | null;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  heat_run_sequence: number | null;
  unfinished_predecessor_count: number;
  active_other_heat_count: number;
  official_result_revision: number | null;
  visible_number: number | null;
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

const withDeadline = async <T>(operation: Promise<T>, milliseconds = 10_000): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("OPERATION_DEADLINE_EXCEEDED")), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

const singleLine = (value: string): string => value
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const validEmailDestination = (email: string): boolean =>
  email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const smsDestination = (phone: string): string | null => {
  const normalized = normalizeUsPhone(phone);
  if (normalized === null) return null;
  const destination = `+1${normalized.replace(/\D/g, "")}`;
  return /^\+1[2-9][0-9]{9}$/.test(destination) ? destination : null;
};

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

const keyedDigest = async (env: Env, domain: string, value: string): Promise<string> => {
  if (typeof env.NOTIFICATION_HMAC_SECRET !== "string" || env.NOTIFICATION_HMAC_SECRET.length < 32) {
    throw new EmailSendError("NOTIFICATION_HMAC_CONFIGURATION_INVALID", false);
  }
  return hex(await hmac(textEncoder.encode(env.NOTIFICATION_HMAC_SECRET), `${domain}\0${value}`));
};

const awsEncode = (value: string): string => encodeURIComponent(value)
  .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

const signedAwsHeaders = async (
  env: Env,
  service: string,
  method: string,
  host: string,
  path: string,
  query: string,
  body: string,
  target?: string,
): Promise<Record<string, string>> => {
  const payloadHash = hex(await sha256(body));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const contentType = target === undefined ? "application/json" : "application/x-amz-json-1.0";
  const signedHeaders = target === undefined
    ? "content-type;host;x-amz-content-sha256;x-amz-date"
    : "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-target";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
    + (target === undefined ? "" : `x-amz-target:${target}\n`);
  const canonicalRequest = `${method}\n${path}\n${query}\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${env.AWS_REGION}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(textEncoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmac(dateKey, env.AWS_REGION);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "content-type": contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...(target === undefined ? {} : { "x-amz-target": target }),
  };
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
    response = await withDeadline(fetch(`https://${host}${path}`, {
      method: "POST",
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "content-type": "application/json",
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    }));
  } catch {
    // SES has no provider idempotency key. A connection can fail after SES
    // accepted the request, so this outcome must never be submitted again.
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

const validAwsRuntime = (env: Env): boolean => env.AWS_REGION === "us-east-1"
  && typeof env.AWS_ACCESS_KEY_ID === "string" && env.AWS_ACCESS_KEY_ID.length >= 16
  && typeof env.AWS_SECRET_ACCESS_KEY === "string" && env.AWS_SECRET_ACCESS_KEY.length >= 32;

const validSmsConfiguration = (env: Env): boolean => validAwsRuntime(env)
  && typeof env.SMS_ORIGINATION_IDENTITY === "string"
  && /^[A-Za-z0-9+_.:/-]{1,256}$/.test(env.SMS_ORIGINATION_IDENTITY)
  && typeof env.SMS_OPT_OUT_LIST_NAME === "string"
  && /^[A-Za-z0-9_:/-]{1,256}$/.test(env.SMS_OPT_OUT_LIST_NAME)
  && typeof env.NOTIFICATION_HMAC_SECRET === "string"
  && env.NOTIFICATION_HMAC_SECRET.length >= 32;

const awsErrorType = async (response: Response): Promise<string | null> => {
  const header = response.headers.get("x-amzn-errortype");
  if (header !== null) {
    const type = header.split(":", 1)[0];
    if (/^[A-Za-z]+Exception$/.test(type)) return type;
  }
  try {
    const body = await response.json() as { __type?: unknown };
    if (typeof body.__type !== "string") return null;
    const type = body.__type.split(/[#:]|\//).at(-1) ?? "";
    return /^[A-Za-z]+Exception$/.test(type) ? type : null;
  } catch {
    return null;
  }
};

const awsResponseRetryable = async (response: Response): Promise<boolean> =>
  response.status === 408 || response.status === 429 || response.status >= 500
  || (response.status === 400 && await awsErrorType(response) === "ThrottlingException");

export const sendSmsWithAws: SmsSender = async (sms, env) => {
  if (!validSmsConfiguration(env) || !/^\+1[2-9][0-9]{9}$/.test(sms.to)) {
    throw new EmailSendError("SMS_CONFIGURATION_INVALID", false);
  }
  const host = `sms-voice.${env.AWS_REGION}.amazonaws.com`;
  const path = "/";
  const target = "PinpointSMSVoiceV2.SendTextMessage";
  const body = JSON.stringify({
    DestinationPhoneNumber: sms.to,
    OriginationIdentity: env.SMS_ORIGINATION_IDENTITY,
    MessageBody: sms.text,
    MessageType: "TRANSACTIONAL",
    TimeToLive: 300,
  });
  const headers = await signedAwsHeaders(env, "sms-voice", "POST", host, path, "", body, target);
  let response: Response;
  try {
    response = await withDeadline(fetch(`https://${host}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    }));
  } catch {
    throw new EmailSendError("DELIVERY_OUTCOME_UNKNOWN", false);
  }
  if (!response.ok) {
    const retryable = await awsResponseRetryable(response);
    throw new EmailSendError(retryable ? "SMS_TEMPORARY_FAILURE" : "SMS_REJECTED", retryable);
  }
  let providerMessageId: string | null = null;
  try {
    const result = await response.json() as { MessageId?: unknown };
    if (typeof result.MessageId === "string" && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.MessageId)) {
      providerMessageId = result.MessageId;
    }
  } catch {
    // A successful provider response is acceptance even without a usable id.
  }
  return { providerMessageId };
};

export const isEmailSuppressedBySes = async (email: string, env: Env): Promise<boolean> => {
  if (!validAwsRuntime(env)) throw new EmailSendError("SES_CONFIGURATION_INVALID", false);
  const host = `email.${env.AWS_REGION}.amazonaws.com`;
  const path = `/v2/email/suppression/addresses/${awsEncode(email)}`;
  const headers = await signedAwsHeaders(env, "ses", "GET", host, path, "", "");
  try {
    const response = await withDeadline(fetch(`https://${host}${path}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    }));
    if (response.status === 404) return false;
    if (response.ok) return true;
    throw new EmailSendError("SES_SUPPRESSION_CHECK_FAILED", true);
  } catch (error) {
    if (error instanceof EmailSendError) throw error;
    throw new EmailSendError("SES_SUPPRESSION_CHECK_FAILED", true);
  }
};

export const isSmsOptedOutByAws = async (phone: string, env: Env): Promise<boolean> => {
  if (!validSmsConfiguration(env)) throw new EmailSendError("SMS_CONFIGURATION_INVALID", false);
  const host = `sms-voice.${env.AWS_REGION}.amazonaws.com`;
  const path = "/";
  const target = "PinpointSMSVoiceV2.DescribeOptedOutNumbers";
  let nextToken: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page += 1) {
    const body = JSON.stringify({
      MaxResults: 100,
      OptOutListName: env.SMS_OPT_OUT_LIST_NAME,
      ...(nextToken === null ? {} : { NextToken: nextToken }),
    });
    const headers = await signedAwsHeaders(env, "sms-voice", "POST", host, path, "", body, target);
    let response: Response;
    try {
      response = await withDeadline(fetch(`https://${host}${path}`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(10_000),
      }));
    } catch {
      throw new EmailSendError("SMS_SUPPRESSION_CHECK_FAILED", true);
    }
    if (!response.ok) throw new EmailSendError("SMS_SUPPRESSION_CHECK_FAILED", await awsResponseRetryable(response));
    let result: { OptedOutNumbers?: unknown; NextToken?: unknown };
    try {
      result = await response.json() as { OptedOutNumbers?: unknown; NextToken?: unknown };
    } catch {
      throw new EmailSendError("SMS_SUPPRESSION_CHECK_FAILED", true);
    }
    const numbers = Array.isArray(result.OptedOutNumbers) ? result.OptedOutNumbers : [];
    if (numbers.some((entry) => entry !== null && typeof entry === "object"
      && (entry as { OptedOutNumber?: unknown }).OptedOutNumber === phone)) return true;
    if (result.NextToken === undefined || result.NextToken === null || result.NextToken === "") return false;
    if (typeof result.NextToken !== "string" || result.NextToken.length > 1024 || seen.has(result.NextToken)) {
      throw new EmailSendError("SMS_SUPPRESSION_CHECK_FAILED", true);
    }
    seen.add(result.NextToken);
    nextToken = result.NextToken;
  }
  throw new EmailSendError("SMS_SUPPRESSION_CHECK_FAILED", true);
};

const notificationRow = (env: Env, notificationId: string): Promise<NotificationRow | null> =>
  env.DB.prepare(
    `SELECT n.id, n.event_id, n.registration_id, n.channel, n.duck_assignment_id,
            da.id AS active_duck_assignment_id, n.notification_type,
            n.lifecycle_key, n.result_place, n.result_revision, n.advanced_to_final,
            n.template_version, n.status,
            n.sending_started_at, n.retry_after,
            e.name AS event_name, e.status AS event_status,
            r.first_name, r.last_name, r.email, r.phone,
            r.email_notifications_enabled, r.sms_notifications_enabled,
            e.sms_notifications_enabled AS event_sms_notifications_enabled,
            r.status AS registration_status, n.heat_id,
            he.id AS heat_entry_id, h.round AS heat_round,
            h.heat_number, h.status AS heat_status,
            h.run_sequence AS heat_run_sequence,
            (SELECT COUNT(*) FROM heats earlier
              WHERE h.id IS NOT NULL AND earlier.event_id = h.event_id
                AND earlier.round = h.round AND earlier.heat_number < h.heat_number
                AND earlier.status NOT IN ('FINALIZED', 'CANCELLED')) AS unfinished_predecessor_count,
            (SELECT COUNT(*) FROM heats active
              WHERE h.id IS NOT NULL AND active.event_id = h.event_id AND active.id <> h.id
                AND active.status IN ('RUNNING', 'AWAITING_RESULT')) AS active_other_heat_count,
            (SELECT MAX(hr.revision) FROM heat_results hr
              WHERE hr.event_id = n.event_id AND hr.heat_id = n.heat_id
                AND hr.status = 'FINALIZED') AS official_result_revision,
            d.visible_number
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

const suppressNotification = async (
  env: Env,
  row: NotificationRow,
  claimToken: string,
  destinationHash: string,
  source: "PROVIDER" | "STAFF" | "EMAIL_UNSUBSCRIBE",
): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notification_suppressions
        (id, event_id, registration_id, channel, destination_hash, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel, destination_hash) DO NOTHING`,
    ).bind(crypto.randomUUID(), row.event_id, row.registration_id, row.channel, destinationHash, source, now),
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = 'DESTINATION_SUPPRESSED'
        WHERE id = ? AND notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'`,
    ).bind(now, claimToken, row.id),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'SUPPRESSED', terminal_at = ?, status_reason = 'DESTINATION_SUPPRESSED',
              destination_hash = ?, last_error_code = NULL, retry_after = NULL,
              sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(now, destinationHash, now, row.id, claimToken),
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

// A stale SENDING row may mean the invocation stopped before calling SES, but it
// may also mean SES accepted the email and D1 failed while recording that fact.
// SES SendEmail has no idempotency key, so retrying the ambiguous case can send
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
  if (!(EMAIL_NOTIFICATION_TYPES as readonly string[]).includes(row.notification_type)) return "UNSUPPORTED_TEMPLATE";
  if (row.template_version !== 1) return "UNSUPPORTED_TEMPLATE";
  if (row.channel === "EMAIL") {
    if (row.email_notifications_enabled !== 1 || row.email === null) return "EMAIL_NOT_OPTED_IN";
    if (!validEmailDestination(row.email)) return "EMAIL_DESTINATION_INVALID";
  } else if (row.channel === "SMS") {
    if (row.event_sms_notifications_enabled !== 1) return "SMS_DISABLED_FOR_EVENT";
    if (row.sms_notifications_enabled !== 1 || row.phone === null) return "SMS_NOT_OPTED_IN";
    if (smsDestination(row.phone) === null) return "SMS_DESTINATION_INVALID";
  } else return "UNSUPPORTED_TEMPLATE";
  if (row.notification_type === "REGISTRATION_CONFIRMED") {
    if (!new Set(["SUBMITTED", "ACTIVE"]).has(row.registration_status)) return "REGISTRATION_NOT_ACTIVE";
  } else if (row.registration_status !== "ACTIVE") return "REGISTRATION_NOT_ACTIVE";
  if (!new Set(["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED"]).has(row.event_status)) {
    return "EVENT_NO_LONGER_ACTIVE";
  }
  const assignmentNotification = new Set(["HEAT_ASSIGNED", "FINAL_ASSIGNED", "HEAT_UPCOMING"])
    .has(row.notification_type);
  if (assignmentNotification && (
    row.duck_assignment_id === null
    || row.active_duck_assignment_id === null
    || row.duck_assignment_id !== row.active_duck_assignment_id
    || row.heat_id === null || row.heat_entry_id === null || row.heat_round === null
    || row.heat_number === null || row.visible_number === null
  )) return "RACE_ASSIGNMENT_CHANGED";
  if (
    new Set(["HEAT_ASSIGNED", "FINAL_ASSIGNED"]).has(row.notification_type)
    && !new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
  ) return "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  if (row.notification_type === "HEAT_UPCOMING" && (
    !new Set(["LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
    || row.lifecycle_key !== `run:${row.heat_run_sequence}`
  )) {
    return "HEAT_NO_LONGER_UPCOMING";
  }
  if (row.notification_type === "HEAT_UPCOMING"
    && (row.unfinished_predecessor_count > 0 || row.active_other_heat_count > 0)) {
    return "HEAT_NO_LONGER_NEXT";
  }
  if (new Set(["ROUND_RESULT", "FINAL_RESULT"]).has(row.notification_type)) {
    if (row.heat_id === null || row.heat_entry_id === null || row.heat_status !== "FINALIZED") {
      return "RESULT_NO_LONGER_OFFICIAL";
    }
    if (row.result_revision === null || row.official_result_revision !== row.result_revision) {
      return "RESULT_REVISION_SUPERSEDED";
    }
  }
  return null;
};

const base64Url = (value: Uint8Array | string): string => {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const ordinal = (place: number): string => {
  const tens = place % 100;
  const ones = place % 10;
  return `${place}${tens >= 11 && tens <= 13 ? "th" : ones === 1 ? "st" : ones === 2 ? "nd" : ones === 3 ? "rd" : "th"}`;
};

const notificationAction = (row: NotificationRow): { subject: string; action: string } => {
  const round = row.heat_round === "FINAL" ? "Final" : "Round One";
  const heat = row.heat_number === null ? round : `${round}, Heat ${row.heat_number}`;
  const duck = row.visible_number === null ? "Your duck" : `Duck #${row.visible_number}`;
  switch (row.notification_type) {
    case "REGISTRATION_CONFIRMED":
      return { subject: `Registration confirmed for ${row.event_name}`, action: `Your registration for ${row.event_name} is confirmed.` };
    case "HEAT_ASSIGNED":
    case "FINAL_ASSIGNED":
      return {
        subject: `${duck} is assigned to ${heat}`,
        action: `${duck} is assigned to ${heat}. Please stay near the pond and listen for your heat to be called.`,
      };
    case "HEAT_UPCOMING":
      return { subject: `${heat} is coming up next`, action: `${heat} is coming up next. Please bring ${duck} to the pond.` };
    case "ROUND_RESULT":
      if (row.advanced_to_final === 1) {
        return {
          subject: `${heat} result is official`,
          action: `You placed ${ordinal(row.result_place ?? 1)} in ${heat} and advanced to the Final.`,
        };
      }
      return {
        subject: `${heat} result is official`,
        action: row.result_place === null
          ? `Your result for ${heat} is official. You did not advance to the Final.`
          : `You placed ${ordinal(row.result_place)} in ${heat}. You did not advance to the Final.`,
      };
    case "FINAL_RESULT":
      return {
        subject: "The Final result is official",
        action: row.result_place === null
          ? "Your Final result is official. Thank you for racing."
          : `You placed ${ordinal(row.result_place)} in the Final.`,
      };
    default:
      return { subject: "QuickDucks race update", action: "Your race status has been updated." };
  }
};

const unsubscribeToken = async (row: NotificationRow, destinationHash: string, env: Env): Promise<string> => {
  const payload = base64Url(JSON.stringify({
    d: destinationHash,
    e: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60),
    n: row.id,
    r: row.registration_id,
  }));
  const signature = await keyedDigest(env, "email-unsubscribe-token", payload);
  return `${payload}.${base64Url(Uint8Array.from(signature.match(/.{2}/g)!.map((byte) => Number.parseInt(byte, 16))))}`;
};

const renderEmail = async (row: NotificationRow, env: Env, destinationHash: string): Promise<OutboundEmail> => {
  const eventName = singleLine(row.event_name);
  const participantName = singleLine(`${row.first_name} ${row.last_name}`);
  const raceUrl = new URL("/race", env.APP_ORIGIN).toString();
  const rendered = notificationAction(row);
  const subject = singleLine(rendered.subject);
  const action = singleLine(rendered.action);
  const unsubscribeUrl = new URL("/notifications/unsubscribe", env.APP_ORIGIN);
  unsubscribeUrl.searchParams.set("token", await unsubscribeToken(row, destinationHash, env));
  const text = [
    `Hi ${participantName},`,
    "",
    action,
    "",
    `Event: ${eventName}`,
    `Race status: ${raceUrl}`,
    "",
    "Race progress can change, so this reminder does not promise a start time.",
    `Unsubscribe from email updates: ${unsubscribeUrl}`,
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body><p>Hi ${escapeHtml(participantName)},</p>`
    + `<p><strong>${escapeHtml(action)}</strong></p>`
    + `<p>Event: ${escapeHtml(eventName)}<br><a href="${escapeHtml(raceUrl)}">View race status</a></p>`
    + "<p>Race progress can change, so this reminder does not promise a start time.</p>"
    + `<p><a href="${escapeHtml(unsubscribeUrl.toString())}">Unsubscribe from email updates</a></p></body></html>`;
  return {
    from: env.EMAIL_FROM_ADDRESS,
    to: row.email!,
    subject,
    text,
    html,
  };
};

const renderSms = (row: NotificationRow, env: Env, destination: string): OutboundSms => ({
  to: destination,
  text: `${singleLine(notificationAction(row).action)} ${new URL("/race", env.APP_ORIGIN)} Reply STOP to opt out.`,
});

const notificationDestination = (row: NotificationRow): string | null => row.channel === "EMAIL"
  ? row.email
  : row.phone === null ? null : smsDestination(row.phone);

export const processEmailNotification = async (
  env: Env,
  notificationId: string,
  sender: EmailSender = sendEmailWithSes,
  queueDeliveryAttempt = 1,
  smsSender: SmsSender = sendSmsWithAws,
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
  let row = await notificationRow(env, notificationId);
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

  // Phone numbers are stored in the readable form shown in participant forms.
  // Hash, suppress, and submit one canonical E.164 value so local and provider
  // STOP decisions address exactly the same destination.
  const destination = notificationDestination(row)!;
  let destinationHash: string;
  try {
    destinationHash = await keyedDigest(env, `destination:${row.channel}`, destination.toLowerCase());
  } catch (error) {
    const failure = error instanceof EmailSendError
      ? error
      : new EmailSendError("NOTIFICATION_HMAC_CONFIGURATION_INVALID", false);
    await failNotification(env, notificationId, attemptId, failure.safeCode);
    return "FAILED";
  }
  await env.DB.prepare(
    `UPDATE email_notifications SET destination_hash = ?, updated_at = ?
      WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
  ).bind(destinationHash, new Date().toISOString(), notificationId, attemptId).run();
  const locallySuppressed = await env.DB.prepare(
    `SELECT 1 AS suppressed FROM notification_suppressions
      WHERE channel = ? AND destination_hash = ? LIMIT 1`,
  ).bind(row.channel, destinationHash).first<{ suppressed: number }>();
  if (locallySuppressed !== null) {
    await suppressNotification(env, row, attemptId, destinationHash, "PROVIDER");
    return "CANCELLED";
  }

  let result: EmailSendResult;
  try {
    const providerSuppressed = row.channel === "EMAIL"
      ? sender === sendEmailWithSes && await isEmailSuppressedBySes(destination, env)
      : smsSender === sendSmsWithAws && await isSmsOptedOutByAws(destination, env);
    if (providerSuppressed) {
      await suppressNotification(env, row, attemptId, destinationHash, "PROVIDER");
      return "CANCELLED";
    }

    // Provider suppression reads can be slow. Consent, contact, assignment,
    // event SMS state, heat progression, or an official result can change while
    // that request is in flight, so reload once more immediately before the
    // irreversible provider submission. A changed destination is cancelled
    // rather than submitted without a suppression check for that destination.
    const currentRow = await notificationRow(env, notificationId);
    if (currentRow === null) {
      await cancelNotification(env, notificationId, attemptId, "RACE_ASSIGNMENT_CHANGED");
      return "CANCELLED";
    }
    const currentInvalid = validationFailure(currentRow);
    if (currentInvalid === "UNSUPPORTED_TEMPLATE") {
      await failNotification(env, notificationId, attemptId, currentInvalid);
      return "FAILED";
    }
    if (currentInvalid !== null) {
      await cancelNotification(env, notificationId, attemptId, currentInvalid);
      return "CANCELLED";
    }
    const currentDestination = notificationDestination(currentRow);
    if (currentDestination === null || currentDestination.toLowerCase() !== destination.toLowerCase()) {
      await cancelNotification(env, notificationId, attemptId, "NOTIFICATION_DESTINATION_CHANGED");
      return "CANCELLED";
    }
    const newlySuppressed = await env.DB.prepare(
      `SELECT 1 AS suppressed FROM notification_suppressions
        WHERE channel = ? AND destination_hash = ? LIMIT 1`,
    ).bind(currentRow.channel, destinationHash).first<{ suppressed: number }>();
    if (newlySuppressed !== null) {
      await suppressNotification(env, currentRow, attemptId, destinationHash, "PROVIDER");
      return "CANCELLED";
    }
    row = currentRow;
    result = row.channel === "EMAIL"
      ? await sender(await renderEmail(row, env, destinationHash), env)
      : await smsSender(renderSms(row, env, destination), env);
  } catch (error) {
    const failure = error instanceof EmailSendError
      ? error
      : new EmailSendError("DELIVERY_OUTCOME_UNKNOWN", false);
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
            SET status = ?, sending_started_at = NULL,
                delivery_claim_token = NULL, terminal_at = ?,
                last_error_code = ?, retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(
        retryable ? "QUEUED" : "FAILED",
        retryable ? null : completedAt,
        code,
        retryable ? isoAfter(60_000) : null,
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
  // Keep this outside the sender-error catch. Once SES has accepted the email,
  // a D1 failure is an ambiguous post-send outcome, not a temporary send
  // failure. The row remains SENDING and stale recovery terminally fails it
  // rather than ever calling SES a second time.
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
    ).bind(sentAt, row.channel === "EMAIL" ? "SES_ACCEPTED" : "SMS_ACCEPTED", sentAt, notificationId, attemptId),
  ]);
  return "SENT";
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
    await withDeadline(env.EMAIL_QUEUE.send(notificationId));
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
  const stale = new Date(Date.now() - 2 * 60_000).toISOString();
  const abandoned = await env.DB.prepare(
    `SELECT id, sending_started_at, delivery_claim_token
       FROM email_notifications
      WHERE status = 'SENDING' AND (sending_started_at IS NULL OR sending_started_at < ?)
      ORDER BY created_at, id LIMIT 100`,
  ).bind(stale).all<{ id: string; sending_started_at: string | null; delivery_claim_token: string | null }>();
  for (const notification of abandoned.results) {
    await failAmbiguousDelivery(
      env,
      notification.id,
      notification.sending_started_at,
      notification.delivery_claim_token,
    );
  }
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

// Domain handlers call this only after committing their own batch. Every
// exception, including the reconciliation query itself, is isolated so provider
// or queue outages can never replace a successful race response.
export const publishPendingParticipantNotifications = async (env: Env): Promise<void> => {
  try {
    await dispatchPendingEmailNotifications(env);
  } catch {
    // Durable PENDING/RETRY_PENDING rows remain for the scheduled reconciliation.
  }
};

export const handleEmailQueue = async (
  batch: MessageBatch<unknown>,
  env: Env,
  sender: EmailSender = sendEmailWithSes,
  smsSender: SmsSender = sendSmsWithAws,
): Promise<void> => {
  for (const message of batch.messages) {
    if (typeof message.body !== "string" || !notificationIdPattern.test(message.body)) {
      message.ack();
      continue;
    }
    try {
      const result = await processEmailNotification(env, message.body, sender, message.attempts, smsSender);
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

interface UnsubscribeCapability {
  d: string;
  e: number;
  n: string;
  r: string;
}

const decodeBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const source = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(source.padEnd(Math.ceil(source.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
};

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const readUnsubscribeCapability = async (
  token: string,
  env: Env,
): Promise<(UnsubscribeCapability & { eventId: string; email: string }) | null> => {
  const pieces = token.split(".");
  if (pieces.length !== 2 || pieces[0].length > 1024 || pieces[1].length > 128) return null;
  const payloadBytes = decodeBase64Url(pieces[0]);
  const signatureBytes = decodeBase64Url(pieces[1]);
  if (payloadBytes === null || signatureBytes === null || signatureBytes.length !== 32) return null;
  const expected = await keyedDigest(env, "email-unsubscribe-token", pieces[0]);
  if (!constantTimeEqual(hex(signatureBytes), expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    return null;
  }
  if (
    payload === null || typeof payload !== "object" || Array.isArray(payload)
    || Object.keys(payload).sort().join(",") !== "d,e,n,r"
  ) return null;
  const capability = payload as UnsubscribeCapability;
  if (
    !/^[a-f0-9]{64}$/.test(capability.d)
    || !Number.isSafeInteger(capability.e) || capability.e < Math.floor(Date.now() / 1000)
    || !notificationIdPattern.test(capability.n) || !notificationIdPattern.test(capability.r)
  ) return null;
  const row = await env.DB.prepare(
    `SELECT n.event_id, r.email
       FROM email_notifications n
       JOIN registrations r ON r.id = n.registration_id AND r.event_id = n.event_id
      WHERE n.id = ? AND n.registration_id = ? AND n.channel = 'EMAIL'
      LIMIT 1`,
  ).bind(capability.n, capability.r).first<{ event_id: string; email: string | null }>();
  if (row?.email === null || row?.email === undefined) return null;
  const currentHash = await keyedDigest(env, "destination:EMAIL", row.email.toLowerCase());
  return constantTimeEqual(currentHash, capability.d)
    ? { ...capability, eventId: row.event_id, email: row.email }
    : null;
};

const unsubscribePage = (token: string, state: "CONFIRM" | "DONE" | "INVALID"): Response => {
  const heading = state === "DONE" ? "Email updates are off."
    : state === "CONFIRM" ? "Stop email updates?"
      : "This unsubscribe link is not valid.";
  const detail = state === "DONE"
    ? "Pending email notifications for this address have been suppressed. SMS preferences are unchanged."
    : state === "CONFIRM"
      ? "This stops participant race updates to the email address that received the link. SMS preferences are unchanged."
      : "The link may have expired, been changed, or belong to an email address that is no longer current.";
  const form = state === "CONFIRM"
    ? `<form method="post" action="/notifications/unsubscribe"><input type="hidden" name="token" value="${escapeHtml(token)}"><button type="submit">Stop email updates</button></form>`
    : "";
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${heading}</title></head><body><main><h1>${heading}</h1><p>${detail}</p>${form}<p><a href="/">Return to QuickDucks</a></p></main></body></html>`, {
    status: state === "INVALID" ? 400 : 200,
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
};

export const handleEmailUnsubscribe = async (request: Request, env: Env): Promise<Response> => {
  let token = "";
  if (request.method === "GET") token = new URL(request.url).searchParams.get("token") ?? "";
  else if (request.method === "POST") {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
      return unsubscribePage("", "INVALID");
    }
    const body = await request.formData();
    token = typeof body.get("token") === "string" ? String(body.get("token")) : "";
  } else return new Response(null, { status: 405, headers: { allow: "GET, POST" } });

  let capability: Awaited<ReturnType<typeof readUnsubscribeCapability>>;
  try {
    capability = await readUnsubscribeCapability(token, env);
  } catch {
    capability = null;
  }
  if (capability === null) return unsubscribePage("", "INVALID");
  if (request.method === "GET") return unsubscribePage(token, "CONFIRM");

  const now = new Date().toISOString();
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO notification_suppressions
        (id, event_id, registration_id, channel, destination_hash, source, created_at)
       VALUES (?, ?, ?, 'EMAIL', ?, 'EMAIL_UNSUBSCRIBE', ?)
       ON CONFLICT(channel, destination_hash) DO NOTHING`,
    ).bind(crypto.randomUUID(), capability.eventId, capability.r, capability.d, now),
    env.DB.prepare(
      `UPDATE registrations SET email_notifications_enabled = 0,
               revision = revision + 1, updated_at = ?
        WHERE id = ? AND event_id = ? AND email = ? COLLATE NOCASE`,
    ).bind(now, capability.r, capability.eventId, capability.email),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'SUPPRESSED', terminal_at = ?, status_reason = 'EMAIL_UNSUBSCRIBED',
              destination_hash = COALESCE(destination_hash, ?), retry_after = NULL,
              last_error_code = NULL, updated_at = ?
        WHERE event_id = ? AND registration_id = ? AND channel = 'EMAIL'
          AND status IN ('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING')
          AND EXISTS (
            SELECT 1 FROM registrations current
             WHERE current.id = ? AND current.event_id = ?
               AND current.email = ? COLLATE NOCASE
          )`,
    ).bind(
      now, capability.d, now, capability.eventId, capability.r,
      capability.r, capability.eventId, capability.email,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
       SELECT ?, ?, 'PARTICIPANT_EMAIL_UNSUBSCRIBED', 'REGISTRATION', ?, 'PUBLIC', ?, ?
         FROM registrations current
        WHERE current.id = ? AND current.event_id = ?
          AND current.email = ? COLLATE NOCASE`,
    ).bind(
      crypto.randomUUID(), capability.eventId, capability.r, now,
      JSON.stringify({ channel: "EMAIL", destination_hmac_recorded: true }),
      capability.r, capability.eventId, capability.email,
    ),
  ]);
  if (results[1]?.meta.changes === 0) return unsubscribePage("", "INVALID");
  return unsubscribePage("", "DONE");
};
