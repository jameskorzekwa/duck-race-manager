import type { EmailSender, OutboundEmail } from "./email-notifications.ts";
import type { Env } from "./types.ts";

export type NotificationChannel = "EMAIL" | "SMS";
export type ParticipantNotificationResult =
  | "SENT"
  | "CANCELLED"
  | "FAILED"
  | "DEFERRED"
  | "NOT_FOUND";

export interface OutboundSms {
  to: string;
  text: string;
}

export interface ProviderSendResult {
  providerMessageId: string | null;
}

export type SmsSender = (sms: OutboundSms, env: Env) => Promise<ProviderSendResult>;
export type EmailSuppressionChecker = (email: string, env: Env) => Promise<boolean>;
export type SmsSuppressionChecker = (phone: string, env: Env) => Promise<boolean>;

export interface ParticipantNotificationAdapters {
  emailSender: EmailSender;
  smsSender: SmsSender;
  emailSuppression: EmailSuppressionChecker;
  smsSuppression: SmsSuppressionChecker;
}

export class NotificationProviderError extends Error {
  readonly safeCode: string;
  readonly retryable: boolean;

  constructor(safeCode: string, retryable: boolean) {
    super(safeCode);
    this.safeCode = safeCode;
    this.retryable = retryable;
  }
}

interface NotificationStateRow {
  status: string;
  retry_after: string | null;
  sending_started_at: string | null;
  delivery_claim_token: string | null;
}

interface ParticipantNotificationRow {
  id: string;
  channel: NotificationChannel;
  notification_type: string;
  template_version: number;
  status: string;
  run_sequence: number | null;
  result_revision: number | null;
  event_name: string;
  event_status: string;
  registration_status: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  email_notifications_enabled: number;
  sms_notifications_enabled: number;
  heat_id: string | null;
  heat_entry_id: string | null;
  active_heat_entry_id: string | null;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  current_run_sequence: number | null;
  next_heat_id: string | null;
  visible_number: number | null;
  result_set_exists: number;
  result_place: number | null;
}

const encoder = new TextEncoder();
const notificationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const providerIdPattern = /^[A-Za-z0-9._:/+=-]{1,256}$/;
const terminalStatuses = new Set(["SENT", "FAILED", "SUPPRESSED", "CANCELLED"]);
const MAX_DELIVERY_ATTEMPTS = 5;

const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));

const hmacBytes = async (key: Uint8Array, value: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
};

const notificationKey = (env: Env): Uint8Array => {
  if (typeof env.NOTIFICATION_HMAC_KEY !== "string" || env.NOTIFICATION_HMAC_KEY.length < 32) {
    throw new NotificationProviderError("NOTIFICATION_KEY_INVALID", false);
  }
  return encoder.encode(env.NOTIFICATION_HMAC_KEY);
};

const notificationKeys = (env: Env): Uint8Array[] => {
  const keys = [notificationKey(env)];
  if (env.NOTIFICATION_HMAC_PREVIOUS_KEY !== undefined) {
    if (env.NOTIFICATION_HMAC_PREVIOUS_KEY.length < 32) {
      throw new NotificationProviderError("NOTIFICATION_PREVIOUS_KEY_INVALID", false);
    }
    keys.push(encoder.encode(env.NOTIFICATION_HMAC_PREVIOUS_KEY));
  }
  return keys;
};

export const canonicalEmail = (value: string | null): string | null => {
  if (value === null) return null;
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || /[\s\r\n]/.test(email)) return null;
  const at = email.indexOf("@");
  if (at < 1 || at !== email.lastIndexOf("@") || at === email.length - 1) return null;
  if (!email.slice(at + 1).includes(".")) return null;
  return email;
};

export const canonicalSmsPhone = (value: string | null): string | null => {
  if (value === null) return null;
  const digits = value.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  return `+1${national}`;
};

export const destinationHash = async (
  channel: NotificationChannel,
  destination: string,
  env: Env,
): Promise<string> => hex(await hmacBytes(notificationKey(env), `${channel}\0${destination}`));

export const destinationHashes = async (
  channel: NotificationChannel,
  destination: string,
  env: Env,
): Promise<string[]> => Promise.all(
  notificationKeys(env).map(async (key) => hex(await hmacBytes(key, `${channel}\0${destination}`))),
);

const unsubscribeSignature = async (destination: string, env: Env): Promise<string> =>
  hex(await hmacBytes(notificationKey(env), `EMAIL_UNSUBSCRIBE\0${destination}`));

export const emailUnsubscribeToken = async (destination: string, env: Env): Promise<string> =>
  `${destination}.${await unsubscribeSignature(destination, env)}`;

const validUnsubscribeToken = async (token: string, env: Env): Promise<string | null> => {
  const match = token.match(/^([0-9a-f]{64})\.([0-9a-f]{64})$/);
  if (match === null) return null;
  let expected: string[];
  try {
    expected = await Promise.all(notificationKeys(env).map(
      async (key) => hex(await hmacBytes(key, `EMAIL_UNSUBSCRIBE\0${match[1]}`)),
    ));
  } catch {
    return null;
  }
  for (const candidate of expected) {
    let difference = 0;
    for (let index = 0; index < candidate.length; index += 1) {
      difference |= candidate.charCodeAt(index) ^ match[2].charCodeAt(index);
    }
    if (difference === 0) return match[1];
  }
  return null;
};

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

const awsRequest = async (
  env: Env,
  service: "ses" | "sms-voice",
  method: "GET" | "POST",
  path: string,
  body = "",
  query: Record<string, string> = {},
): Promise<Response> => {
  if (
    env.AWS_REGION !== "us-east-1"
    || typeof env.AWS_ACCESS_KEY_ID !== "string" || env.AWS_ACCESS_KEY_ID.length < 16
    || typeof env.AWS_SECRET_ACCESS_KEY !== "string" || env.AWS_SECRET_ACCESS_KEY.length < 32
  ) throw new NotificationProviderError("AWS_CONFIGURATION_INVALID", false);
  const host = service === "ses"
    ? `email.${env.AWS_REGION}.amazonaws.com`
    : `sms-voice.${env.AWS_REGION}.amazonaws.com`;
  const payloadHash = hex(await sha256(body));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const awsEncode = (value: string): string => encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalQuery = Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${awsEncode(name)}=${awsEncode(value)}`)
    .join("&");
  const canonicalRequest = `${method}\n${path}\n${canonicalQuery}\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${env.AWS_REGION}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmacBytes(encoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmacBytes(dateKey, env.AWS_REGION);
  const serviceKey = await hmacBytes(regionKey, service);
  const signingKey = await hmacBytes(serviceKey, "aws4_request");
  const signature = hex(await hmacBytes(signingKey, stringToSign));
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
    throw new NotificationProviderError("AWS_NETWORK_ERROR", true);
  }
};

const providerFailure = (prefix: string, response: Response): NotificationProviderError => {
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  return new NotificationProviderError(`${prefix}_${retryable ? "TEMPORARY_FAILURE" : "REJECTED"}`, retryable);
};

export const isEmailSuppressedWithSes: EmailSuppressionChecker = async (email, env) => {
  const path = `/v2/email/suppression/addresses/${encodeURIComponent(email)}`;
  const response = await awsRequest(env, "ses", "GET", path);
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw providerFailure("SES_SUPPRESSION", response);
};

export const isSmsSuppressedWithAws: SmsSuppressionChecker = async (phone, env) => {
  const listName = env.SMS_OPT_OUT_LIST_NAME;
  if (typeof listName !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(listName)) {
    throw new NotificationProviderError("SMS_OPT_OUT_CONFIGURATION_INVALID", false);
  }
  const path = `/v2/sms-voice/opt-out-lists/${encodeURIComponent(listName)}/opted-out-numbers`;
  let nextToken: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const response = await awsRequest(env, "sms-voice", "GET", path, "", {
      MaxResults: "100",
      ...(nextToken === undefined ? {} : { NextToken: nextToken }),
    });
    if (!response.ok) throw providerFailure("SMS_OPT_OUT_LOOKUP", response);
    let payload: { OptedOutNumbers?: unknown; NextToken?: unknown };
    try {
      payload = await response.json() as { OptedOutNumbers?: unknown; NextToken?: unknown };
    } catch {
      throw new NotificationProviderError("SMS_OPT_OUT_RESPONSE_INVALID", true);
    }
    if (!Array.isArray(payload.OptedOutNumbers)) {
      throw new NotificationProviderError("SMS_OPT_OUT_RESPONSE_INVALID", true);
    }
    for (const item of payload.OptedOutNumbers) {
      if (
        item !== null && typeof item === "object"
        && (item as { OptedOutNumber?: unknown }).OptedOutNumber === phone
      ) return true;
    }
    if (payload.NextToken === undefined || payload.NextToken === null) return false;
    if (typeof payload.NextToken !== "string" || payload.NextToken.length > 2048) {
      throw new NotificationProviderError("SMS_OPT_OUT_RESPONSE_INVALID", true);
    }
    nextToken = payload.NextToken;
  }
  throw new NotificationProviderError("SMS_OPT_OUT_PAGINATION_LIMIT", true);
};

export const sendSmsWithAws: SmsSender = async (sms, env) => {
  if (
    typeof env.SMS_ORIGINATION_IDENTITY !== "string"
    || env.SMS_ORIGINATION_IDENTITY.length < 2
    || env.SMS_ORIGINATION_IDENTITY.length > 256
  ) throw new NotificationProviderError("SMS_CONFIGURATION_INVALID", false);
  const body = JSON.stringify({
    DestinationPhoneNumber: sms.to,
    OriginationIdentity: env.SMS_ORIGINATION_IDENTITY,
    MessageBody: sms.text,
    MessageType: "TRANSACTIONAL",
  });
  const response = await awsRequest(env, "sms-voice", "POST", "/v2/sms-voice/text-message", body);
  if (!response.ok) throw providerFailure("SMS", response);
  let providerMessageId: string | null = null;
  try {
    const payload = await response.json() as { MessageId?: unknown };
    if (typeof payload.MessageId === "string" && providerIdPattern.test(payload.MessageId)) {
      providerMessageId = payload.MessageId;
    }
  } catch {
    // A successful provider status is acceptance; its optional body is never
    // retained and cannot turn acceptance into a retry.
  }
  return { providerMessageId };
};

export const defaultParticipantNotificationAdapters: ParticipantNotificationAdapters = {
  async emailSender() {
    // `createWorker` replaces this with the SES adapter. Keeping this module's
    // default fail-closed avoids a runtime import cycle with that adapter.
    throw new NotificationProviderError("EMAIL_SENDER_NOT_CONFIGURED", false);
  },
  smsSender: sendSmsWithAws,
  emailSuppression: isEmailSuppressedWithSes,
  smsSuppression: isSmsSuppressedWithAws,
};

const stateRow = (env: Env, id: string): Promise<NotificationStateRow | null> => env.DB.prepare(
  `SELECT status, retry_after, sending_started_at, delivery_claim_token
     FROM participant_notifications WHERE id = ? LIMIT 1`,
).bind(id).first<NotificationStateRow>();

const notificationRow = (env: Env, id: string): Promise<ParticipantNotificationRow | null> => env.DB.prepare(
  `SELECT n.id, n.channel, n.notification_type, n.template_version, n.status,
          n.run_sequence, n.result_revision, e.name AS event_name,
          e.status AS event_status, r.status AS registration_status,
          r.first_name, r.last_name, r.email, r.phone,
          r.email_notifications_enabled, r.sms_notifications_enabled,
          n.heat_id, n.heat_entry_id, he.id AS active_heat_entry_id,
          h.round AS heat_round, h.heat_number, h.status AS heat_status,
          h.notification_run_sequence AS current_run_sequence,
          (SELECT next.id FROM heats next
            WHERE next.event_id = n.event_id AND next.round = h.round
              AND next.status NOT IN ('FINALIZED', 'CANCELLED')
            ORDER BY next.heat_number LIMIT 1) AS next_heat_id,
          d.visible_number,
          EXISTS(SELECT 1 FROM heat_results official
            WHERE official.heat_id = n.heat_id AND official.revision = n.result_revision
              AND official.status = 'FINALIZED') AS result_set_exists,
          (SELECT own.place FROM heat_results own
            WHERE own.heat_id = n.heat_id AND own.race_entry_id = re.id
              AND own.revision = n.result_revision AND own.status = 'FINALIZED'
            LIMIT 1) AS result_place
     FROM participant_notifications n
     JOIN events e ON e.id = n.event_id
     JOIN registrations r ON r.id = n.registration_id AND r.event_id = n.event_id
     JOIN race_entries re ON re.registration_id = r.id AND re.event_id = n.event_id
     LEFT JOIN heat_entries he ON he.id = n.heat_entry_id
       AND he.race_entry_id = re.id AND he.heat_id = n.heat_id
     LEFT JOIN heats h ON h.id = n.heat_id AND h.event_id = n.event_id
     LEFT JOIN duck_assignments da ON da.race_entry_id = re.id
       AND da.event_id = n.event_id AND da.valid_to IS NULL
     LEFT JOIN ducks d ON d.id = da.duck_id
    WHERE n.id = ? LIMIT 1`,
).bind(id).first<ParticipantNotificationRow>();

const destinationFor = (row: ParticipantNotificationRow): string | null => row.channel === "EMAIL"
  ? (row.email_notifications_enabled === 1 ? canonicalEmail(row.email) : null)
  : (row.sms_notifications_enabled === 1 ? canonicalSmsPhone(row.phone) : null);

const validationFailure = (row: ParticipantNotificationRow): string | null => {
  if (row.template_version !== 1 || destinationFor(row) === null) return `${row.channel}_NOT_OPTED_IN`;
  if (!new Set(["SUBMITTED", "ACTIVE"]).has(row.registration_status)) return "REGISTRATION_NOT_ACTIVE";
  if (row.notification_type === "REGISTRATION_CONFIRMATION") return null;
  if (row.heat_id === null || row.heat_round === null || row.heat_number === null) return "HEAT_CHANGED";
  if (row.notification_type === "ROUND_ONE_ASSIGNED" || row.notification_type === "FINAL_ASSIGNED") {
    if (row.active_heat_entry_id === null || row.visible_number === null) return "HEAT_ASSIGNMENT_CHANGED";
    if (!new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")) {
      return "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
    }
    return null;
  }
  if (row.notification_type === "HEAT_UPCOMING") {
    if (
      row.active_heat_entry_id === null || row.visible_number === null
      || row.run_sequence !== row.current_run_sequence
      || row.next_heat_id !== row.heat_id
      || !new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
      || (row.heat_round === "ROUND_ONE" && row.event_status !== "ROUND_ONE")
      || (row.heat_round === "FINAL" && row.event_status !== "FINAL")
    ) return "HEAT_NO_LONGER_UPCOMING";
    return null;
  }
  if (row.notification_type === "ROUND_RESULT" || row.notification_type === "FINAL_RESULT") {
    return row.result_set_exists === 1 ? null : "RESULT_SUPERSEDED";
  }
  return "UNSUPPORTED_TEMPLATE";
};

const renderCopy = (row: ParticipantNotificationRow): { subject: string; action: string } => {
  const round = row.heat_round === "FINAL" ? "Final" : "Round One";
  const heat = row.heat_number === null ? round : `${round}, Heat ${row.heat_number}`;
  const duck = row.visible_number === null ? "Your duck" : `Duck #${row.visible_number}`;
  switch (row.notification_type) {
    case "REGISTRATION_CONFIRMATION":
      return { subject: `Registration confirmed for ${singleLine(row.event_name)}`, action: `Your registration for ${singleLine(row.event_name)} is confirmed.` };
    case "ROUND_ONE_ASSIGNED":
    case "FINAL_ASSIGNED":
      return { subject: `${duck} is assigned to ${heat}`, action: `${duck} is assigned to ${heat}. Please stay near the pond.` };
    case "HEAT_UPCOMING":
      return { subject: `${heat} is up next`, action: `${heat} is up next. Please bring ${duck} to the pond.` };
    case "ROUND_RESULT":
      return row.result_place === 1
        ? { subject: `${heat} result: advancing to the Final`, action: `${duck} finished first in ${heat} and advances to the Final.` }
        : { subject: `${heat} result`, action: `The result for ${heat} is official. ${duck} did not advance to the Final.` };
    case "FINAL_RESULT":
      return row.result_place === null
        ? { subject: "Your Final result", action: `The result for ${heat} is official.` }
        : { subject: `Your Final result: place ${row.result_place}`, action: `${duck} finished in place ${row.result_place} in the Final.` };
    default:
      return { subject: "QuickDucks race update", action: "Your race status has changed." };
  }
};

const renderEmail = async (
  row: ParticipantNotificationRow,
  destination: string,
  destinationId: string,
  env: Env,
): Promise<OutboundEmail> => {
  const copy = renderCopy(row);
  const participant = singleLine(`${row.first_name} ${row.last_name}`);
  const raceUrl = new URL("/race", env.APP_ORIGIN).toString();
  const unsubscribe = new URL("/notifications/email/unsubscribe", env.APP_ORIGIN);
  unsubscribe.searchParams.set("token", await emailUnsubscribeToken(destinationId, env));
  return {
    from: env.EMAIL_FROM_ADDRESS,
    to: destination,
    subject: singleLine(copy.subject),
    text: [
      `Hi ${participant},`, "", copy.action, "", `Race status: ${raceUrl}`, "",
      "Race progress can change, so reminders do not promise a start time.",
      `Unsubscribe from QuickDucks email: ${unsubscribe.toString()}`,
    ].join("\n"),
    html: `<!doctype html><html lang="en"><body><p>Hi ${escapeHtml(participant)},</p>`
      + `<p><strong>${escapeHtml(copy.action)}</strong></p><p><a href="${escapeHtml(raceUrl)}">View race status</a></p>`
      + "<p>Race progress can change, so reminders do not promise a start time.</p>"
      + `<p><a href="${escapeHtml(unsubscribe.toString())}">Unsubscribe from QuickDucks email</a></p></body></html>`,
    headers: {
      "List-Unsubscribe": `<${unsubscribe.toString()}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
};

const renderSms = (row: ParticipantNotificationRow, destination: string): OutboundSms => ({
  to: destination,
  text: `QuickDucks: ${renderCopy(row).action} Reply STOP to opt out.`,
});

const isApplicationSuppressed = async (
  env: Env,
  channel: NotificationChannel,
  hash: string,
): Promise<boolean> => (await env.DB.prepare(
  `SELECT 1 AS suppressed FROM participant_notification_suppressions
    WHERE channel = ? AND destination_hash = ? LIMIT 1`,
).bind(channel, hash).first<{ suppressed: number }>()) !== null;

const finish = async (
  env: Env,
  id: string,
  claim: string,
  status: "CANCELLED" | "FAILED" | "SUPPRESSED",
  reason: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE participant_notification_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = ?
        WHERE id = ? AND notification_id = ? AND status = 'SENDING'`,
    ).bind(now, reason, claim, id),
    env.DB.prepare(
      `UPDATE participant_notifications
          SET status = ?, terminal_at = ?, status_reason = ?, last_error_code = NULL,
              retry_after = NULL, sending_started_at = NULL,
              delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(status, now, reason, now, id, claim),
  ]);
};

const failAmbiguous = async (env: Env, id: string, state: NotificationStateRow): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE participant_notification_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = 'DELIVERY_OUTCOME_UNKNOWN'
        WHERE notification_id = ? AND status = 'SENDING'`,
    ).bind(now, id),
    env.DB.prepare(
      `UPDATE participant_notifications
          SET status = 'FAILED', terminal_at = ?, status_reason = 'DELIVERY_OUTCOME_UNKNOWN',
              last_error_code = 'DELIVERY_OUTCOME_UNKNOWN', retry_after = NULL,
              sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING'
          AND (delivery_claim_token = ? OR (delivery_claim_token IS NULL AND ? IS NULL))`,
    ).bind(now, now, id, state.delivery_claim_token, state.delivery_claim_token),
  ]);
};

const retryDelay = (attempt: number): number => Math.min(15 * 60_000, 30_000 * (2 ** Math.max(0, attempt - 1)));

const recordProviderFailure = async (
  env: Env,
  id: string,
  claim: string,
  attempt: number,
  failure: NotificationProviderError,
): Promise<ParticipantNotificationResult> => {
  const now = new Date().toISOString();
  const retryable = failure.retryable && attempt < MAX_DELIVERY_ATTEMPTS;
  const code = failure.retryable && !retryable ? "DELIVERY_RETRIES_EXHAUSTED" : failure.safeCode;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE participant_notification_attempts SET status = ?, completed_at = ?, error_code = ?
        WHERE id = ? AND notification_id = ? AND status = 'SENDING'`,
    ).bind(retryable ? "TEMPORARY_FAILURE" : "PERMANENT_FAILURE", now, code, claim, id),
    env.DB.prepare(
      `UPDATE participant_notifications
          SET status = ?, terminal_at = ?, last_error_code = ?, retry_after = ?,
              sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(
      retryable ? "RETRY_PENDING" : "FAILED",
      retryable ? null : now,
      code,
      retryable ? new Date(Date.now() + retryDelay(attempt)).toISOString() : null,
      now,
      id,
      claim,
    ),
  ]);
  return retryable ? "DEFERRED" : "FAILED";
};

export const processParticipantNotification = async (
  env: Env,
  id: string,
  adapters: ParticipantNotificationAdapters = defaultParticipantNotificationAdapters,
): Promise<ParticipantNotificationResult> => {
  if (!notificationIdPattern.test(id)) return "NOT_FOUND";
  const state = await stateRow(env, id);
  if (state === null) return "NOT_FOUND";
  if (terminalStatuses.has(state.status)) return "DEFERRED";
  const now = new Date().toISOString();
  if (state.status === "SENDING") {
    if (state.sending_started_at !== null && state.sending_started_at >= new Date(Date.now() - 120_000).toISOString()) {
      return "DEFERRED";
    }
    await failAmbiguous(env, id, state);
    return "FAILED";
  }
  if (!new Set(["PENDING", "QUEUED", "RETRY_PENDING"]).has(state.status)) return "DEFERRED";
  if (state.retry_after !== null && state.retry_after > now) return "DEFERRED";

  const previous = await env.DB.prepare(
    `SELECT COALESCE(MAX(attempt_number), 0) AS count
       FROM participant_notification_attempts WHERE notification_id = ? AND stage = 'DELIVERY'`,
  ).bind(id).first<{ count: number }>();
  const attempt = Number(previous?.count ?? 0) + 1;
  const claim = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE participant_notifications
            SET status = 'SENDING', sending_started_at = ?, delivery_claim_token = ?, updated_at = ?
          WHERE id = ? AND status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')
            AND (retry_after IS NULL OR retry_after <= ?)`,
      ).bind(now, claim, now, id, now),
      env.DB.prepare(
        `INSERT INTO participant_notification_attempts
          (id, event_id, notification_id, attempt_number, stage, status, started_at)
         SELECT ?, event_id, id, ?, 'DELIVERY', 'SENDING', ?
           FROM participant_notifications
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(claim, attempt, now, id, claim),
    ]);
  } catch {
    return "DEFERRED";
  }
  const claimed = await env.DB.prepare(
    "SELECT 1 AS claimed FROM participant_notification_attempts WHERE id = ? AND status = 'SENDING'",
  ).bind(claim).first<{ claimed: number }>();
  if (claimed === null) return "DEFERRED";

  let row = await notificationRow(env, id);
  if (row === null) {
    await finish(env, id, claim, "CANCELLED", "LIFECYCLE_CHANGED");
    return "CANCELLED";
  }
  let invalid = validationFailure(row);
  if (invalid !== null) {
    await finish(env, id, claim, invalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED", invalid);
    return invalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED";
  }
  let destination = destinationFor(row)!;
  let hash: string;
  try {
    const hashes = await destinationHashes(row.channel, destination, env);
    hash = hashes[0];
    if ((await Promise.all(hashes.map((candidate) =>
      isApplicationSuppressed(env, row!.channel, candidate)))).some(Boolean)) {
      await finish(env, id, claim, "SUPPRESSED", "APPLICATION_SUPPRESSION");
      return "CANCELLED";
    }
    const providerSuppressed = row.channel === "EMAIL"
      ? await adapters.emailSuppression(destination, env)
      : await adapters.smsSuppression(destination, env);
    if (providerSuppressed) {
      await finish(env, id, claim, "SUPPRESSED", row.channel === "EMAIL" ? "SES_SUPPRESSED" : "SMS_STOPPED");
      return "CANCELLED";
    }
  } catch (error) {
    const failure = error instanceof NotificationProviderError
      ? error
      : new NotificationProviderError("SUPPRESSION_CHECK_FAILED", true);
    return recordProviderFailure(env, id, claim, attempt, failure);
  }

  // Provider suppression can take time.  Reload consent, destination, and the
  // lifecycle immediately before submission, then recheck the keyed local
  // suppression record for that exact current destination.
  row = await notificationRow(env, id);
  invalid = row === null ? "LIFECYCLE_CHANGED" : validationFailure(row);
  const currentDestination = row === null ? null : destinationFor(row);
  if (row === null || invalid !== null || currentDestination === null || currentDestination !== destination) {
    await finish(env, id, claim, "CANCELLED", invalid ?? "CONTACT_CHANGED");
    return "CANCELLED";
  }
  destination = currentDestination;
  const currentHashes = await destinationHashes(row.channel, destination, env);
  hash = currentHashes[0];
  if ((await Promise.all(currentHashes.map((candidate) =>
    isApplicationSuppressed(env, row!.channel, candidate)))).some(Boolean)) {
    await finish(env, id, claim, "SUPPRESSED", "APPLICATION_SUPPRESSION");
    return "CANCELLED";
  }

  let providerResult: ProviderSendResult;
  try {
    providerResult = row.channel === "EMAIL"
      ? await adapters.emailSender(await renderEmail(row, destination, hash, env), env)
      : await adapters.smsSender(renderSms(row, destination), env);
  } catch (error) {
    const failure = error instanceof NotificationProviderError
      ? error
      : error !== null && typeof error === "object" && "safeCode" in error && "retryable" in error
        ? new NotificationProviderError(String(error.safeCode), error.retryable === true)
        : new NotificationProviderError(`${row.channel}_SENDER_FAILURE`, true);
    return recordProviderFailure(env, id, claim, attempt, failure);
  }
  const sentAt = new Date().toISOString();
  const providerId = typeof providerResult.providerMessageId === "string"
      && providerIdPattern.test(providerResult.providerMessageId)
    ? providerResult.providerMessageId
    : null;
  // Kept outside the provider catch: once accepted, a D1 failure is ambiguous
  // and stale recovery must terminally fail it rather than resend.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE participant_notification_attempts
          SET status = 'SENT', completed_at = ?, provider_message_id = ?, error_code = NULL
        WHERE id = ? AND status = 'SENDING'`,
    ).bind(sentAt, providerId, claim),
    env.DB.prepare(
      `UPDATE participant_notifications
          SET status = 'SENT', sent_at = ?, terminal_at = ?, status_reason = 'PROVIDER_ACCEPTED',
              last_error_code = NULL, retry_after = NULL, sending_started_at = NULL,
              delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(sentAt, sentAt, sentAt, id, claim),
  ]);
  return "SENT";
};

const publishOne = async (env: Env, id: string): Promise<void> => {
  const now = new Date().toISOString();
  const row = await env.DB.prepare(
    `SELECT id, event_id, status, publication_failure_count
       FROM participant_notifications
      WHERE id = ?
        AND ((status = 'PENDING')
          OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?))
          OR (status = 'QUEUED' AND updated_at <= ?))
      LIMIT 1`,
  ).bind(id, now, new Date(Date.now() - 5 * 60_000).toISOString()).first<{
    id: string;
    event_id: string;
    status: string;
    publication_failure_count: number;
  }>();
  if (row === null) return;
  const attemptRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(attempt_number), 0) AS count
       FROM participant_notification_attempts WHERE notification_id = ? AND stage = 'QUEUE'`,
  ).bind(id).first<{ count: number }>();
  const attempt = Number(attemptRow?.count ?? 0) + 1;
  const attemptId = crypto.randomUUID();
  const started = new Date().toISOString();
  try {
    await env.EMAIL_QUEUE.send(id);
    const completed = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO participant_notification_attempts
          (id, event_id, notification_id, attempt_number, stage, status, started_at, completed_at)
         VALUES (?, ?, ?, ?, 'QUEUE', 'QUEUED', ?, ?)`,
      ).bind(attemptId, row.event_id, id, attempt, started, completed),
      env.DB.prepare(
        `UPDATE participant_notifications SET status = 'QUEUED', queued_at = COALESCE(queued_at, ?),
                retry_after = NULL, last_error_code = NULL, updated_at = ?
          WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING', 'QUEUED')`,
      ).bind(completed, completed, id),
    ]);
  } catch {
    const completed = new Date().toISOString();
    const failures = row.publication_failure_count + 1;
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO participant_notification_attempts
            (id, event_id, notification_id, attempt_number, stage, status, started_at, completed_at, error_code)
           VALUES (?, ?, ?, ?, 'QUEUE', 'TEMPORARY_FAILURE', ?, ?, 'QUEUE_PUBLISH_FAILED')`,
        ).bind(attemptId, row.event_id, id, attempt, started, completed),
        env.DB.prepare(
          `UPDATE participant_notifications
              SET status = 'RETRY_PENDING', publication_failure_count = ?,
                  retry_after = ?, last_error_code = 'QUEUE_PUBLISH_FAILED', updated_at = ?
            WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING', 'QUEUED')`,
        ).bind(
          failures,
          new Date(Date.now() + Math.min(60 * 60_000, 30_000 * (2 ** Math.min(failures - 1, 7)))).toISOString(),
          completed,
          id,
        ),
      ]);
    } catch {
      // The durable outbox remains discoverable.  Publication is best effort.
    }
  }
};

export const dispatchPendingParticipantNotifications = async (env: Env): Promise<void> => {
  try {
    const now = new Date().toISOString();
    const rows = await env.DB.prepare(
      `SELECT id FROM participant_notifications
        WHERE status = 'PENDING'
           OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?))
           OR (status = 'QUEUED' AND updated_at <= ?)
           OR (status = 'SENDING' AND sending_started_at <= ?)
        ORDER BY created_at, id LIMIT 100`,
    ).bind(
      now,
      new Date(Date.now() - 5 * 60_000).toISOString(),
      new Date(Date.now() - 2 * 60_000).toISOString(),
    ).all<{ id: string }>();
    for (const row of rows.results) {
      const state = await stateRow(env, row.id);
      if (state?.status === "SENDING") await processParticipantNotification(env, row.id).catch(() => undefined);
      else await publishOne(env, row.id).catch(() => undefined);
    }
  } catch {
    // A read or queue outage can never replace a committed domain response.
    // The unchanged durable rows are rediscovered by the next cron run.
  }
};

const unsubscribeHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
  "content-type": "text/html; charset=utf-8",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-robots-tag": "noindex, nofollow",
} as const;

export const handleEmailUnsubscribe = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== "/notifications/email/unsubscribe") return null;
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...unsubscribeHeaders, allow: "GET, POST" } });
  }
  const token = url.searchParams.get("token") ?? "";
  const destination = await validUnsubscribeToken(token, env);
  if (request.method === "POST" && destination !== null) {
    await env.DB.prepare(
      `INSERT INTO participant_notification_suppressions
        (channel, destination_hash, reason) VALUES ('EMAIL', ?, 'EMAIL_UNSUBSCRIBE')
       ON CONFLICT(channel, destination_hash) DO UPDATE SET reason = 'EMAIL_UNSUBSCRIBE'`,
    ).bind(destination).run();
  }
  const completed = request.method === "POST";
  const action = `/notifications/email/unsubscribe?token=${encodeURIComponent(token)}`;
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email updates</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:1rem;color:#12333a}button{font:inherit;padding:.8rem 1rem}</style></head><body><main>`
    + (completed
      ? "<h1>Email updates stopped</h1><p>QuickDucks will not send more participant email updates to this address.</p>"
      : `<h1>Stop email updates?</h1><p>This stops QuickDucks participant email updates to this address.</p><form method="post" action="${escapeHtml(action)}"><button type="submit">Stop email updates</button></form>`)
    + "</main></body></html>";
  return new Response(body, { status: 200, headers: unsubscribeHeaders });
};
