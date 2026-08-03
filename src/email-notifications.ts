import type { Env } from "./types.ts";

export const EMAIL_NOTIFICATION_TYPES = [
  "REGISTRATION_CONFIRMED",
  "HEAT_ASSIGNED",
  "FINAL_ASSIGNED",
  "HEAT_UPCOMING",
  "ROUND_RESULT",
] as const;

export type NotificationChannel = "EMAIL" | "SMS";
const sendableStatuses = new Set(["PENDING", "QUEUED", "RETRY_PENDING"]);
const notificationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const textEncoder = new TextEncoder();

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface OutboundSms {
  to: string;
  text: string;
}

export interface EmailSendResult {
  providerMessageId: string | null;
}

export type FinalStateCheck = () => Promise<void>;
export type EmailSender = (
  email: OutboundEmail,
  env: Env,
  finalStateCheck?: FinalStateCheck,
) => Promise<EmailSendResult>;
export type SmsSender = (
  sms: OutboundSms,
  env: Env,
  finalStateCheck?: FinalStateCheck,
) => Promise<EmailSendResult>;

export class EmailSendError extends Error {
  readonly safeCode: string;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(safeCode: string, retryable: boolean, outcomeUnknown = false) {
    super(safeCode);
    this.safeCode = safeCode;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
  }
}

interface NotificationRow {
  id: string;
  event_id: string;
  registration_id: string;
  duck_assignment_id: string | null;
  active_duck_assignment_id: string | null;
  notification_type: string;
  channel: NotificationChannel;
  template_version: number;
  status: string;
  sending_started_at: string | null;
  retry_after: string | null;
  lifecycle_key: string | null;
  heat_run_sequence: number | null;
  result_revision: number | null;
  event_name: string;
  event_status: string;
  event_sms_enabled: number;
  current_heat_run_sequence: number | null;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  email_notifications_enabled: number;
  sms_notifications_enabled: number;
  registration_status: string;
  heat_id: string | null;
  heat_entry_id: string | null;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  earlier_unfinished_heat_count: number;
  visible_number: number | null;
  result_place: number | null;
  current_result_revision: number | null;
  advanced_to_final: number;
}

interface ClaimRow {
  status: string;
  sending_started_at: string | null;
  retry_after: string | null;
  delivery_claim_token: string | null;
}

interface AttemptNumberRow { last_attempt: number }
export type EmailProcessingResult = "SENT" | "CANCELLED" | "FAILED" | "NOOP" | "RETRY";

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

const hmacHex = async (secret: string, purpose: string, value: string): Promise<string> => {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new EmailSendError("NOTIFICATION_HMAC_CONFIGURATION_INVALID", false);
  }
  return hex(await hmac(textEncoder.encode(secret), `${purpose}\0${value}`));
};

const notificationHmacKey = (env: Env): Uint8Array => {
  if (typeof env.NOTIFICATION_DESTINATION_HMAC_KEY !== "string"
    || env.NOTIFICATION_DESTINATION_HMAC_KEY.length < 32) {
    throw new EmailSendError("NOTIFICATION_HMAC_CONFIGURATION_INVALID", false);
  }
  return textEncoder.encode(env.NOTIFICATION_DESTINATION_HMAC_KEY);
};

const base64Url = (value: Uint8Array): string => {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const notificationDestinationHmac = (
  env: Env,
  channel: NotificationChannel,
  destination: string,
): Promise<string> =>
  hmacHex(env.NOTIFICATION_DESTINATION_HMAC_KEY, "destination", `${channel}:${destination.toLowerCase()}`);

const unsubscribeToken = async (env: Env, row: NotificationRow): Promise<string> => {
  const signature = await hmac(
    notificationHmacKey(env),
    `unsubscribe\0${row.id}\0${row.registration_id}`,
  );
  return `${row.id}.${base64Url(signature)}`;
};

const retryDelayMilliseconds = (attempt: number): number =>
  Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, Math.min(attempt - 1, 6)));

const isoAfter = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

type QueuePublishTimerHandle = ReturnType<typeof setTimeout>;

export interface QueuePublishTiming {
  timeoutMilliseconds: number;
  set(callback: () => void, delay: number): QueuePublishTimerHandle;
  clear(handle: QueuePublishTimerHandle): void;
}

const defaultQueuePublishTiming: QueuePublishTiming = {
  timeoutMilliseconds: 10_000,
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (handle) => clearTimeout(handle),
};

// Queue publication has an idempotent durable consumer, so an acknowledgement
// that never arrives may safely become RETRY_PENDING: if the first enqueue did
// land, duplicate transport delivery still claims/sends the outbox row once.
// The deadline is explicitly cleared on every settlement path and unrefed under
// Node, preventing a failed publication from keeping verification or shutdown
// alive. A Worker timer is numeric and simply has no unref method.
export const queuePublicationWithDeadline = <T>(
  operation: Promise<T>,
  timing: QueuePublishTiming = defaultQueuePublishTiming,
): Promise<T> => {
  let timer: QueuePublishTimerHandle | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    const handle = timing.set(
      () => reject(new Error("QUEUE_PUBLISH_DEADLINE_EXCEEDED")),
      timing.timeoutMilliseconds,
    );
    timer = handle;
    const unref = (handle as unknown as { unref?: () => void }).unref;
    if (typeof unref === "function") unref.call(handle);
  });
  return Promise.race([operation, deadline]).finally(() => {
    if (timer !== null) timing.clear(timer);
  });
};

interface AwsRequestInput {
  service: "ses" | "sms-voice";
  method: "GET" | "POST";
  path: string;
  query?: string;
  body?: string;
  env: Env;
  finalStateCheck?: FinalStateCheck;
}

const signedAwsRequest = async ({
  service,
  method,
  path,
  query = "",
  body = "",
  env,
  finalStateCheck,
}: AwsRequestInput): Promise<Response> => {
  const region = env.AWS_REGION;
  if (
    region !== "us-east-1"
    || typeof env.AWS_ACCESS_KEY_ID !== "string" || env.AWS_ACCESS_KEY_ID.length < 16
    || typeof env.AWS_SECRET_ACCESS_KEY !== "string" || env.AWS_SECRET_ACCESS_KEY.length < 32
  ) throw new EmailSendError("AWS_CONFIGURATION_INVALID", false);

  // SES v2 keeps the SigV4 service name `ses` but serves HTTPS from the
  // `email` hostname. Pin the transport host independently from the signing
  // scope so email requests do not target the nonexistent `ses` endpoint.
  const host = `${service === "ses" ? "email" : service}.${region}.amazonaws.com`;
  const payloadHash = hex(await sha256(body));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const contentHeaders = method === "POST" ? "content-type;" : "";
  const signedHeaders = `${contentHeaders}host;x-amz-content-sha256;x-amz-date`;
  const canonicalHeaders = `${method === "POST" ? "content-type:application/json\n" : ""}host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `${method}\n${path}\n${query}\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(textEncoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmac(dateKey, region);
  const serviceKey = await hmac(regionKey, service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  await finalStateCheck?.();

  const headers: Record<string, string> = {
    authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };
  if (method === "POST") headers["content-type"] = "application/json";
  return fetch(`https://${host}${path}${query === "" ? "" : `?${query}`}`, {
    method,
    headers,
    ...(method === "POST" ? { body } : {}),
  });
};

export const sendEmailWithSes: EmailSender = async (email, env, finalStateCheck) => {
  if (env.EMAIL_FROM_ADDRESS !== "race@quickducks.com" || email.from !== env.EMAIL_FROM_ADDRESS) {
    throw new EmailSendError("SES_CONFIGURATION_INVALID", false);
  }
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
  let response: Response;
  try {
    response = await signedAwsRequest({
      service: "ses",
      method: "POST",
      path: "/v2/email/outbound-emails",
      body,
      env,
      finalStateCheck,
    });
  } catch (error) {
    if (error instanceof EmailSendError) throw error;
    // The request may have reached SES before the response was lost. SES has no
    // stable idempotency key for SendEmail, so this outcome must never be retried.
    throw new EmailSendError("DELIVERY_OUTCOME_UNKNOWN", false, true);
  }
  if (!response.ok) {
    if (response.status === 429) throw new EmailSendError("SES_THROTTLED", true);
    if (response.status === 408 || response.status >= 500) {
      throw new EmailSendError("DELIVERY_OUTCOME_UNKNOWN", false, true);
    }
    throw new EmailSendError("SES_REJECTED", false);
  }
  let providerMessageId: string | null = null;
  try {
    const result = await response.json() as { MessageId?: unknown };
    if (typeof result.MessageId === "string" && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.MessageId)) {
      providerMessageId = result.MessageId;
    }
  } catch {
    // Acceptance is authoritative even when its optional identifier is absent.
  }
  return { providerMessageId };
};

const providerSmsOptedOut = async (sms: OutboundSms, env: Env): Promise<boolean> => {
  const list = env.SMS_OPT_OUT_LIST_NAME;
  if (typeof list !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(list)) {
    throw new EmailSendError("SMS_CONFIGURATION_INVALID", false);
  }
  const path = "/v1/sms/opted-out-numbers";
  let nextToken: string | null = null;
  // DescribeOptedOutNumbers is a paginated REST-JSON POST operation. Search the
  // configured list rather than guessing a phone-number query parameter; cap
  // pagination so malformed provider responses cannot hold a queue consumer.
  for (let page = 0; page < 100; page += 1) {
    const body = JSON.stringify({
      MaxResults: 100,
      OptOutListName: list,
      ...(nextToken === null ? {} : { NextToken: nextToken }),
    });
    let response: Response;
    try {
      response = await signedAwsRequest({ service: "sms-voice", method: "POST", path, body, env });
    } catch (error) {
      if (error instanceof EmailSendError) throw error;
      // This check occurs before message submission, so retrying it cannot send
      // a duplicate. Fail closed until provider suppression can be established.
      throw new EmailSendError("SMS_SUPPRESSION_CHECK_UNAVAILABLE", true);
    }
    if (!response.ok) {
      throw new EmailSendError(
        response.status === 429 || response.status === 408 || response.status >= 500
          ? "SMS_SUPPRESSION_CHECK_UNAVAILABLE"
          : "SMS_SUPPRESSION_CHECK_REJECTED",
        response.status === 429 || response.status === 408 || response.status >= 500,
      );
    }
    try {
      const result = await response.json() as { OptedOutNumbers?: unknown; NextToken?: unknown };
      if (!Array.isArray(result.OptedOutNumbers)) {
        throw new EmailSendError("SMS_SUPPRESSION_CHECK_UNAVAILABLE", true);
      }
      if (result.OptedOutNumbers.some((item) => item !== null && typeof item === "object"
        && (item as { OptedOutNumber?: unknown }).OptedOutNumber === sms.to)) return true;
      if (result.NextToken === undefined || result.NextToken === null) return false;
      if (typeof result.NextToken !== "string" || result.NextToken.length < 1 || result.NextToken.length > 2048) {
        throw new EmailSendError("SMS_SUPPRESSION_CHECK_UNAVAILABLE", true);
      }
      nextToken = result.NextToken;
    } catch (error) {
      if (error instanceof EmailSendError) throw error;
      throw new EmailSendError("SMS_SUPPRESSION_CHECK_UNAVAILABLE", true);
    }
  }
  throw new EmailSendError("SMS_SUPPRESSION_CHECK_UNAVAILABLE", true);
};

export const sendSmsWithAws: SmsSender = async (sms, env, finalStateCheck) => {
  if (
    typeof env.SMS_ORIGINATION_IDENTITY !== "string"
    || env.SMS_ORIGINATION_IDENTITY.trim().length === 0
  ) throw new EmailSendError("SMS_CONFIGURATION_INVALID", false);
  if (await providerSmsOptedOut(sms, env)) throw new EmailSendError("SMS_PROVIDER_STOP", false);
  const body = JSON.stringify({
    DestinationPhoneNumber: sms.to,
    OriginationIdentity: env.SMS_ORIGINATION_IDENTITY,
    MessageBody: sms.text,
    MessageType: "TRANSACTIONAL",
  });
  let response: Response;
  try {
    response = await signedAwsRequest({
      service: "sms-voice",
      method: "POST",
      path: "/v1/sms/text",
      body,
      env,
      finalStateCheck,
    });
  } catch (error) {
    if (error instanceof EmailSendError) throw error;
    throw new EmailSendError("DELIVERY_OUTCOME_UNKNOWN", false, true);
  }
  if (!response.ok) {
    if (response.status === 429) throw new EmailSendError("SMS_THROTTLED", true);
    if (response.status === 408 || response.status >= 500) {
      throw new EmailSendError("DELIVERY_OUTCOME_UNKNOWN", false, true);
    }
    throw new EmailSendError("SMS_REJECTED", false);
  }
  let providerMessageId: string | null = null;
  try {
    const result = await response.json() as { MessageId?: unknown };
    if (typeof result.MessageId === "string" && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.MessageId)) {
      providerMessageId = result.MessageId;
    }
  } catch {}
  return { providerMessageId };
};

const notificationRow = (env: Env, notificationId: string): Promise<NotificationRow | null> =>
  env.DB.prepare(
    `SELECT n.id, n.event_id, n.registration_id, n.duck_assignment_id,
            da.id AS active_duck_assignment_id, n.notification_type, n.channel,
            n.template_version, n.status, n.sending_started_at, n.retry_after,
            n.lifecycle_key, n.heat_run_sequence, n.result_revision,
            e.name AS event_name, e.status AS event_status,
            e.sms_notifications_enabled AS event_sms_enabled,
            r.first_name, r.last_name, r.email, r.phone,
            r.email_notifications_enabled, r.sms_notifications_enabled,
            r.status AS registration_status, n.heat_id,
            he.id AS heat_entry_id, h.round AS heat_round,
             h.heat_number, h.status AS heat_status,
             h.notification_run_sequence AS current_heat_run_sequence,
              (SELECT COUNT(*) FROM heats earlier
               WHERE h.id IS NOT NULL AND earlier.event_id = h.event_id
                  AND earlier.status NOT IN ('FINALIZED', 'CANCELLED')
                  AND earlier.round = h.round
                  AND earlier.heat_number < h.heat_number) AS earlier_unfinished_heat_count,
            d.visible_number,
            (SELECT official.place FROM heat_results official
              WHERE official.event_id = n.event_id AND official.heat_id = n.heat_id
                AND official.race_entry_id = re.id AND official.status = 'FINALIZED'
              ORDER BY official.revision DESC LIMIT 1) AS result_place,
            (SELECT MAX(official.revision) FROM heat_results official
              WHERE official.event_id = n.event_id AND official.heat_id = n.heat_id
                AND official.status = 'FINALIZED') AS current_result_revision,
            EXISTS (SELECT 1 FROM heat_entries promoted
              WHERE promoted.event_id = n.event_id AND promoted.race_entry_id = re.id
                AND promoted.round = 'FINAL') AS advanced_to_final
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

const claimRow = (env: Env, notificationId: string): Promise<ClaimRow | null> => env.DB.prepare(
  `SELECT status, sending_started_at, retry_after, delivery_claim_token
     FROM email_notifications WHERE id = ? LIMIT 1`,
).bind(notificationId).first<ClaimRow>();

const destinationFor = (row: NotificationRow): string | null =>
  row.channel === "EMAIL" ? row.email : row.phone === null ? null : `+1${row.phone.replace(/\D/g, "")}`;

const validationFailure = (row: NotificationRow): string | null => {
  if (!(EMAIL_NOTIFICATION_TYPES as readonly string[]).includes(row.notification_type)) return "UNSUPPORTED_TEMPLATE";
  if (row.template_version !== 1 || row.lifecycle_key === null) return "UNSUPPORTED_TEMPLATE";
  if (row.registration_status !== "SUBMITTED" && row.registration_status !== "ACTIVE") {
    return "REGISTRATION_NOT_ACTIVE";
  }
  if (row.channel === "EMAIL") {
    if (row.email_notifications_enabled !== 1 || row.email === null) return "EMAIL_NOT_OPTED_IN";
    if (row.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email)) {
      return "EMAIL_DESTINATION_INVALID";
    }
  } else {
    if (row.event_sms_enabled !== 1) return "SMS_DISABLED_FOR_EVENT";
    if (row.sms_notifications_enabled !== 1 || row.phone === null) return "SMS_NOT_OPTED_IN";
    if (!/^\+1\d{10}$/.test(destinationFor(row) ?? "")) return "SMS_DESTINATION_INVALID";
  }
  if (row.notification_type === "REGISTRATION_CONFIRMED") return null;
  if (
    row.duck_assignment_id === null || row.active_duck_assignment_id === null
    || row.duck_assignment_id !== row.active_duck_assignment_id
    || row.heat_id === null || row.heat_entry_id === null || row.heat_round === null
    || row.heat_number === null || row.visible_number === null
  ) return "RACE_ASSIGNMENT_CHANGED";
  if (row.notification_type === "HEAT_ASSIGNED" || row.notification_type === "FINAL_ASSIGNED") {
    return new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
      ? null : "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  }
  if (row.notification_type === "HEAT_UPCOMING") {
    if (row.heat_run_sequence !== row.current_heat_run_sequence || row.earlier_unfinished_heat_count !== 0) {
      return "HEAT_NO_LONGER_UPCOMING";
    }
    return new Set(["LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
      ? null : "HEAT_NO_LONGER_UPCOMING";
  }
  if (row.notification_type === "ROUND_RESULT") {
    return row.result_revision !== null && row.result_revision === row.current_result_revision
      ? null : "RESULT_REVISION_CHANGED";
  }
  return "UNSUPPORTED_TEMPLATE";
};

const renderMessage = async (row: NotificationRow, env: Env): Promise<{ email?: OutboundEmail; sms?: OutboundSms }> => {
  const eventName = singleLine(row.event_name);
  const participantName = singleLine(`${row.first_name} ${row.last_name}`);
  const raceUrl = new URL("/race", env.APP_ORIGIN).toString();
  const round = row.heat_round === "FINAL" ? "Final" : "Round One";
  const heat = row.heat_number === null ? "" : `${round}, Heat ${row.heat_number}`;
  const duck = row.visible_number === null ? "your duck" : `Duck #${row.visible_number}`;
  let subject: string;
  let action: string;
  if (row.notification_type === "REGISTRATION_CONFIRMED") {
    subject = `Registration confirmed for ${eventName}`;
    action = `Your registration for ${eventName} is confirmed. Race staff will pair you with a duck.`;
  } else if (row.notification_type === "HEAT_ASSIGNED" || row.notification_type === "FINAL_ASSIGNED") {
    subject = `${duck} is assigned to ${heat}`;
    action = `${duck} is assigned to ${heat}. Please stay near the pond and listen for your heat to be called.`;
  } else if (row.notification_type === "HEAT_UPCOMING") {
    subject = `${heat} is about to begin`;
    action = `${heat} is next. Please bring ${duck} to the pond.`;
  } else {
    subject = `${heat} result is official`;
    const result = row.result_place === null
      ? row.advanced_to_final === 1 ? "You advanced to the Final." : "Your heat result is official."
      : row.heat_round === "FINAL"
      ? `You finished in place ${row.result_place}.`
      : "You won your heat and advanced to the Final.";
    action = `${heat} is official. ${result}`;
  }

  if (row.channel === "SMS") {
    return { sms: { to: destinationFor(row)!, text: singleLine(`QuickDucks: ${action} ${raceUrl}`) } };
  }
  const token = await unsubscribeToken(env, row);
  const unsubscribeUrl = new URL(`/email-unsubscribe/${token}`, env.APP_ORIGIN).toString();
  const text = [
    `Hi ${participantName},`,
    "",
    action,
    "",
    `Event: ${eventName}`,
    `Race status: ${raceUrl}`,
    "",
    "Race progress can change, so this message does not promise a start time.",
    `Stop email updates: ${unsubscribeUrl}`,
  ].join("\n");
  const html = `<!doctype html><html lang="en"><body><p>Hi ${escapeHtml(participantName)},</p>`
    + `<p><strong>${escapeHtml(action)}</strong></p>`
    + `<p>Event: ${escapeHtml(eventName)}<br><a href="${escapeHtml(raceUrl)}">View race status</a></p>`
    + "<p>Race progress can change, so this message does not promise a start time.</p>"
    + `<p><a href="${escapeHtml(unsubscribeUrl)}">Stop email updates</a></p></body></html>`;
  return { email: { from: env.EMAIL_FROM_ADDRESS, to: row.email!, subject: singleLine(subject), text, html } };
};

const updateTerminal = async (
  env: Env,
  notificationId: string,
  claimToken: string,
  status: "CANCELLED" | "SUPPRESSED" | "FAILED",
  reason: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = ?
        WHERE id = ? AND notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'`,
    ).bind(now, reason, claimToken, notificationId),
    env.DB.prepare(
      `UPDATE email_notifications SET status = ?, terminal_at = ?, status_reason = ?,
              last_error_code = ?, retry_after = NULL, sending_started_at = NULL,
              delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(status, now, reason, status === "FAILED" ? reason : null, now, notificationId, claimToken),
  ]);
};

const failAmbiguous = async (env: Env, notificationId: string, row: ClaimRow): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts SET status = 'PERMANENT_FAILURE', completed_at = ?,
              error_code = 'DELIVERY_OUTCOME_UNKNOWN'
        WHERE notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'
          AND (id = ? OR ? IS NULL)`,
    ).bind(now, notificationId, row.delivery_claim_token, row.delivery_claim_token),
    env.DB.prepare(
      `UPDATE email_notifications SET status = 'FAILED', terminal_at = ?,
              status_reason = 'DELIVERY_OUTCOME_UNKNOWN',
              last_error_code = 'DELIVERY_OUTCOME_UNKNOWN', retry_after = NULL,
              sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING'
          AND (delivery_claim_token = ? OR (delivery_claim_token IS NULL AND ? IS NULL))`,
    ).bind(now, now, notificationId, row.delivery_claim_token, row.delivery_claim_token),
  ]);
};

const locallySuppressed = async (env: Env, channel: NotificationChannel, digest: string): Promise<boolean> =>
  await env.DB.prepare(
    `SELECT 1 AS suppressed FROM participant_notification_suppressions
      WHERE channel = ? AND destination_hmac = ? LIMIT 1`,
  ).bind(channel, digest).first<{ suppressed: number }>() !== null;

const recordSuppression = (env: Env, channel: NotificationChannel, digest: string, source: string): Promise<unknown> =>
  env.DB.prepare(
    `INSERT INTO participant_notification_suppressions
      (id, channel, destination_hmac, source, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel, destination_hmac) DO NOTHING`,
  ).bind(crypto.randomUUID(), channel, digest, source, new Date().toISOString()).run();

export const processEmailNotification = async (
  env: Env,
  notificationId: string,
  emailSender: EmailSender = sendEmailWithSes,
  queueDeliveryAttempt = 1,
  smsSender: SmsSender = sendSmsWithAws,
): Promise<EmailProcessingResult> => {
  if (!notificationIdPattern.test(notificationId)) return "NOOP";
  const currentClaim = await claimRow(env, notificationId);
  if (currentClaim === null) return "NOOP";
  if (currentClaim.status === "SENDING") {
    const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
    if (currentClaim.sending_started_at !== null && currentClaim.sending_started_at >= staleBefore) return "RETRY";
    await failAmbiguous(env, notificationId, currentClaim);
    return "FAILED";
  }
  if (!sendableStatuses.has(currentClaim.status)) return "NOOP";
  const now = new Date().toISOString();
  if (currentClaim.retry_after !== null && currentClaim.retry_after > now) return "RETRY";

  const lastAttempt = await env.DB.prepare(
    `SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt
       FROM email_attempts WHERE notification_id = ? AND stage = 'DELIVERY'`,
  ).bind(notificationId).first<AttemptNumberRow>();
  const attemptNumber = Number(lastAttempt?.last_attempt ?? 0) + 1;
  const attemptId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_notifications SET status = 'SENDING', sending_started_at = ?,
                delivery_claim_token = ?, updated_at = ?
          WHERE id = ? AND status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')
            AND (scheduled_at IS NULL OR scheduled_at <= ?)
            AND (retry_after IS NULL OR retry_after <= ?)`,
      ).bind(now, attemptId, now, notificationId, now, now),
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

  let row = await notificationRow(env, notificationId);
  if (row === null) {
    await updateTerminal(env, notificationId, attemptId, "CANCELLED", "RACE_ASSIGNMENT_CHANGED");
    return "CANCELLED";
  }
  const invalid = validationFailure(row);
  if (invalid !== null) {
    await updateTerminal(
      env,
      notificationId,
      attemptId,
      invalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED",
      invalid,
    );
    return invalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED";
  }
  const destination = destinationFor(row)!;
  const digest = await notificationDestinationHmac(env, row.channel, destination);
  if (await locallySuppressed(env, row.channel, digest)) {
    await updateTerminal(env, notificationId, attemptId, "SUPPRESSED", "DESTINATION_SUPPRESSED");
    return "CANCELLED";
  }

  const finalStateCheck: FinalStateCheck = async () => {
    const fresh = await notificationRow(env, notificationId);
    if (fresh === null || fresh.channel !== row!.channel || destinationFor(fresh) !== destination) {
      throw new EmailSendError("DESTINATION_CHANGED", false);
    }
    const failure = validationFailure(fresh);
    if (failure !== null) throw new EmailSendError(failure, false);
    if (await locallySuppressed(env, fresh.channel, digest)) {
      throw new EmailSendError("DESTINATION_SUPPRESSED", false);
    }
    row = fresh;
  };

  let result: EmailSendResult;
  try {
    const message = await renderMessage(row, env);
    result = row.channel === "EMAIL"
      ? await emailSender(message.email!, env, finalStateCheck)
      : await smsSender(message.sms!, env, finalStateCheck);
  } catch (error) {
    const failure = error instanceof EmailSendError
      ? error
      : new EmailSendError("DELIVERY_OUTCOME_UNKNOWN", false, true);
    if (failure.safeCode === "SMS_PROVIDER_STOP") {
      await recordSuppression(env, "SMS", digest, "PROVIDER_STOP");
      await updateTerminal(env, notificationId, attemptId, "SUPPRESSED", "SMS_PROVIDER_STOP");
      return "CANCELLED";
    }
    if (failure.outcomeUnknown || failure.safeCode === "DELIVERY_OUTCOME_UNKNOWN") {
      await updateTerminal(env, notificationId, attemptId, "FAILED", "DELIVERY_OUTCOME_UNKNOWN");
      return "FAILED";
    }
    const cancellationCodes = new Set([
      "EMAIL_NOT_OPTED_IN", "SMS_NOT_OPTED_IN", "SMS_DISABLED_FOR_EVENT",
      "EMAIL_DESTINATION_INVALID", "SMS_DESTINATION_INVALID",
      "DESTINATION_CHANGED", "DESTINATION_SUPPRESSED", "REGISTRATION_NOT_ACTIVE",
      "RACE_ASSIGNMENT_CHANGED", "HEAT_NO_LONGER_UPCOMING",
      "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE", "RESULT_REVISION_CHANGED",
    ]);
    if (cancellationCodes.has(failure.safeCode)) {
      await updateTerminal(env, notificationId, attemptId, "CANCELLED", failure.safeCode);
      return "CANCELLED";
    }
    const exhausted = failure.retryable && queueDeliveryAttempt >= 5;
    const retryable = failure.retryable && !exhausted;
    const completedAt = new Date().toISOString();
    const code = exhausted ? "DELIVERY_RETRIES_EXHAUSTED" : failure.safeCode;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts SET status = ?, completed_at = ?, error_code = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(retryable ? "TEMPORARY_FAILURE" : "PERMANENT_FAILURE", completedAt, code, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications SET status = ?, sending_started_at = NULL,
                delivery_claim_token = NULL, terminal_at = ?, last_error_code = ?,
                retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(
        retryable ? "QUEUED" : "FAILED",
        retryable ? null : completedAt,
        code,
        retryable ? isoAfter(retryDelayMilliseconds(queueDeliveryAttempt)) : null,
        completedAt,
        notificationId,
        attemptId,
      ),
    ]);
    return retryable ? "RETRY" : "FAILED";
  }

  const providerMessageId = typeof result.providerMessageId === "string"
      && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.providerMessageId)
    ? result.providerMessageId : null;
  const sentAt = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts SET status = 'SENT', completed_at = ?,
              provider_message_id = ?, error_code = NULL
        WHERE id = ? AND status = 'SENDING'`,
    ).bind(sentAt, providerMessageId, attemptId),
    env.DB.prepare(
      `UPDATE email_notifications SET status = 'SENT', sent_at = ?,
              sending_started_at = NULL, delivery_claim_token = NULL,
              status_reason = ?, last_error_code = NULL, retry_after = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(sentAt, row.channel === "EMAIL" ? "SES_ACCEPTED" : "AWS_SMS_ACCEPTED", sentAt, notificationId, attemptId),
  ]);
  return "SENT";
};

const publishUnsafe = async (
  env: Env,
  notificationId: string,
  timing: QueuePublishTiming = defaultQueuePublishTiming,
): Promise<void> => {
  if (!notificationIdPattern.test(notificationId)) return;
  const now = new Date().toISOString();
  const notification = await env.DB.prepare(
    `SELECT id, event_id, status FROM email_notifications
      WHERE id = ?
        AND ((status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= ?))
          OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?)))
      LIMIT 1`,
  ).bind(notificationId, now, now).first<{ id: string; event_id: string; status: string }>();
  if (notification === null) return;
  const attemptId = crypto.randomUUID();
  const last = await env.DB.prepare(
    `SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt
       FROM email_attempts WHERE notification_id = ? AND stage = 'QUEUE'`,
  ).bind(notificationId).first<AttemptNumberRow>();
  const attemptNumber = Number(last?.last_attempt ?? 0) + 1;
  const startedAt = new Date().toISOString();
  try {
    await queuePublicationWithDeadline(env.EMAIL_QUEUE.send(notificationId), timing);
    const completedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO email_attempts
          (id, event_id, notification_id, attempt_number, stage, status, started_at, completed_at)
         VALUES (?, ?, ?, ?, 'QUEUE', 'QUEUED', ?, ?)`,
      ).bind(attemptId, notification.event_id, notificationId, attemptNumber, startedAt, completedAt),
      env.DB.prepare(
        `UPDATE email_notifications SET status = 'QUEUED', queued_at = COALESCE(queued_at, ?),
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
          `UPDATE email_notifications SET status = 'RETRY_PENDING',
                  last_error_code = 'QUEUE_PUBLISH_FAILED', retry_after = ?, updated_at = ?
            WHERE id = ? AND status IN ('PENDING', 'RETRY_PENDING')`,
        ).bind(isoAfter(retryDelayMilliseconds(attemptNumber)), completedAt, notificationId),
      ]);
    } catch {}
  }
};

export const publishEmailNotification = async (
  env: Env,
  notificationId: string,
  timing: QueuePublishTiming = defaultQueuePublishTiming,
): Promise<void> => {
  try { await publishUnsafe(env, notificationId, timing); } catch {}
};

export const dispatchPendingEmailNotifications = async (
  env: Env,
  timing: QueuePublishTiming = defaultQueuePublishTiming,
): Promise<void> => {
  const now = new Date().toISOString();
  const pending = await env.DB.prepare(
    `SELECT id FROM email_notifications
      WHERE (status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= ?))
         OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?))
      ORDER BY created_at, id LIMIT 100`,
  ).bind(now, now).all<{ id: string }>();
  await Promise.all(pending.results.map((row) => publishEmailNotification(env, row.id, timing)));
};

export const publishPendingParticipantNotifications = async (env: Env): Promise<void> => {
  try { await dispatchPendingEmailNotifications(env); } catch {}
};

export const handleEmailQueue = async (
  batch: MessageBatch<unknown>,
  env: Env,
  emailSender: EmailSender = sendEmailWithSes,
  smsSender: SmsSender = sendSmsWithAws,
): Promise<void> => {
  for (const message of batch.messages) {
    if (typeof message.body !== "string" || !notificationIdPattern.test(message.body)) {
      message.ack();
      continue;
    }
    try {
      const result = await processEmailNotification(env, message.body, emailSender, message.attempts, smsSender);
      if (result === "RETRY") {
        message.retry({ delaySeconds: Math.min(3600, 60 * 2 ** Math.max(0, Math.min(message.attempts - 1, 6))) });
      } else message.ack();
    } catch {
      message.retry({ delaySeconds: Math.min(3600, 60 * 2 ** Math.max(0, Math.min(message.attempts - 1, 6))) });
    }
  }
};

export const unsubscribeEmailNotification = async (
  env: Env,
  token: string,
): Promise<"UNSUBSCRIBED" | "INVALID"> => {
  const match = token.match(/^([A-Za-z0-9_-]{1,128})\.([A-Za-z0-9_-]{43})$/);
  if (match === null) return "INVALID";
  const row = await notificationRow(env, match[1]);
  if (row === null || row.channel !== "EMAIL" || row.email === null) return "INVALID";
  const expected = await unsubscribeToken(env, row);
  if (expected !== token) return "INVALID";
  const digest = await notificationDestinationHmac(env, "EMAIL", row.email);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO participant_notification_suppressions
        (id, channel, destination_hmac, source, created_at)
       VALUES (?, 'EMAIL', ?, 'EMAIL_UNSUBSCRIBE', ?)
       ON CONFLICT(channel, destination_hmac) DO NOTHING`,
    ).bind(crypto.randomUUID(), digest, now),
    env.DB.prepare(
      `UPDATE registrations SET email_notifications_enabled = 0,
              revision = revision + 1, updated_at = ?
        WHERE id = ? AND event_id = ?`,
    ).bind(now, row.registration_id, row.event_id),
    env.DB.prepare(
      `UPDATE email_notifications SET status = 'SUPPRESSED', terminal_at = ?,
              status_reason = 'EMAIL_UNSUBSCRIBED', retry_after = NULL, updated_at = ?
        WHERE registration_id = ? AND channel = 'EMAIL'
          AND status IN ('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING')`,
    ).bind(now, now, row.registration_id),
  ]);
  return "UNSUBSCRIBED";
};
