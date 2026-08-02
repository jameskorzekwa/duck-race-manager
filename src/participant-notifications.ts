import type { EmailSender, OutboundEmail } from "./email-notifications.ts";
import { hashToken, normalizeUsPhone, randomToken } from "./registration.ts";
import type { Env } from "./types.ts";

export const PARTICIPANT_NOTIFICATION_TYPES = [
  "REGISTRATION_CONFIRMATION",
  "HEAT_ASSIGNED",
  "FINAL_ASSIGNED",
  "HEAT_UPCOMING",
  "ROUND_RESULT",
] as const;

export type ParticipantNotificationType = typeof PARTICIPANT_NOTIFICATION_TYPES[number];
export type ParticipantNotificationChannel = "EMAIL" | "SMS";
export type ParticipantProcessingResult = "SENT" | "CANCELLED" | "FAILED" | "NOOP" | "RETRY";

export interface OutboundSms {
  to: string;
  text: string;
}

export interface ParticipantSendResult {
  providerMessageId: string | null;
}

export type SmsSender = (sms: OutboundSms, env: Env) => Promise<ParticipantSendResult>;
export type ProviderSuppressionCheck = (destination: string, env: Env) => Promise<boolean>;

export interface ParticipantTransports {
  emailSender?: EmailSender;
  smsSender?: SmsSender;
  emailSuppressed?: ProviderSuppressionCheck;
  smsSuppressed?: ProviderSuppressionCheck;
}

export class ParticipantSendError extends Error {
  readonly safeCode: string;
  readonly retryable: boolean;

  constructor(safeCode: string, retryable: boolean) {
    super(safeCode);
    this.safeCode = safeCode;
    this.retryable = retryable;
  }
}

const notificationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const sendableStatuses = new Set(["PENDING", "QUEUED", "RETRY_PENDING"]);
const textEncoder = new TextEncoder();
const generatedSqlId = `(lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4'
  || substr(lower(hex(randomblob(2))), 2) || '-a' || substr(lower(hex(randomblob(2))), 2)
  || '-' || lower(hex(randomblob(6))))`;

const smsType = (type: ParticipantNotificationType): string => `SMS_${type}`;
const storedType = (channel: ParticipantNotificationChannel, type: ParticipantNotificationType): string =>
  channel === "SMS" ? smsType(type) : type;
const logicalType = (value: string): string => value.startsWith("SMS_") ? value.slice(4) : value;

const consentSql = (channel: ParticipantNotificationChannel, alias = "r"): string => channel === "EMAIL"
  ? `${alias}.email_notifications_enabled = 1 AND ${alias}.email IS NOT NULL`
  : `${alias}.sms_notifications_enabled = 1 AND ${alias}.phone IS NOT NULL`;

const directNotificationStatement = (
  env: Env,
  channel: ParticipantNotificationChannel,
  type: ParticipantNotificationType,
  eventId: string,
  registrationId: string,
  heatId: string | null,
  duckAssignmentId: string | null,
  lifecycleKey: string,
  commandId: string,
  now: string,
  resultRevision: number | null = null,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, channel, lifecycle_key, result_revision, status,
     template_version, created_by_command_id, scheduled_at, updated_at)
   SELECT ?, r.event_id, r.id, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?, ?, ?
     FROM registrations r
    WHERE r.id = ? AND r.event_id = ? AND ${consentSql(channel)}
      AND EXISTS (
        SELECT 1 FROM race_commands rc
         WHERE rc.id = ? AND rc.event_id = r.event_id
      )
   ON CONFLICT DO NOTHING`,
).bind(
  crypto.randomUUID(), heatId, duckAssignmentId, storedType(channel, type), channel,
  lifecycleKey, resultRevision, commandId, now, now, registrationId, eventId, commandId,
);

const bothChannels = (
  statement: (channel: ParticipantNotificationChannel) => D1PreparedStatement,
): D1PreparedStatement[] => [statement("EMAIL"), statement("SMS")];

export const registrationNotificationStatements = (
  env: Env,
  eventId: string,
  registrationId: string,
  commandId: string,
  now: string,
): D1PreparedStatement[] => bothChannels((channel) => directNotificationStatement(
  env,
  channel,
  "REGISTRATION_CONFIRMATION",
  eventId,
  registrationId,
  null,
  null,
  `REGISTRATION:${commandId}`,
  commandId,
  now,
));

export const assignmentNotificationStatements = (
  env: Env,
  eventId: string,
  registrationId: string,
  heatId: string,
  duckAssignmentId: string,
  commandId: string,
  now: string,
  finalAssignment = false,
): D1PreparedStatement[] => {
  const type = finalAssignment ? "FINAL_ASSIGNED" : "HEAT_ASSIGNED";
  return bothChannels((channel) => directNotificationStatement(
    env,
    channel,
    type,
    eventId,
    registrationId,
    heatId,
    duckAssignmentId,
    finalAssignment ? `${type}:${heatId}:${commandId}` : `${type}:${heatId}`,
    commandId,
    now,
  ));
};

const reassignedByCommandStatement = (
  env: Env,
  channel: ParticipantNotificationChannel,
  eventId: string,
  commandId: string,
  now: string,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, channel, lifecycle_key, status, template_version,
     created_by_command_id, scheduled_at, updated_at)
   SELECT ${generatedSqlId}, r.event_id, r.id, h.id, da.id,
          ?, ?, 'HEAT_ASSIGNED:' || h.id || ':' || ?, 'PENDING', 1, ?, ?, ?
     FROM heat_entries he
     JOIN heats h ON h.id = he.heat_id AND h.event_id = he.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = he.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = he.event_id
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = he.event_id AND da.valid_to IS NULL
    WHERE he.event_id = ? AND he.source_command_id = ?
      AND r.status = 'ACTIVE' AND ${consentSql(channel)}
      AND EXISTS (SELECT 1 FROM race_commands rc WHERE rc.id = ? AND rc.event_id = he.event_id)
   ON CONFLICT DO NOTHING`,
).bind(
  storedType(channel, "HEAT_ASSIGNED"), channel, commandId, commandId, now, now,
  eventId, commandId, commandId,
);

export const reassignedByCommandNotificationStatements = (
  env: Env,
  eventId: string,
  commandId: string,
  now: string,
): D1PreparedStatement[] => bothChannels((channel) =>
  reassignedByCommandStatement(env, channel, eventId, commandId, now));

const rosterNotificationStatement = (
  env: Env,
  channel: ParticipantNotificationChannel,
  type: ParticipantNotificationType,
  eventId: string,
  heatId: string,
  lifecycleKey: string,
  commandId: string,
  now: string,
  resultRevision: number | null,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, channel, lifecycle_key, result_revision, status,
     template_version, created_by_command_id, scheduled_at, updated_at)
   SELECT ${generatedSqlId}, r.event_id, r.id, h.id, da.id,
          ?, ?, ?, ?, 'PENDING', 1, ?, ?, ?
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = h.event_id AND da.valid_to IS NULL
    WHERE h.id = ? AND h.event_id = ? AND r.status = 'ACTIVE'
      AND ${consentSql(channel)}
      AND EXISTS (
        SELECT 1 FROM race_commands rc
         WHERE rc.id = ? AND rc.event_id = h.event_id
      )
   ON CONFLICT DO NOTHING`,
).bind(
  storedType(channel, type), channel, lifecycleKey, resultRevision,
  commandId, now, now, heatId, eventId, commandId,
);

export const resultNotificationStatements = (
  env: Env,
  eventId: string,
  heatId: string,
  resultRevision: number,
  commandId: string,
  now: string,
): D1PreparedStatement[] => bothChannels((channel) => rosterNotificationStatement(
  env,
  channel,
  "ROUND_RESULT",
  eventId,
  heatId,
  `ROUND_RESULT:${heatId}:${resultRevision}`,
  commandId,
  now,
  resultRevision,
));

const nextRunnableStatement = (
  env: Env,
  channel: ParticipantNotificationChannel,
  eventId: string,
  round: "ROUND_ONE" | "FINAL",
  commandId: string,
  now: string,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, channel, lifecycle_key, status, template_version,
     created_by_command_id, scheduled_at, updated_at)
   SELECT ${generatedSqlId}, r.event_id, r.id, h.id, da.id,
          ?, ?, 'HEAT_UPCOMING:' || h.id || ':' || ?, 'PENDING', 1, ?, ?, ?
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = h.event_id AND da.valid_to IS NULL
    WHERE h.event_id = ? AND h.round = ?
      AND h.status IN ('LOADING', 'READY', 'CALLING')
      AND (h.round = 'FINAL' OR (
        SELECT COUNT(*) FROM heat_entries eligible_entry
          JOIN race_entries eligible_race ON eligible_race.id = eligible_entry.race_entry_id
          JOIN registrations eligible_registration
            ON eligible_registration.id = eligible_race.registration_id
           AND eligible_registration.status = 'ACTIVE'
         WHERE eligible_entry.heat_id = h.id
      ) >= 2)
      AND h.heat_number = (
        SELECT MIN(next_heat.heat_number) FROM heats next_heat
         WHERE next_heat.event_id = h.event_id AND next_heat.round = h.round
           AND next_heat.status NOT IN ('FINALIZED', 'CANCELLED')
           AND (next_heat.round = 'FINAL' OR (
             SELECT COUNT(*) FROM heat_entries eligible_next_entry
               JOIN race_entries eligible_next_race
                 ON eligible_next_race.id = eligible_next_entry.race_entry_id
               JOIN registrations eligible_next_registration
                 ON eligible_next_registration.id = eligible_next_race.registration_id
                AND eligible_next_registration.status = 'ACTIVE'
              WHERE eligible_next_entry.heat_id = next_heat.id
           ) >= 2)
      )
      AND r.status = 'ACTIVE' AND ${consentSql(channel)}
      AND EXISTS (
        SELECT 1 FROM race_commands rc
         WHERE rc.id = ? AND rc.event_id = h.event_id
      )
   ON CONFLICT DO NOTHING`,
).bind(
  storedType(channel, "HEAT_UPCOMING"), channel, commandId, commandId, now, now,
  eventId, round, commandId,
);

export const nextRunnableNotificationStatements = (
  env: Env,
  eventId: string,
  round: "ROUND_ONE" | "FINAL",
  commandId: string,
  now: string,
): D1PreparedStatement[] => bothChannels((channel) =>
  nextRunnableStatement(env, channel, eventId, round, commandId, now));

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

const awsRequest = async (
  env: Env,
  service: "ses" | "sns",
  method: "GET" | "POST",
  host: string,
  path: string,
  body: string,
  contentType: string,
): Promise<Response> => {
  if (
    env.AWS_REGION !== "us-east-1"
    || typeof env.AWS_ACCESS_KEY_ID !== "string" || env.AWS_ACCESS_KEY_ID.length < 16
    || typeof env.AWS_SECRET_ACCESS_KEY !== "string" || env.AWS_SECRET_ACCESS_KEY.length < 32
  ) throw new ParticipantSendError("AWS_CONFIGURATION_INVALID", false);
  const payloadHash = hex(await sha256(body));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `${method}\n${path}\n\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${env.AWS_REGION}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(textEncoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmac(dateKey, env.AWS_REGION);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  try {
    return await fetch(`https://${host}${path}`, {
      method,
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        "content-type": contentType,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      ...(method === "POST" ? { body } : {}),
    });
  } catch {
    throw new ParticipantSendError(`${service.toUpperCase()}_NETWORK_ERROR`, true);
  }
};

export const emailSuppressedBySes: ProviderSuppressionCheck = async (email, env) => {
  const path = `/v2/email/suppression/addresses/${encodeURIComponent(email)}`;
  const response = await awsRequest(env, "ses", "GET", `email.${env.AWS_REGION}.amazonaws.com`, path, "", "application/json");
  if (response.status === 404) return false;
  if (response.ok) return true;
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  throw new ParticipantSendError(retryable ? "SES_SUPPRESSION_CHECK_TEMPORARY_FAILURE" : "SES_SUPPRESSION_CHECK_REJECTED", retryable);
};

const snsBody = (values: Record<string, string>): string => new URLSearchParams(
  Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
).toString();

export const smsSuppressedBySns: ProviderSuppressionCheck = async (phone, env) => {
  const body = snsBody({ Action: "CheckIfPhoneNumberIsOptedOut", PhoneNumber: phone, Version: "2010-03-31" });
  const response = await awsRequest(
    env,
    "sns",
    "POST",
    `sns.${env.AWS_REGION}.amazonaws.com`,
    "/",
    body,
    "application/x-www-form-urlencoded; charset=utf-8",
  );
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new ParticipantSendError(retryable ? "SNS_OPT_OUT_CHECK_TEMPORARY_FAILURE" : "SNS_OPT_OUT_CHECK_REJECTED", retryable);
  }
  const providerBody = await response.text();
  return /<isOptedOut>\s*true\s*<\/isOptedOut>/i.test(providerBody);
};

export const sendSmsWithSns: SmsSender = async (sms, env) => {
  const body = snsBody({
    Action: "Publish",
    Message: sms.text,
    PhoneNumber: sms.to,
    "MessageAttributes.entry.1.Name": "AWS.SNS.SMS.SMSType",
    "MessageAttributes.entry.1.Value.DataType": "String",
    "MessageAttributes.entry.1.Value.StringValue": "Transactional",
    Version: "2010-03-31",
  });
  const response = await awsRequest(
    env,
    "sns",
    "POST",
    `sns.${env.AWS_REGION}.amazonaws.com`,
    "/",
    body,
    "application/x-www-form-urlencoded; charset=utf-8",
  );
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new ParticipantSendError(retryable ? "SNS_TEMPORARY_FAILURE" : "SNS_REJECTED", retryable);
  }
  const providerBody = await response.text();
  const messageId = providerBody.match(/<MessageId>([A-Za-z0-9-]{1,128})<\/MessageId>/)?.[1] ?? null;
  return { providerMessageId: messageId };
};

interface NotificationClaimRow {
  status: string;
  sending_started_at: string | null;
  retry_after: string | null;
  delivery_claim_token: string | null;
}

interface NotificationRow {
  id: string;
  event_id: string;
  registration_id: string;
  channel: ParticipantNotificationChannel;
  notification_type: string;
  template_version: number;
  result_revision: number | null;
  event_name: string;
  event_status: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  email_notifications_enabled: number;
  sms_notifications_enabled: number;
  registration_status: string;
  duck_assignment_id: string | null;
  active_duck_assignment_id: string | null;
  heat_id: string | null;
  heat_entry_id: string | null;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  visible_number: number | null;
  current_result_revision: number | null;
  result_place: number | null;
  earlier_actionable_heats: number;
}

interface AttemptNumberRow { last_attempt: number }

const claimRow = (env: Env, id: string): Promise<NotificationClaimRow | null> => env.DB.prepare(
  `SELECT status, sending_started_at, retry_after, delivery_claim_token
     FROM email_notifications WHERE id = ? LIMIT 1`,
).bind(id).first<NotificationClaimRow>();

const notificationRow = (env: Env, id: string): Promise<NotificationRow | null> => env.DB.prepare(
  `SELECT n.id, n.event_id, n.registration_id, n.channel, n.notification_type,
          n.template_version, n.result_revision,
          e.name AS event_name, e.status AS event_status,
          r.first_name, r.last_name, r.email, r.phone,
          r.email_notifications_enabled, r.sms_notifications_enabled,
          r.status AS registration_status, n.duck_assignment_id,
          da.id AS active_duck_assignment_id, n.heat_id,
          he.id AS heat_entry_id, h.round AS heat_round, h.heat_number,
          h.status AS heat_status, d.visible_number,
          (SELECT MAX(current_result.revision) FROM heat_results current_result
            WHERE current_result.heat_id = n.heat_id AND current_result.status = 'FINALIZED')
            AS current_result_revision,
          (SELECT participant_result.place FROM heat_results participant_result
            WHERE participant_result.heat_id = n.heat_id
              AND participant_result.race_entry_id = re.id
              AND participant_result.status = 'FINALIZED'
            LIMIT 1) AS result_place,
          (SELECT COUNT(*) FROM heats earlier
            WHERE earlier.event_id = h.event_id AND earlier.round = h.round
              AND earlier.heat_number < h.heat_number
              AND earlier.status NOT IN ('FINALIZED', 'CANCELLED')) AS earlier_actionable_heats
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
    WHERE n.id = ? LIMIT 1`,
).bind(id).first<NotificationRow>();

const completeAttempt = async (
  env: Env,
  id: string,
  claimToken: string,
  terminalStatus: "CANCELLED" | "FAILED",
  code: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = ?
        WHERE id = ? AND notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'`,
    ).bind(now, code, claimToken, id),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = ?, terminal_at = ?, status_reason = ?, last_error_code = ?,
              retry_after = NULL, sending_started_at = NULL,
              delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(
      terminalStatus,
      now,
      code,
      terminalStatus === "FAILED" ? code : null,
      now,
      id,
      claimToken,
    ),
  ]);
};

const failAmbiguous = async (env: Env, id: string, row: NotificationClaimRow): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = 'DELIVERY_OUTCOME_UNKNOWN'
        WHERE notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'`,
    ).bind(now, id),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'FAILED', terminal_at = ?, status_reason = 'DELIVERY_OUTCOME_UNKNOWN',
              last_error_code = 'DELIVERY_OUTCOME_UNKNOWN', retry_after = NULL,
              sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING'
          AND (sending_started_at = ? OR (sending_started_at IS NULL AND ? IS NULL))
          AND (delivery_claim_token = ? OR (delivery_claim_token IS NULL AND ? IS NULL))`,
    ).bind(
      now, now, id, row.sending_started_at, row.sending_started_at,
      row.delivery_claim_token, row.delivery_claim_token,
    ),
  ]);
};

const validationFailure = (row: NotificationRow): string | null => {
  const type = logicalType(row.notification_type);
  if (!(PARTICIPANT_NOTIFICATION_TYPES as readonly string[]).includes(type) || row.template_version !== 1) {
    return "UNSUPPORTED_TEMPLATE";
  }
  if (row.channel === "EMAIL") {
    if (row.email_notifications_enabled !== 1 || row.email === null) return "EMAIL_NOT_OPTED_IN";
    const normalized = row.email.trim().toLowerCase();
    if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) return "EMAIL_INVALID";
  } else {
    if (row.sms_notifications_enabled !== 1 || row.phone === null) return "SMS_NOT_OPTED_IN";
    if (normalizeUsPhone(row.phone) === null) return "SMS_DESTINATION_INVALID";
  }
  if (!new Set(["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED"]).has(row.event_status)) {
    return "EVENT_NO_LONGER_ACTIVE";
  }
  if (type === "REGISTRATION_CONFIRMATION") {
    return new Set(["SUBMITTED", "ACTIVE"]).has(row.registration_status) ? null : "REGISTRATION_NOT_ACTIVE";
  }
  if (row.registration_status !== "ACTIVE") return "REGISTRATION_NOT_ACTIVE";
  if (
    row.duck_assignment_id === null || row.active_duck_assignment_id === null
    || row.duck_assignment_id !== row.active_duck_assignment_id
    || row.heat_id === null || row.heat_entry_id === null || row.heat_round === null
    || row.heat_number === null || row.visible_number === null
  ) return "RACE_ASSIGNMENT_CHANGED";
  if (type === "HEAT_ASSIGNED" || type === "FINAL_ASSIGNED") {
    return new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
      ? null
      : "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  }
  if (type === "HEAT_UPCOMING") {
    return new Set(["LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
        && row.earlier_actionable_heats === 0
      ? null
      : "HEAT_NO_LONGER_UPCOMING";
  }
  if (
    type === "ROUND_RESULT"
    && row.heat_status === "FINALIZED"
    && row.result_revision !== null
    && row.current_result_revision === row.result_revision
  ) return null;
  return "RESULT_NO_LONGER_CURRENT";
};

const singleLine = (value: string): string => value
  .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const messageContent = (row: NotificationRow): { subject: string; action: string } => {
  const type = logicalType(row.notification_type);
  const duck = row.visible_number === null ? "Your duck" : `Duck #${row.visible_number}`;
  const round = row.heat_round === "FINAL" ? "Final" : "Round One";
  const heat = row.heat_number === null ? round : `${round}, Heat ${row.heat_number}`;
  if (type === "REGISTRATION_CONFIRMATION") return {
    subject: "Your QuickDucks registration is confirmed",
    action: `Your registration for ${singleLine(row.event_name)} is confirmed. Staff will pair you with a duck before racing.`,
  };
  if (type === "HEAT_ASSIGNED") return {
    subject: `${duck} is assigned to ${heat}`,
    action: `${duck} is assigned to ${heat}. Please stay near the pond and listen for your heat.`,
  };
  if (type === "FINAL_ASSIGNED") return {
    subject: `${duck} qualified for the Final`,
    action: `${duck} qualified and is assigned to ${heat}.`,
  };
  if (type === "HEAT_UPCOMING") return {
    subject: `${heat} is next to race`,
    action: `${heat} is next to race. Please bring ${duck} to the pond.`,
  };
  const place = row.result_place === null ? "did not place" : `finished in place ${row.result_place}`;
  const advancement = row.heat_round === "ROUND_ONE" && row.result_place === 1
    ? " You advanced to the Final."
    : "";
  return {
    subject: `${heat} result for ${duck}`,
    action: `${duck} ${place} in ${heat}.${advancement}`,
  };
};

const renderEmail = (row: NotificationRow, env: Env, unsubscribeToken: string): OutboundEmail => {
  const participant = singleLine(`${row.first_name} ${row.last_name}`);
  const content = messageContent(row);
  const raceUrl = new URL("/race", env.APP_ORIGIN).toString();
  const unsubscribeUrl = new URL(`/notifications/email/unsubscribe/${unsubscribeToken}`, env.APP_ORIGIN).toString();
  const text = [
    `Hi ${participant},`, "", content.action, "", `Event: ${singleLine(row.event_name)}`,
    `Race status: ${raceUrl}`, "", "Race progress can change, so this message does not promise a start time.",
    "You can turn off email updates from My Ducks on the device used to register.",
    `Unsubscribe this email address: ${unsubscribeUrl}`,
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body><p>Hi ${escapeHtml(participant)},</p>`
    + `<p><strong>${escapeHtml(content.action)}</strong></p>`
    + `<p>Event: ${escapeHtml(singleLine(row.event_name))}<br><a href="${escapeHtml(raceUrl)}">View race status</a></p>`
    + "<p>Race progress can change, so this message does not promise a start time.</p>"
    + "<p>You can turn off email updates from My Ducks on the device used to register, "
    + `or <a href="${escapeHtml(unsubscribeUrl)}">unsubscribe this email address</a>.</p></body></html>`;
  return { from: env.EMAIL_FROM_ADDRESS, to: row.email!.trim().toLowerCase(), subject: singleLine(content.subject), text, html };
};

const renderSms = (row: NotificationRow): OutboundSms => {
  const normalized = normalizeUsPhone(row.phone!)!;
  const digits = normalized.replace(/\D/g, "");
  return {
    to: `+1${digits}`,
    text: `QuickDucks: ${singleLine(messageContent(row).action)} Reply STOP to opt out.`,
  };
};

const retryDelay = (attemptNumber: number): number =>
  [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000][Math.min(attemptNumber - 1, 3)]!;

const destinationFor = (row: NotificationRow): string => row.channel === "EMAIL"
  ? row.email!.trim().toLowerCase()
  : renderSms(row).to;

const safeFailure = (error: unknown, channel: ParticipantNotificationChannel): ParticipantSendError => {
  if (
    error !== null && typeof error === "object"
    && typeof (error as { safeCode?: unknown }).safeCode === "string"
    && typeof (error as { retryable?: unknown }).retryable === "boolean"
  ) {
    const candidate = error as { safeCode: string; retryable: boolean };
    if (/^[A-Z0-9_]{1,100}$/.test(candidate.safeCode)) {
      return new ParticipantSendError(candidate.safeCode, candidate.retryable);
    }
  }
  return new ParticipantSendError(`${channel}_SENDER_FAILURE`, true);
};

export const processParticipantNotification = async (
  env: Env,
  notificationId: string,
  transports: ParticipantTransports,
): Promise<ParticipantProcessingResult> => {
  if (!notificationIdPattern.test(notificationId)) return "NOOP";
  const existing = await claimRow(env, notificationId);
  if (existing === null) return "NOOP";
  const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  if (existing.status === "SENDING") {
    if (existing.sending_started_at !== null && existing.sending_started_at >= staleBefore) return "RETRY";
    await failAmbiguous(env, notificationId, existing);
    return "FAILED";
  }
  if (!sendableStatuses.has(existing.status)) return "NOOP";
  const now = new Date().toISOString();
  if (existing.retry_after !== null && existing.retry_after > now) return "RETRY";

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
            SET status = 'SENDING', sending_started_at = ?, delivery_claim_token = ?, updated_at = ?
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

  const row = await notificationRow(env, notificationId);
  if (row === null) {
    await completeAttempt(env, notificationId, attemptId, "CANCELLED", "PARTICIPANT_NO_LONGER_AVAILABLE");
    return "CANCELLED";
  }
  const invalid = validationFailure(row);
  if (invalid !== null) {
    await completeAttempt(
      env,
      notificationId,
      attemptId,
      invalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED",
      invalid,
    );
    return invalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED";
  }

  const destination = destinationFor(row);
  const destinationHash = await hashToken(`${row.channel}:${destination}`);
  const locallySuppressed = await env.DB.prepare(
    "SELECT reason_code FROM notification_suppressions WHERE channel = ? AND destination_hash = ? LIMIT 1",
  ).bind(row.channel, destinationHash).first<{ reason_code: string }>();
  if (locallySuppressed !== null) {
    await completeAttempt(env, notificationId, attemptId, "CANCELLED", locallySuppressed.reason_code);
    return "CANCELLED";
  }

  try {
    const providerSuppressed = row.channel === "EMAIL"
      ? await (transports.emailSuppressed ?? emailSuppressedBySes)(destination, env)
      : await (transports.smsSuppressed ?? smsSuppressedBySns)(destination, env);
    if (providerSuppressed) {
      const code = row.channel === "EMAIL" ? "SES_SUPPRESSED" : "SMS_STOP";
      const suppressedAt = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO notification_suppressions
          (channel, destination_hash, reason_code, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(channel, destination_hash) DO UPDATE
           SET reason_code = excluded.reason_code, updated_at = excluded.updated_at`,
      ).bind(row.channel, destinationHash, code, suppressedAt, suppressedAt).run();
      await completeAttempt(env, notificationId, attemptId, "CANCELLED", code);
      return "CANCELLED";
    }
  } catch (error) {
    const failure = safeFailure(error, row.channel);
    const completedAt = new Date().toISOString();
    const retryable = failure.retryable && attemptNumber < 5;
    const code = failure.retryable && !retryable ? "DELIVERY_RETRIES_EXHAUSTED" : failure.safeCode;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts SET status = ?, completed_at = ?, error_code = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(retryable ? "TEMPORARY_FAILURE" : "PERMANENT_FAILURE", completedAt, code, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = ?, terminal_at = ?, status_reason = ?, last_error_code = ?,
                retry_after = ?, sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(
        retryable ? "RETRY_PENDING" : "FAILED",
        retryable ? null : completedAt,
        retryable ? null : code,
        code,
        retryable ? new Date(Date.now() + retryDelay(attemptNumber)).toISOString() : null,
        completedAt,
        notificationId,
        attemptId,
      ),
    ]);
    return retryable ? "RETRY" : "FAILED";
  }

  let result: ParticipantSendResult;
  try {
    if (row.channel === "EMAIL") {
      if (transports.emailSender === undefined) throw new ParticipantSendError("SES_CONFIGURATION_INVALID", false);
      const unsubscribeToken = randomToken();
      const tokenHash = await hashToken(unsubscribeToken);
      const createdAt = new Date().toISOString();
      const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60_000).toISOString();
      await env.DB.prepare(
        `INSERT INTO notification_unsubscribe_tokens
          (token_hash, destination_hash, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(tokenHash, destinationHash, createdAt, expiresAt).run();
      result = await transports.emailSender(renderEmail(row, env, unsubscribeToken), env);
    } else {
      result = await (transports.smsSender ?? sendSmsWithSns)(renderSms(row), env);
    }
  } catch (error) {
    const failure = safeFailure(error, row.channel);
    const completedAt = new Date().toISOString();
    const retryable = failure.retryable && attemptNumber < 5;
    const code = failure.retryable && !retryable ? "DELIVERY_RETRIES_EXHAUSTED" : failure.safeCode;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts SET status = ?, completed_at = ?, error_code = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(retryable ? "TEMPORARY_FAILURE" : "PERMANENT_FAILURE", completedAt, code, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = ?, terminal_at = ?, status_reason = ?, last_error_code = ?,
                retry_after = ?, sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(
        retryable ? "RETRY_PENDING" : "FAILED",
        retryable ? null : completedAt,
        retryable ? null : code,
        code,
        retryable ? new Date(Date.now() + retryDelay(attemptNumber)).toISOString() : null,
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
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts
          SET status = 'SENT', completed_at = ?, provider_message_id = ?, error_code = NULL
        WHERE id = ? AND status = 'SENDING'`,
    ).bind(sentAt, providerMessageId, attemptId),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'SENT', sent_at = ?, sending_started_at = NULL,
              delivery_claim_token = NULL, status_reason = ?, last_error_code = NULL,
              retry_after = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(sentAt, row.channel === "EMAIL" ? "SES_ACCEPTED" : "SNS_ACCEPTED", sentAt, notificationId, attemptId),
  ]);
  return "SENT";
};

export const unsubscribeEmail = async (env: Env, token: string): Promise<Response> => {
  const now = new Date().toISOString();
  if (/^[A-Za-z0-9_-]{43,128}$/.test(token)) {
    const tokenHash = await hashToken(token);
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO notification_suppressions
            (channel, destination_hash, reason_code, created_at, updated_at)
           SELECT 'EMAIL', destination_hash, 'EMAIL_UNSUBSCRIBE', ?, ?
             FROM notification_unsubscribe_tokens
            WHERE token_hash = ? AND expires_at >= ?
           ON CONFLICT(channel, destination_hash) DO UPDATE
             SET reason_code = 'EMAIL_UNSUBSCRIBE', updated_at = excluded.updated_at`,
        ).bind(now, now, tokenHash, now),
        env.DB.prepare(
          `UPDATE notification_unsubscribe_tokens SET used_at = COALESCE(used_at, ?)
            WHERE token_hash = ? AND expires_at >= ?`,
        ).bind(now, tokenHash, now),
      ]);
    } catch {
      // The capability response is deliberately non-enumerating. A transient
      // database failure does not expose whether this token ever existed.
    }
  }
  return new Response(
    "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>Email updates are off</title></head><body><main><h1>Email updates are off</h1><p>QuickDucks will suppress participant race updates to this email address. You can still change preferences for an active registration from My Ducks.</p><p><a href=\"/\">Return to QuickDucks</a></p></main></body></html>",
    {
      headers: {
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; style-src 'unsafe-inline'",
        "content-type": "text/html; charset=utf-8",
        "referrer-policy": "no-referrer",
        "strict-transport-security": "max-age=31536000",
        "x-content-type-options": "nosniff",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
};
