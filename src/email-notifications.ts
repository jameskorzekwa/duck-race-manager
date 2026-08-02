import type { Env } from "./types.ts";
import { isLocalPreviewOrigin } from "./local-preview.ts";
import { normalizeUsPhone } from "./registration.ts";

export const EMAIL_NOTIFICATION_TYPES = [
  "REGISTRATION_CONFIRMED",
  "HEAT_ASSIGNED",
  "FINAL_ASSIGNED",
  "HEAT_UPCOMING",
  "HEAT_RESULT",
] as const;
export const PARTICIPANT_NOTIFICATION_CHANNELS = ["EMAIL", "SMS"] as const;
export type ParticipantNotificationChannel = typeof PARTICIPANT_NOTIFICATION_CHANNELS[number];

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

export class SmsSendError extends EmailSendError {}

interface NotificationRow {
  id: string;
  event_id: string;
  registration_id: string;
  duck_assignment_id: string | null;
  active_duck_assignment_id: string | null;
  notification_type: string;
  channel: ParticipantNotificationChannel;
  lifecycle_key: string;
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
  earlier_unfinished_count: number;
  reminder_superseded: number;
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

// SigV4 uses RFC 3986 encoding, which is slightly stricter than the browser's
// encodeURIComponent for path segments and query values.
const awsEncode = (value: string): string => encodeURIComponent(value).replace(
  /[!'()*]/g,
  (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
);

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

const signingSecret = (env: Env): string | null => {
  const configured = env.NOTIFICATION_SIGNING_SECRET?.trim();
  if (configured !== undefined && configured.length >= 32) return configured;
  return isLocalPreviewOrigin(env.APP_ORIGIN) ? "quickducks-local-notification-signing-only" : null;
};

const unsubscribeSignature = async (env: Env, notificationId: string): Promise<string | null> => {
  const secret = signingSecret(env);
  if (secret === null) return null;
  return hex(await hmac(textEncoder.encode(secret), `unsubscribe\0${notificationId}`));
};

const constantTimeEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

const signedAwsRequest = async (
  env: Env,
  service: "ses" | "sms-voice",
  host: string,
  method: "GET" | "POST",
  path: string,
  body = "",
  canonicalQuery = "",
): Promise<Response> => {
  if (
    env.AWS_REGION !== "us-east-1"
    || typeof env.AWS_ACCESS_KEY_ID !== "string"
    || env.AWS_ACCESS_KEY_ID.length < 16
    || typeof env.AWS_SECRET_ACCESS_KEY !== "string"
    || env.AWS_SECRET_ACCESS_KEY.length < 32
  ) throw new EmailSendError("AWS_CONFIGURATION_INVALID", false);
  const payloadHash = hex(await sha256(body));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `${method}\n${path}\n${canonicalQuery}\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${env.AWS_REGION}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(textEncoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmac(dateKey, env.AWS_REGION);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  try {
    return await fetch(`https://${host}${path}${canonicalQuery === "" ? "" : `?${canonicalQuery}`}`, {
      method,
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "content-type": "application/json",
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      ...(method === "POST" ? { body } : {}),
    });
  } catch {
    throw new EmailSendError("AWS_NETWORK_ERROR", true);
  }
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
    ListManagementOptions: {
      ContactListName: "quickducks-participants",
      TopicName: "operational-race-updates",
    },
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

// AWS End User Messaging SMS (the current AWS-native SMS service) is used
// directly through its SigV4 REST endpoint. SMS is a metered carrier service;
// the adapter deliberately fails closed without an approved origination
// identity rather than pretending that a free production route exists.
export const sendSmsWithAws: SmsSender = async (sms, env) => {
  const origin = env.SMS_ORIGINATION_IDENTITY?.trim();
  const normalizedPhone = normalizeUsPhone(sms.to);
  if (
    origin === undefined || origin.length === 0 || origin.length > 128
    || normalizedPhone === null
    || sms.text.length === 0 || sms.text.length > 1_600
  ) throw new SmsSendError("SMS_CONFIGURATION_INVALID", false);
  const host = `sms-voice.${env.AWS_REGION}.amazonaws.com`;
  const path = "/v2/sms-voice/text-message";
  const body = JSON.stringify({
    DestinationPhoneNumber: `+1${normalizedPhone.replace(/\D/g, "")}`,
    MessageBody: sms.text,
    MessageType: "TRANSACTIONAL",
    OriginationIdentity: origin,
  });
  let response: Response;
  try {
    response = await signedAwsRequest(env, "sms-voice", host, "POST", path, body);
  } catch (error) {
    if (error instanceof EmailSendError) {
      throw new SmsSendError(
        error.safeCode === "AWS_NETWORK_ERROR" ? "SMS_NETWORK_ERROR" : error.safeCode,
        error.retryable,
      );
    }
    throw new SmsSendError("SMS_NETWORK_ERROR", true);
  }
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new SmsSendError(retryable ? "SMS_TEMPORARY_FAILURE" : "SMS_REJECTED", retryable);
  }
  let providerMessageId: string | null = null;
  try {
    const result = await response.json() as { MessageId?: unknown };
    if (typeof result.MessageId === "string" && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.MessageId)) {
      providerMessageId = result.MessageId;
    }
  } catch {
    // A successful provider response is acceptance even without an identifier.
  }
  return { providerMessageId };
};

const providerSuppression = async (
  env: Env,
  row: NotificationRow,
): Promise<"PROVIDER_SUPPRESSED" | null> => {
  if (row.channel === "EMAIL" && row.email !== null) {
    const host = `email.${env.AWS_REGION}.amazonaws.com`;
    const destination = awsEncode(row.email);
    const account = await signedAwsRequest(
      env,
      "ses",
      host,
      "GET",
      `/v2/email/suppression/addresses/${destination}`,
    );
    if (account.ok) return "PROVIDER_SUPPRESSED";
    if (account.status !== 404) {
      const retryable = account.status === 408 || account.status === 429 || account.status >= 500;
      throw new EmailSendError(retryable ? "SUPPRESSION_CHECK_TEMPORARY_FAILURE" : "SUPPRESSION_CHECK_REJECTED", retryable);
    }
    const contact = await signedAwsRequest(
      env,
      "ses",
      host,
      "GET",
      `/v2/email/contact-lists/quickducks-participants/contacts/${destination}`,
    );
    if (contact.status === 404) return null;
    if (!contact.ok) {
      const retryable = contact.status === 408 || contact.status === 429 || contact.status >= 500;
      throw new EmailSendError(retryable ? "SUPPRESSION_CHECK_TEMPORARY_FAILURE" : "SUPPRESSION_CHECK_REJECTED", retryable);
    }
    try {
      const preference = await contact.json() as {
        UnsubscribeAll?: unknown;
        TopicPreferences?: { TopicName?: unknown; SubscriptionStatus?: unknown }[];
      };
      if (preference.UnsubscribeAll === true || preference.TopicPreferences?.some((topic) =>
        topic.TopicName === "operational-race-updates" && topic.SubscriptionStatus === "OPT_OUT")) {
        return "PROVIDER_SUPPRESSED";
      }
    } catch {
      throw new EmailSendError("SUPPRESSION_CHECK_TEMPORARY_FAILURE", true);
    }
  }
  if (row.channel === "SMS" && row.phone !== null) {
    const normalizedPhone = normalizeUsPhone(row.phone);
    if (normalizedPhone === null) throw new SmsSendError("SMS_NOT_OPTED_IN", false);
    const list = env.SMS_OPT_OUT_LIST_NAME?.trim();
    if (list === undefined || !/^[A-Za-z0-9_-]{1,64}$/.test(list)) {
      throw new SmsSendError("SMS_SUPPRESSION_CONFIGURATION_INVALID", false);
    }
    const host = `sms-voice.${env.AWS_REGION}.amazonaws.com`;
    const path = `/v2/sms-voice/opt-out-lists/${awsEncode(list)}/opted-out-numbers`;
    const digits = `+1${normalizedPhone.replace(/\D/g, "")}`;
    let nextToken: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const query = nextToken === null
        ? "MaxResults=100"
        : `MaxResults=100&NextToken=${awsEncode(nextToken)}`;
      const response = await signedAwsRequest(env, "sms-voice", host, "GET", path, "", query);
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        throw new SmsSendError(retryable ? "SUPPRESSION_CHECK_TEMPORARY_FAILURE" : "SUPPRESSION_CHECK_REJECTED", retryable);
      }
      try {
        const result = await response.json() as {
          OptedOutNumbers?: { OptedOutNumber?: unknown }[];
          NextToken?: unknown;
        };
        if (result.OptedOutNumbers?.some((entry) => entry.OptedOutNumber === digits)) {
          return "PROVIDER_SUPPRESSED";
        }
        nextToken = typeof result.NextToken === "string" && result.NextToken.length > 0
          ? result.NextToken
          : null;
        if (nextToken === null) return null;
      } catch (error) {
        if (error instanceof SmsSendError) throw error;
        throw new SmsSendError("SUPPRESSION_CHECK_TEMPORARY_FAILURE", true);
      }
    }
    // Never send after a partial provider answer that cannot prove absence.
    throw new SmsSendError("SUPPRESSION_CHECK_TEMPORARY_FAILURE", true);
  }
  return null;
};

const optedInChannelSql = `(channel = 'EMAIL'
       AND r.email IS NOT NULL AND r.email_notifications_enabled = 1)
      OR (channel = 'SMS'
       AND r.phone IS NOT NULL AND r.sms_notifications_enabled = 1)`;

/**
 * One channel-specific registration outbox insert. The caller places both
 * returned statements in the same D1 batch as the registration itself. IDs are
 * generated before the batch so the committed rows can be published
 * immediately, while the unique lifecycle key makes a command replay harmless.
 */
export const registrationNotificationStatements = (
  env: Env,
  eventId: string,
  registrationId: string,
  commandId: string,
  now: string,
): { ids: string[]; statements: D1PreparedStatement[] } => {
  const ids = PARTICIPANT_NOTIFICATION_CHANNELS.map(() => crypto.randomUUID());
  return {
    ids,
    statements: PARTICIPANT_NOTIFICATION_CHANNELS.map((channel, index) => {
      const consent = channel === "EMAIL"
        ? "r.email IS NOT NULL AND r.email_notifications_enabled = 1"
        : "r.phone IS NOT NULL AND r.sms_notifications_enabled = 1";
      return env.DB.prepare(
        `INSERT INTO email_notifications
        (id, event_id, registration_id, notification_type, channel,
         lifecycle_key, status, template_version, created_by_command_id,
         scheduled_at, updated_at)
       SELECT ?, r.event_id, r.id, ?, ?, ?,
              'PENDING', 1, ?, ?, ?
         FROM registrations r
        WHERE r.event_id = ? AND r.id = ?
          AND r.status IN ('SUBMITTED', 'ACTIVE')
          AND ${consent}
       ON CONFLICT DO NOTHING`,
      ).bind(
        ids[index],
        channel === "EMAIL" ? "REGISTRATION_CONFIRMED" : "SMS_REGISTRATION_CONFIRMED",
        channel,
        `registration:${registrationId}`,
        commandId,
        now,
        now,
        eventId,
        registrationId,
      );
    }),
  };
};

type HeatNotificationType = "HEAT_ASSIGNED" | "FINAL_ASSIGNED" | "HEAT_UPCOMING" | "HEAT_RESULT";

// One statement can insert an arbitrary number of channel/recipient rows, so
// their identifiers must be generated inside SQLite rather than bound from a
// fixed JavaScript array. Keep the same RFC 4122 v4 shape as every queue ID the
// application creates with crypto.randomUUID(); queue payload validation and
// operational tooling intentionally have one opaque identifier format.
const sqliteUuidV4Sql = `lower(
  hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2, 3) || '-8' ||
  substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
)`;

/** Insert one logical notification for every currently opted-in channel on a heat roster. */
export const heatNotificationStatement = (
  env: Env,
  eventId: string,
  heatId: string,
  type: HeatNotificationType,
  lifecycleKey: string,
  commandId: string,
  now: string,
  raceEntryId: string | null = null,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, channel, lifecycle_key, status, template_version,
     created_by_command_id, scheduled_at, updated_at)
   SELECT ${sqliteUuidV4Sql}, r.event_id, r.id, h.id, da.id,
          CASE channel WHEN 'EMAIL' THEN ? ELSE 'SMS_' || ? END,
          channel, ?, 'PENDING', 1, ?, ?, ?
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     LEFT JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = h.event_id AND da.valid_to IS NULL
     CROSS JOIN (SELECT 'EMAIL' AS channel UNION ALL SELECT 'SMS') channels
     WHERE h.event_id = ? AND h.id = ? AND r.status = 'ACTIVE'
       AND (? IS NULL OR re.id = ?)
       AND ((${optedInChannelSql}))
    ON CONFLICT DO NOTHING`,
).bind(type, type, lifecycleKey, commandId, now, now, eventId, heatId, raceEntryId, raceEntryId);

/**
 * Atomically record the reminder for the first still-runnable heat after a
 * committed progression point. The heat that just progressed is excluded while
 * its final status update may still be later in the same D1 batch; every other
 * heat is considered by authoritative round order, so an allowed out-of-order
 * result cannot strand an earlier heat without its reminder.
 */
export const nextHeatReminderStatement = (
  env: Env,
  eventId: string,
  round: "ROUND_ONE" | "FINAL",
  afterHeatNumber: number,
  commandId: string,
  now: string,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, channel, lifecycle_key, status, template_version,
     created_by_command_id, scheduled_at, updated_at)
   SELECT ${sqliteUuidV4Sql}, r.event_id, r.id, h.id, da.id,
          CASE channel WHEN 'EMAIL' THEN 'HEAT_UPCOMING' ELSE 'SMS_HEAT_UPCOMING' END,
          channel, 'reminder:' || h.id, 'PENDING', 1, ?, ?, ?
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = h.event_id AND da.valid_to IS NULL
     CROSS JOIN (SELECT 'EMAIL' AS channel UNION ALL SELECT 'SMS') channels
    WHERE h.event_id = ? AND h.round = ? AND h.heat_number = (
      SELECT MIN(candidate.heat_number) FROM heats candidate
       WHERE candidate.event_id = ? AND candidate.round = ?
          AND candidate.heat_number <> ?
         AND candidate.status NOT IN ('FINALIZED', 'CANCELLED')
    )
      AND h.status IN ('PLANNED', 'LOADING', 'READY', 'CALLING')
      AND r.status = 'ACTIVE' AND ((${optedInChannelSql}))
   ON CONFLICT DO NOTHING`,
).bind(commandId, now, now, eventId, round, eventId, round, afterHeatNumber);

export const publishPendingParticipantNotifications = async (env: Env): Promise<void> => {
  await dispatchPendingEmailNotifications(env);
};

const notificationRow = (env: Env, notificationId: string): Promise<NotificationRow | null> =>
  env.DB.prepare(
    `SELECT n.id, n.event_id, n.registration_id, n.duck_assignment_id,
            da.id AS active_duck_assignment_id, n.notification_type,
            n.channel, n.lifecycle_key,
            n.template_version, n.status,
            n.sending_started_at, n.retry_after,
            e.name AS event_name, e.status AS event_status,
            r.first_name, r.last_name, r.email, r.email_notifications_enabled,
            r.phone, r.sms_notifications_enabled,
            r.status AS registration_status, n.heat_id,
            he.id AS heat_entry_id, h.round AS heat_round,
            h.heat_number, h.status AS heat_status, d.visible_number,
            (SELECT hr.place FROM heat_results hr
              WHERE hr.event_id = n.event_id AND hr.heat_id = n.heat_id
                AND hr.race_entry_id = re.id AND hr.status = 'FINALIZED'
              LIMIT 1) AS result_place,
            (SELECT COUNT(*) FROM heats earlier
              WHERE earlier.event_id = n.event_id AND earlier.round = h.round
                AND earlier.heat_number < h.heat_number
                AND earlier.status NOT IN ('FINALIZED', 'CANCELLED')) AS earlier_unfinished_count,
            EXISTS (
              SELECT 1 FROM race_commands later
               WHERE later.event_id = n.event_id AND later.result_id = n.heat_id
                 AND later.command_type = 'RESET_HEAT'
                 AND later.rowid > COALESCE(
                   (SELECT original.rowid FROM race_commands original
                     WHERE original.id = n.created_by_command_id), 0)
            ) AS reminder_superseded
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

const logicalNotificationType = (row: NotificationRow): string =>
  row.channel === "SMS" && row.notification_type.startsWith("SMS_")
    ? row.notification_type.slice(4)
    : row.notification_type;

const validationFailure = (row: NotificationRow): string | null => {
  const type = logicalNotificationType(row);
  if (
    !(EMAIL_NOTIFICATION_TYPES as readonly string[]).includes(type)
    || (row.channel === "EMAIL" && row.notification_type.startsWith("SMS_"))
    || (row.channel === "SMS" && !row.notification_type.startsWith("SMS_"))
  ) return "UNSUPPORTED_TEMPLATE";
  if (row.template_version !== 1) return "UNSUPPORTED_TEMPLATE";
  if (row.channel === "EMAIL") {
    if (
      row.email_notifications_enabled !== 1 || row.email === null
      || row.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)
    ) return "EMAIL_NOT_OPTED_IN";
  } else if (
    row.channel !== "SMS" || row.sms_notifications_enabled !== 1
    || row.phone === null || normalizeUsPhone(row.phone) === null
  ) return "SMS_NOT_OPTED_IN";
  if (type === "REGISTRATION_CONFIRMED") {
    return new Set(["SUBMITTED", "ACTIVE"]).has(row.registration_status)
      ? null
      : "REGISTRATION_NOT_ACTIVE";
  }
  if (row.registration_status !== "ACTIVE") return "REGISTRATION_NOT_ACTIVE";
  if (type === "HEAT_RESULT") {
    if (
      row.heat_id === null || row.heat_entry_id === null
      || row.heat_round === null || row.heat_number === null
    ) return "RACE_ASSIGNMENT_CHANGED";
    if (row.heat_status !== "FINALIZED") return "RESULT_NO_LONGER_OFFICIAL";
    return null;
  }
  if (
    row.duck_assignment_id === null
    || row.active_duck_assignment_id === null
    || row.duck_assignment_id !== row.active_duck_assignment_id
    || row.heat_id === null || row.heat_entry_id === null || row.heat_round === null
    || row.heat_number === null || row.visible_number === null
  ) return "RACE_ASSIGNMENT_CHANGED";
  if (!new Set(["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL"]).has(row.event_status)) {
    return "EVENT_NO_LONGER_ACTIVE";
  }
  if (
    type === "HEAT_ASSIGNED"
    && !new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
  ) return "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  if (
    type === "FINAL_ASSIGNED"
    && (row.heat_round !== "FINAL" || !new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? ""))
  ) return "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  if (
    type === "HEAT_UPCOMING"
    && (!new Set(["LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
      || row.earlier_unfinished_count !== 0 || row.reminder_superseded !== 0)
  ) {
    return "HEAT_NO_LONGER_UPCOMING";
  }
  return null;
};

const notificationCopy = (row: NotificationRow): { subject: string; action: string } => {
  const round = row.heat_round === "FINAL" ? "Final" : "Round One";
  const heat = `${round}, Heat ${row.heat_number}`;
  const duck = row.visible_number === null ? "Your duck" : `Duck #${row.visible_number}`;
  switch (logicalNotificationType(row)) {
    case "REGISTRATION_CONFIRMED":
      return { subject: "QuickDucks registration confirmed", action: "Your race registration was saved successfully." };
    case "HEAT_ASSIGNED":
      return {
        subject: `${duck} is assigned to ${heat}`,
        action: `${duck} is assigned to ${heat}. Please stay near the pond and listen for your heat to be called.`,
      };
    case "FINAL_ASSIGNED":
      return {
        subject: `${duck} qualified for the Final`,
        action: `${duck} qualified and is assigned to ${heat}.`,
      };
    case "HEAT_UPCOMING":
      return {
        subject: `${heat} is next`,
        action: `${heat} is the next runnable heat. Please bring ${duck} to the pond.`,
      };
    case "HEAT_RESULT":
      if (row.heat_round === "FINAL" && row.result_place !== null) {
        return {
          subject: `${duck} finished in place ${row.result_place}`,
          action: `${duck}'s official Final placement is ${row.result_place}.`,
        };
      }
      if (row.heat_round === "ROUND_ONE" && row.result_place === 1) {
        return {
          subject: `${duck} advanced to the Final`,
          action: `${duck} won ${heat} and advanced to the Final.`,
        };
      }
      return {
        subject: `${heat} result is official`,
        action: `${duck}'s result for ${heat} is now official.`,
      };
    default:
      return { subject: "QuickDucks race update", action: "Your race status changed." };
  }
};

const renderEmail = async (row: NotificationRow, env: Env): Promise<OutboundEmail> => {
  const eventName = singleLine(row.event_name);
  const participantName = singleLine(`${row.first_name} ${row.last_name}`);
  const raceUrl = new URL("/race", env.APP_ORIGIN).toString();
  const copy = notificationCopy(row);
  const subject = singleLine(copy.subject);
  const action = copy.action;
  const signature = await unsubscribeSignature(env, row.id);
  if (signature === null) throw new EmailSendError("EMAIL_UNSUBSCRIBE_CONFIGURATION_INVALID", false);
  const unsubscribeUrl = new URL(`/notifications/unsubscribe/${row.id}/${signature}`, env.APP_ORIGIN).toString();
  const text = [
    `Hi ${participantName},`,
    "",
    action,
    "",
    `Event: ${eventName}`,
    `Race status: ${raceUrl}`,
    "",
    "Race progress can change, so this reminder does not promise a start time.",
    `Stop email updates: ${unsubscribeUrl}`,
    "You can turn off email updates from My Ducks on the device used to register.",
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body><p>Hi ${escapeHtml(participantName)},</p>`
    + `<p><strong>${escapeHtml(action)}</strong></p>`
    + `<p>Event: ${escapeHtml(eventName)}<br><a href="${escapeHtml(raceUrl)}">View race status</a></p>`
    + "<p>Race progress can change, so this reminder does not promise a start time.</p>"
    + `<p><a href="${escapeHtml(unsubscribeUrl)}">Stop email updates</a>.</p>`
    + "<p>You can turn off email updates from My Ducks on the device used to register.</p></body></html>";
  return {
    from: env.EMAIL_FROM_ADDRESS,
    to: row.email!,
    subject,
    text,
    html,
  };
};

const renderSms = (row: NotificationRow): OutboundSms => ({
  to: row.phone!,
  text: singleLine(`QuickDucks: ${notificationCopy(row).action} Reply STOP to stop SMS updates.`),
});

export const processEmailNotification = async (
  env: Env,
  notificationId: string,
  sender: EmailSender = sendEmailWithSes,
  _queueDeliveryAttempt = 1,
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

  const destination = row.channel === "EMAIL" ? row.email! : normalizeUsPhone(row.phone!)!;
  const destinationHash = hex(await sha256(`${row.channel}\0${destination.toLowerCase()}`));
  await env.DB.prepare(
    `UPDATE email_notifications SET delivery_contact_hash = ?, updated_at = ?
      WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
  ).bind(destinationHash, new Date().toISOString(), notificationId, attemptId).run();
  const suppressed = await env.DB.prepare(
    `SELECT source FROM participant_notification_suppressions
      WHERE channel = ? AND contact_hash = ? LIMIT 1`,
  ).bind(row.channel, destinationHash).first<{ source: string }>();
  if (suppressed !== null) {
    await cancelNotification(env, notificationId, attemptId, "DESTINATION_SUPPRESSED");
    return "CANCELLED";
  }

  let result: EmailSendResult;
  try {
    // Provider suppression is checked only by the production adapters. Test and
    // local senders remain deterministic while the real path fails closed when
    // SES cannot answer its current account/contact-list suppression state.
    if (row.channel === "EMAIL" && sender === sendEmailWithSes) {
      if (await providerSuppression(env, row) !== null) {
        await cancelNotification(env, notificationId, attemptId, "PROVIDER_SUPPRESSED");
        return "CANCELLED";
      }
    }
    if (row.channel === "SMS" && smsSender === sendSmsWithAws) {
      if (await providerSuppression(env, row) !== null) {
        await cancelNotification(env, notificationId, attemptId, "PROVIDER_SUPPRESSED");
        return "CANCELLED";
      }
    }
    result = row.channel === "EMAIL"
      ? await sender(await renderEmail(row, env), env)
      : await smsSender(renderSms(row), env);
  } catch (error) {
    const failure = error instanceof EmailSendError
      ? error
      : new EmailSendError(row.channel === "EMAIL" ? "EMAIL_SENDER_FAILURE" : "SMS_SENDER_FAILURE", true);
    const completedAt = new Date().toISOString();
    // Provider attempts are counted durably. Cloudflare queue transport retries
    // never consume this budget and successful stale-message republication does
    // not create a delivery attempt.
    const exhausted = failure.retryable && attemptNumber >= 5;
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
        retryable ? "RETRY_PENDING" : "FAILED",
        retryable ? null : completedAt,
        code,
        retryable ? isoAfter(Math.min(15 * 60_000, 60_000 * (2 ** (attemptNumber - 1)))) : null,
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
    `SELECT id, event_id, status, publication_failure_count
       FROM email_notifications
       WHERE id = ?
         AND (
           status = 'PENDING'
           OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?))
           OR (status = 'QUEUED' AND COALESCE(last_published_at, queued_at, created_at) <= ?)
         )
       LIMIT 1`,
  ).bind(
    notificationId,
    new Date().toISOString(),
    new Date(Date.now() - 5 * 60_000).toISOString(),
  ).first<{
    id: string;
    event_id: string;
    status: string;
    publication_failure_count: number;
  }>();
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
                 last_published_at = ?, retry_after = NULL,
                 last_error_code = NULL, updated_at = ?
           WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING', 'QUEUED')`,
      ).bind(completedAt, completedAt, completedAt, notificationId),
    ]);
  } catch {
    const completedAt = new Date().toISOString();
    const failureCount = Math.min(20, Number(notification.publication_failure_count ?? 0) + 1);
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
                   publication_failure_count = MIN(publication_failure_count + 1, 20),
                   retry_after = ?, updated_at = ?
             WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING', 'QUEUED')`,
        ).bind(
          isoAfter(Math.min(15 * 60_000, 60_000 * (2 ** Math.min(failureCount - 1, 4)))),
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

export const dispatchPendingEmailNotifications = async (env: Env): Promise<void> => {
  const now = new Date().toISOString();
  const staleQueuedBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  const staleSendingBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  const staleSending = await env.DB.prepare(
    `SELECT id FROM email_notifications
      WHERE status = 'SENDING'
        AND (sending_started_at IS NULL OR sending_started_at <= ?)
      ORDER BY updated_at, id LIMIT 100`,
  ).bind(staleSendingBefore).all<{ id: string }>();
  // This path never invokes a provider: processEmailNotification recognizes a
  // stale claim as an ambiguous possible acceptance and terminally records it.
  await Promise.all(staleSending.results.map((notification) =>
    processEmailNotification(env, notification.id)));
  const pending = await env.DB.prepare(
    `SELECT id
       FROM email_notifications
       WHERE (status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= ?))
          OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?))
          OR (status = 'QUEUED' AND COALESCE(last_published_at, queued_at, created_at) <= ?)
      ORDER BY created_at, id
      LIMIT 100`,
  ).bind(now, now, staleQueuedBefore).all<{ id: string }>();
  await Promise.all(pending.results.map((notification) => publishEmailNotification(env, notification.id)));
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
      // Durable retry_after plus cron is the one retry scheduler for expected
      // provider failures and active claims. Acknowledging avoids multiplying a
      // D1 retry with Cloudflare transport retries; unexpected infrastructure
      // exceptions below still use the queue's bounded policy.
      if (result === "RETRY") message.ack();
      else message.ack();
    } catch {
      // Unexpected infrastructure failures are left to the bounded queue retry
      // policy and then the configured DLQ. No provider/request material is
      // logged or copied into the retry request.
      message.retry({ delaySeconds: 60 });
    }
  }
};

const genericUnsubscribePage = (notificationId: string, signature: string): Response => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email updates</title></head><body><main><h1>Stop email updates</h1><p>This stops operational race emails to this address. SMS preferences are unchanged.</p><form method="post"><input type="hidden" name="notification" value="${escapeHtml(notificationId)}"><input type="hidden" name="signature" value="${escapeHtml(signature)}"><button type="submit">Stop email updates</button></form></main></body></html>`,
  {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  },
);

const genericUnsubscribeResult = (): Response => new Response(
  "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Email updates</title></head><body><main><h1>Email preference received</h1><p>If the link was current, operational race emails to that address are now stopped. SMS preferences are unchanged.</p></main></body></html>",
  {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-robots-tag": "noindex, nofollow",
    },
  },
);

/** Privacy-safe two-step unsubscribe; GET scanners never mutate consent. */
export const handleEmailUnsubscribe = async (
  request: Request,
  env: Env,
  notificationId: string,
  signature: string,
): Promise<Response> => {
  if (!notificationIdPattern.test(notificationId) || !/^[0-9a-f]{64}$/.test(signature)) {
    return genericUnsubscribeResult();
  }
  const expected = await unsubscribeSignature(env, notificationId);
  if (expected === null || !constantTimeEqual(expected, signature)) return genericUnsubscribeResult();
  if (request.method === "GET") return genericUnsubscribePage(notificationId, signature);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });

  const row = await env.DB.prepare(
    `SELECT n.delivery_contact_hash, n.registration_id, r.email
       FROM email_notifications n
       JOIN registrations r ON r.id = n.registration_id AND r.event_id = n.event_id
      WHERE n.id = ? AND n.channel = 'EMAIL' LIMIT 1`,
  ).bind(notificationId).first<{
    delivery_contact_hash: string | null;
    registration_id: string;
    email: string | null;
  }>();
  if (row?.delivery_contact_hash !== null && row?.delivery_contact_hash !== undefined) {
    const contactHash = row.delivery_contact_hash;
    const now = new Date().toISOString();
    try {
      const statements = [env.DB.prepare(
        `INSERT INTO participant_notification_suppressions
          (channel, contact_hash, source, created_at)
         VALUES ('EMAIL', ?, 'EMAIL_UNSUBSCRIBE', ?)
         ON CONFLICT(channel, contact_hash) DO NOTHING`,
      ).bind(contactHash, now)];
      const currentHash = row.email === null
        ? null
        : hex(await sha256(`EMAIL\0${row.email.toLowerCase()}`));
      if (currentHash === contactHash) {
        statements.push(env.DB.prepare(
          `UPDATE email_notifications
              SET status = 'CANCELLED', terminal_at = ?,
                  status_reason = 'EMAIL_UNSUBSCRIBE', retry_after = NULL,
                  last_error_code = NULL, updated_at = ?
            WHERE registration_id = ? AND channel = 'EMAIL'
              AND status IN ('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING')`,
        ).bind(now, now, row.registration_id));
      }
      await env.DB.batch(statements);
    } catch {
      // Keep the response generic; a retry of the same signed link is safe.
    }
  }
  return genericUnsubscribeResult();
};

/**
 * Provider callback seam for normalized STOP events. Deployment puts the same
 * high-entropy secret in the provider integration; no phone, body, or keyword is
 * logged or audited. An authenticated START removes only the provider STOP
 * suppression; it never turns the independent application consent flag on.
 */
export const handleSmsOptOut = async (request: Request, env: Env): Promise<Response> => {
  if (request.method !== "POST") return Response.json({ error: "Not found." }, { status: 404 });
  const secret = signingSecret(env);
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (secret === null || !constantTimeEqual(secret, supplied)) {
    return Response.json({ error: "Callback authentication failed." }, { status: 401 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > 2_048) return Response.json({ error: "Invalid callback." }, { status: 400 });
  let payload: unknown;
  try {
    const body = await request.text();
    if (body.length > 2_048) throw new Error("large");
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid callback." }, { status: 400 });
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json({ error: "Invalid callback." }, { status: 400 });
  }
  const record = payload as { phone?: unknown; eventType?: unknown };
  const phone = typeof record.phone === "string" ? normalizeUsPhone(record.phone) : null;
  if (phone === null || (record.eventType !== "STOP" && record.eventType !== "START")) {
    return Response.json({ accepted: true }, { headers: { "cache-control": "no-store" } });
  }
  const contactHash = hex(await sha256(`SMS\0${phone.toLowerCase()}`));
  const now = new Date().toISOString();
  if (record.eventType === "START") {
    await env.DB.prepare(
      `DELETE FROM participant_notification_suppressions
        WHERE channel = 'SMS' AND contact_hash = ? AND source = 'SMS_STOP'`,
    ).bind(contactHash).run();
    return Response.json({ accepted: true }, { headers: { "cache-control": "no-store" } });
  }
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO participant_notification_suppressions
        (channel, contact_hash, source, created_at)
       VALUES ('SMS', ?, 'SMS_STOP', ?)
       ON CONFLICT(channel, contact_hash) DO NOTHING`,
    ).bind(contactHash, now),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'CANCELLED', terminal_at = ?, status_reason = 'SMS_STOP',
              retry_after = NULL, last_error_code = NULL, updated_at = ?
        WHERE channel = 'SMS'
          AND registration_id IN (SELECT id FROM registrations WHERE phone = ?)
          AND status IN ('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING')`,
    ).bind(now, now, phone),
  ]);
  return Response.json({ accepted: true }, { headers: { "cache-control": "no-store" } });
};
