import {
  EmailSendError,
  sendEmailWithSes,
  type EmailSender,
  type OutboundEmail,
} from "./email-notifications.ts";
import { normalizeUsPhone } from "./registration.ts";
import type { Env } from "./types.ts";

export const PARTICIPANT_NOTIFICATION_TYPES = [
  "REGISTRATION_CONFIRMATION",
  "HEAT_ASSIGNED",
  "FINAL_ASSIGNED",
  "HEAT_UPCOMING",
  "ROUND_ONE_RESULT",
  "FINAL_RESULT",
] as const;

export type ParticipantNotificationChannel = "EMAIL" | "SMS";
export type ParticipantProcessingResult = "SENT" | "CANCELLED" | "FAILED" | "NOOP" | "RETRY";

export interface OutboundSms {
  to: string;
  body: string;
}

export interface ProviderSendResult {
  providerMessageId: string | null;
}

export type SmsSender = (message: OutboundSms, env: Env) => Promise<ProviderSendResult>;
export type ProviderSuppressionChecker = (
  channel: ParticipantNotificationChannel,
  destination: string,
  env: Env,
) => Promise<boolean>;

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
const unsubscribeTokenPattern = /^[0-9a-f]{64}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const textEncoder = new TextEncoder();
const sendableStatuses = new Set(["WAITING_FOR_SYNC", "PENDING", "QUEUED", "RETRY_PENDING"]);
const maxDeliveryAttempts = 5;
const activeSuppressionKeyVersion = (env: Env): number => {
  const version = Number(env.PARTICIPANT_DESTINATION_HMAC_KEY_VERSION ?? "1");
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ParticipantSendError("DESTINATION_HMAC_CONFIGURATION_INVALID", false);
  }
  return version;
};

const isoAfter = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();
const backoffMilliseconds = (attempt: number): number => Math.min(15 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));

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

const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256 = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));

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

const canonicalDestination = (channel: ParticipantNotificationChannel, value: string): string | null => {
  if (channel === "EMAIL") {
    const email = value.trim().toLowerCase();
    return email.length <= 254 && emailPattern.test(email) ? email : null;
  }
  const phone = normalizeUsPhone(value);
  return phone === null ? null : `+1${phone.replace(/\D/g, "")}`;
};

export const destinationHmac = async (
  channel: ParticipantNotificationChannel,
  destination: string,
  env: Env,
): Promise<string> => {
  if (typeof env.PARTICIPANT_DESTINATION_HMAC_KEY !== "string"
    || env.PARTICIPANT_DESTINATION_HMAC_KEY.length < 32) {
    throw new ParticipantSendError("DESTINATION_HMAC_CONFIGURATION_INVALID", false);
  }
  const canonical = canonicalDestination(channel, destination);
  if (canonical === null) throw new ParticipantSendError("CONTACT_INVALID", false);
  const version = activeSuppressionKeyVersion(env);
  return hex(await hmac(
    textEncoder.encode(env.PARTICIPANT_DESTINATION_HMAC_KEY),
    `quickducks-participant-destination:v${version}:${channel}:${canonical}`,
  ));
};

const destinationHashes = async (
  channel: ParticipantNotificationChannel,
  destination: string,
  env: Env,
): Promise<{ version: number; hash: string }[]> => {
  const activeVersion = activeSuppressionKeyVersion(env);
  const hashes = [{ version: activeVersion, hash: await destinationHmac(channel, destination, env) }];
  if (typeof env.PARTICIPANT_DESTINATION_HMAC_PREVIOUS_KEY === "string"
    && env.PARTICIPANT_DESTINATION_HMAC_PREVIOUS_KEY.length >= 32
    && activeVersion > 1) {
    const canonical = canonicalDestination(channel, destination)!;
    hashes.push({
      version: activeVersion - 1,
      hash: hex(await hmac(
        textEncoder.encode(env.PARTICIPANT_DESTINATION_HMAC_PREVIOUS_KEY),
        `quickducks-participant-destination:v${activeVersion - 1}:${channel}:${canonical}`,
      )),
    });
  }
  return hashes;
};

// All identifiers are generated in SQLite so one statement can atomically add
// both independent channels for every selected participant. No contact value is
// copied into the outbox or queue.
const channelRowsSql = `(SELECT 'EMAIL' AS channel UNION ALL SELECT 'SMS' AS channel)`;
const optedInSql = `((channels.channel = 'EMAIL' AND r.email IS NOT NULL AND r.email_notifications_enabled = 1)
  OR (channels.channel = 'SMS' AND r.phone IS NOT NULL AND r.sms_notifications_enabled = 1))`;

export const registrationNotificationStatement = (
  env: Env,
  eventId: string,
  registrationId: string,
  commandId: string,
  now: string,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, notification_type, status, template_version,
     created_by_command_id, scheduled_at, updated_at, channel, lifecycle_key,
     unsubscribe_token)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id,
          'REGISTRATION_CONFIRMATION', CASE WHEN channels.channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'PENDING' END,
          1, ?, ?, ?, channels.channel,
          'REGISTRATION_CONFIRMATION:' || r.id,
          CASE WHEN channels.channel = 'EMAIL' THEN lower(hex(randomblob(32))) END
     FROM registrations r CROSS JOIN ${channelRowsSql} channels
    WHERE r.event_id = ? AND r.id = ? AND ${optedInSql}
   ON CONFLICT DO NOTHING`,
).bind(commandId, now, now, eventId, registrationId);

export const assignmentNotificationStatement = (
  env: Env,
  eventId: string,
  heatId: string,
  registrationId: string,
  commandId: string,
  now: string,
  round: "ROUND_ONE" | "FINAL",
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, status, template_version, created_by_command_id,
     scheduled_at, updated_at, channel, lifecycle_key, unsubscribe_token)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, h.id, da.id,
          ?, CASE WHEN channels.channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'PENDING' END,
          1, ?, ?, ?, channels.channel,
          ? || ':' || h.id || ':' || he.id || ':' || da.id,
          CASE WHEN channels.channel = 'EMAIL' THEN lower(hex(randomblob(32))) END
     FROM registrations r
     JOIN race_entries re ON re.registration_id = r.id AND re.event_id = r.event_id
     JOIN heat_entries he ON he.race_entry_id = re.id AND he.event_id = r.event_id
     JOIN heats h ON h.id = he.heat_id AND h.event_id = r.event_id AND h.round = ?
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = r.event_id AND da.valid_to IS NULL
     CROSS JOIN ${channelRowsSql} channels
    WHERE r.event_id = ? AND r.id = ? AND h.id = ? AND r.status = 'ACTIVE'
      AND ${optedInSql}
   ON CONFLICT DO NOTHING`,
).bind(
  round === "FINAL" ? "FINAL_ASSIGNED" : "HEAT_ASSIGNED",
  commandId,
  now,
  now,
  round === "FINAL" ? "FINAL_ASSIGNED" : "HEAT_ASSIGNED",
  round,
  eventId,
  registrationId,
  heatId,
);

export const assignmentByHeatEntryNotificationStatement = (
  env: Env,
  eventId: string,
  heatEntryId: string,
  commandId: string,
  now: string,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, status, template_version, created_by_command_id,
     scheduled_at, updated_at, channel, lifecycle_key, unsubscribe_token)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, h.id, da.id,
          CASE WHEN h.round = 'FINAL' THEN 'FINAL_ASSIGNED' ELSE 'HEAT_ASSIGNED' END,
          CASE WHEN channels.channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'PENDING' END,
          1, ?, ?, ?, channels.channel,
          (CASE WHEN h.round = 'FINAL' THEN 'FINAL_ASSIGNED' ELSE 'HEAT_ASSIGNED' END)
            || ':' || h.id || ':' || he.id || ':' || da.id,
          CASE WHEN channels.channel = 'EMAIL' THEN lower(hex(randomblob(32))) END
     FROM heat_entries he
     JOIN heats h ON h.id = he.heat_id AND h.event_id = he.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = he.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = he.event_id
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = he.event_id AND da.valid_to IS NULL
     CROSS JOIN ${channelRowsSql} channels
    WHERE he.event_id = ? AND he.id = ? AND r.status = 'ACTIVE' AND ${optedInSql}
   ON CONFLICT DO NOTHING`,
).bind(commandId, now, now, eventId, heatEntryId);

export const heatReminderNotificationStatement = (
  env: Env,
  eventId: string,
  heatId: string,
  commandId: string,
  now: string,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, status, template_version, created_by_command_id,
     scheduled_at, updated_at, channel, lifecycle_key, heat_run_sequence,
     unsubscribe_token)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, h.id, da.id,
          'HEAT_UPCOMING', CASE WHEN channels.channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'PENDING' END,
          1, ?, ?, ?, channels.channel,
          'HEAT_UPCOMING:' || h.id || ':' || h.run_sequence || ':' || ?, h.run_sequence,
          CASE WHEN channels.channel = 'EMAIL' THEN lower(hex(randomblob(32))) END
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = h.event_id AND da.valid_to IS NULL
     CROSS JOIN ${channelRowsSql} channels
    WHERE h.event_id = ? AND h.id = ? AND h.status IN ('LOADING', 'READY', 'CALLING')
      AND r.status = 'ACTIVE' AND ${optedInSql}
   ON CONFLICT DO NOTHING`,
).bind(commandId, now, now, commandId, eventId, heatId);

export const nextHeatReminderNotificationStatement = (
  env: Env,
  eventId: string,
  round: "ROUND_ONE" | "FINAL",
  commandId: string,
  now: string,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, status, template_version, created_by_command_id,
     scheduled_at, updated_at, channel, lifecycle_key, heat_run_sequence,
     unsubscribe_token)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, h.id, da.id,
          'HEAT_UPCOMING', CASE WHEN channels.channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'PENDING' END,
          1, ?, ?, ?, channels.channel,
          'HEAT_UPCOMING:' || h.id || ':' || h.run_sequence || ':' || ?, h.run_sequence,
          CASE WHEN channels.channel = 'EMAIL' THEN lower(hex(randomblob(32))) END
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = h.event_id AND da.valid_to IS NULL
     CROSS JOIN ${channelRowsSql} channels
    WHERE h.event_id = ? AND h.round = ?
      AND h.status IN ('LOADING', 'READY', 'CALLING')
      AND NOT EXISTS (
        SELECT 1 FROM heats earlier
         WHERE earlier.event_id = h.event_id AND earlier.round = h.round
           AND earlier.heat_number < h.heat_number
           AND earlier.status NOT IN ('FINALIZED', 'CANCELLED')
      )
      AND r.status = 'ACTIVE' AND ${optedInSql}
   ON CONFLICT DO NOTHING`,
).bind(commandId, now, now, commandId, eventId, round);

export const heatResultNotificationStatement = (
  env: Env,
  eventId: string,
  heatId: string,
  commandId: string,
  now: string,
  round: "ROUND_ONE" | "FINAL",
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, status, template_version, created_by_command_id,
     scheduled_at, updated_at, channel, lifecycle_key, result_revision,
     unsubscribe_token)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, h.id, da.id,
          ?, CASE WHEN channels.channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'PENDING' END,
          1, ?, ?, ?, channels.channel,
          ? || ':' || h.id || ':' || result_state.result_revision,
          result_state.result_revision,
          CASE WHEN channels.channel = 'EMAIL' THEN lower(hex(randomblob(32))) END
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     LEFT JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = h.event_id AND da.valid_to IS NULL
     JOIN (SELECT MAX(revision) AS result_revision FROM heat_results WHERE heat_id = ?) result_state
     CROSS JOIN ${channelRowsSql} channels
    WHERE h.event_id = ? AND h.id = ? AND h.round = ? AND h.status = 'FINALIZED'
      AND result_state.result_revision IS NOT NULL
      AND r.status = 'ACTIVE' AND ${optedInSql}
   ON CONFLICT DO NOTHING`,
).bind(
  round === "FINAL" ? "FINAL_RESULT" : "ROUND_ONE_RESULT",
  commandId,
  now,
  now,
  round === "FINAL" ? "FINAL_RESULT" : "ROUND_ONE_RESULT",
  heatId,
  eventId,
  heatId,
  round,
);

interface NotificationClaimRow {
  channel: ParticipantNotificationChannel;
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
  status: string;
  event_name: string;
  event_status: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  email_notifications_enabled: number;
  sms_notifications_enabled: number;
  registration_status: string;
  heat_id: string | null;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  current_run_sequence: number | null;
  heat_run_sequence: number | null;
  result_revision: number | null;
  current_result_revision: number | null;
  result_place: number | null;
  active_duck_assignment_id: string | null;
  duck_assignment_id: string | null;
  heat_entry_id: string | null;
  visible_number: number | null;
  earlier_unfinished_count: number;
  other_blocking_count: number;
  unsubscribe_token: string | null;
  destination_hmac: string | null;
  destination_hmac_key_version: number | null;
}

interface AttemptNumberRow { last_attempt: number }

const claimRow = (env: Env, notificationId: string): Promise<NotificationClaimRow | null> => env.DB.prepare(
  `SELECT channel, status, sending_started_at, retry_after, delivery_claim_token
     FROM email_notifications WHERE id = ? LIMIT 1`,
).bind(notificationId).first<NotificationClaimRow>();

const notificationRow = (env: Env, notificationId: string): Promise<NotificationRow | null> => env.DB.prepare(
  `SELECT n.id, n.event_id, n.registration_id, n.channel, n.notification_type,
          n.template_version, n.status, n.heat_id, n.duck_assignment_id,
          n.heat_run_sequence, n.result_revision, n.unsubscribe_token,
          n.destination_hmac, n.destination_hmac_key_version,
          e.name AS event_name, e.status AS event_status,
          r.first_name, r.last_name, r.email, r.phone,
          r.email_notifications_enabled, r.sms_notifications_enabled,
          r.status AS registration_status,
          h.round AS heat_round, h.heat_number, h.status AS heat_status,
          h.run_sequence AS current_run_sequence, he.id AS heat_entry_id,
          da.id AS active_duck_assignment_id, d.visible_number,
          (SELECT MAX(current_result.revision) FROM heat_results current_result
            WHERE current_result.heat_id = n.heat_id AND current_result.status = 'FINALIZED') AS current_result_revision,
          (SELECT current_place.place FROM heat_results current_place
            WHERE current_place.heat_id = n.heat_id
              AND current_place.race_entry_id = re.id
              AND current_place.status = 'FINALIZED'
              AND current_place.revision = n.result_revision
            LIMIT 1) AS result_place,
          (SELECT COUNT(*) FROM heats earlier
            WHERE earlier.event_id = h.event_id AND earlier.round = h.round
              AND earlier.heat_number < h.heat_number
              AND earlier.status NOT IN ('FINALIZED', 'CANCELLED')) AS earlier_unfinished_count,
          (SELECT COUNT(*) FROM heats blocking
            WHERE blocking.event_id = h.event_id AND blocking.id != h.id
              AND blocking.status IN ('RUNNING', 'AWAITING_RESULT')) AS other_blocking_count
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
).bind(notificationId).first<NotificationRow>();

const finishAttempt = async (
  env: Env,
  notificationId: string,
  claimToken: string,
  status: "CANCELLED" | "SUPPRESSED" | "FAILED",
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
          SET status = ?, terminal_at = ?, status_reason = ?, last_error_code = NULL,
              retry_after = NULL, sending_started_at = NULL,
              delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(status, now, reason, now, notificationId, claimToken),
  ]);
};

const failAmbiguousDelivery = async (
  env: Env,
  notificationId: string,
  sendingStartedAt: string | null,
  claimToken: string | null,
): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE email_attempts SET status = 'PERMANENT_FAILURE', completed_at = ?,
              error_code = 'DELIVERY_OUTCOME_UNKNOWN'
        WHERE notification_id = ? AND stage = 'DELIVERY' AND status = 'SENDING'
          AND (id = ? OR ? IS NULL)`,
    ).bind(now, notificationId, claimToken, claimToken),
    env.DB.prepare(
      `UPDATE email_notifications
          SET status = 'FAILED', terminal_at = ?, status_reason = 'DELIVERY_OUTCOME_UNKNOWN',
              last_error_code = 'DELIVERY_OUTCOME_UNKNOWN', retry_after = NULL,
              sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING'
          AND (sending_started_at = ? OR (sending_started_at IS NULL AND ? IS NULL))
          AND (delivery_claim_token = ? OR (delivery_claim_token IS NULL AND ? IS NULL))`,
    ).bind(now, now, notificationId, sendingStartedAt, sendingStartedAt, claimToken, claimToken),
  ]);
};

const destinationFor = (row: NotificationRow): string | null => {
  if (row.channel === "EMAIL") {
    if (row.email_notifications_enabled !== 1 || row.email === null) return null;
    return canonicalDestination("EMAIL", row.email);
  }
  if (row.sms_notifications_enabled !== 1 || row.phone === null) return null;
  return canonicalDestination("SMS", row.phone);
};

const validationFailure = (row: NotificationRow): string | null => {
  if (!(PARTICIPANT_NOTIFICATION_TYPES as readonly string[]).includes(row.notification_type)) {
    return "UNSUPPORTED_TEMPLATE";
  }
  if (row.template_version !== 1) return "UNSUPPORTED_TEMPLATE";
  if (destinationFor(row) === null) return row.channel === "EMAIL" ? "EMAIL_NOT_OPTED_IN" : "SMS_NOT_OPTED_IN";
  if (!new Set(["SUBMITTED", "ACTIVE"]).has(row.registration_status)) return "REGISTRATION_NOT_ACTIVE";
  if (row.notification_type === "REGISTRATION_CONFIRMATION") {
    return new Set(["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL"]).has(row.event_status)
      ? null
      : "EVENT_NO_LONGER_ACTIVE";
  }
  if (
    row.duck_assignment_id === null
    || row.active_duck_assignment_id === null
    || row.duck_assignment_id !== row.active_duck_assignment_id
    || row.heat_id === null
    || row.heat_entry_id === null
    || row.heat_round === null
    || row.heat_number === null
    || row.visible_number === null
  ) return "RACE_ASSIGNMENT_CHANGED";
  if (!new Set(["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED"]).has(row.event_status)) {
    return "EVENT_NO_LONGER_ACTIVE";
  }
  if (row.notification_type === "HEAT_ASSIGNED" && row.heat_round !== "ROUND_ONE") return "RACE_ASSIGNMENT_CHANGED";
  if (row.notification_type === "FINAL_ASSIGNED" && row.heat_round !== "FINAL") return "RACE_ASSIGNMENT_CHANGED";
  if (
    (row.notification_type === "HEAT_ASSIGNED" || row.notification_type === "FINAL_ASSIGNED")
    && !new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
  ) return "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  if (row.notification_type === "HEAT_UPCOMING") {
    if (
      !new Set(["LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")
      || row.heat_run_sequence === null
      || row.heat_run_sequence !== row.current_run_sequence
      || Number(row.earlier_unfinished_count) !== 0
      || Number(row.other_blocking_count) !== 0
    ) return "HEAT_NO_LONGER_UPCOMING";
  }
  if (row.notification_type.endsWith("_RESULT")) {
    if (
      row.heat_status !== "FINALIZED"
      || row.result_revision === null
      || Number(row.current_result_revision) !== row.result_revision
    ) return "RESULT_SUPERSEDED";
  }
  return null;
};

const roundLabel = (row: NotificationRow): string => row.heat_round === "FINAL" ? "Final" : "Round One";
const duckLabel = (row: NotificationRow): string => `Duck #${row.visible_number}`;

const actionText = (row: NotificationRow): { subject: string; action: string } => {
  const round = roundLabel(row);
  const heat = `${round}, Heat ${row.heat_number}`;
  const duck = duckLabel(row);
  switch (row.notification_type) {
    case "REGISTRATION_CONFIRMATION":
      return {
        subject: `Registration confirmed for ${singleLine(row.event_name)}`,
        action: "Your race registration is confirmed. We will send only the updates you chose.",
      };
    case "HEAT_ASSIGNED":
    case "FINAL_ASSIGNED":
      return { subject: `${duck} is assigned to ${heat}`, action: `${duck} is assigned to ${heat}. Please stay near the pond.` };
    case "HEAT_UPCOMING":
      return { subject: `${heat} is next`, action: `${heat} is next. Please bring ${duck} to the pond.` };
    case "ROUND_ONE_RESULT":
      return row.result_place === 1
        ? { subject: `${duck} advanced to the Final`, action: `${duck} won ${heat} and advanced to the Final.` }
        : { subject: `Official result for ${heat}`, action: `The official result for ${heat} is available. ${duck} did not advance.` };
    case "FINAL_RESULT":
      return row.result_place === null
        ? { subject: "The Final result is official", action: `The Final result is official. ${duck} did not place in the top three.` }
        : { subject: `${duck} placed ${row.result_place} in the Final`, action: `${duck} placed ${row.result_place} in the Final.` };
    default:
      return { subject: "QuickDucks race update", action: "A race update is available." };
  }
};

const renderEmail = (row: NotificationRow, env: Env): OutboundEmail => {
  const participantName = singleLine(`${row.first_name} ${row.last_name}`);
  const eventName = singleLine(row.event_name);
  const { subject, action } = actionText(row);
  const raceUrl = new URL("/race", env.APP_ORIGIN).toString();
  const unsubscribeUrl = row.unsubscribe_token === null
    ? null
    : new URL(`/notifications/unsubscribe/${row.unsubscribe_token}`, env.APP_ORIGIN).toString();
  const preference = unsubscribeUrl === null
    ? "You can turn off email updates from My Ducks on the device used to register."
    : `Unsubscribe from participant email updates: ${unsubscribeUrl}`;
  const text = [
    `Hi ${participantName},`,
    "",
    action,
    "",
    `Event: ${eventName}`,
    `Race status: ${raceUrl}`,
    "",
    "Race progress can change, so reminders do not promise a start time.",
    preference,
  ].join("\n");
  const htmlPreference = unsubscribeUrl === null
    ? "<p>You can turn off email updates from My Ducks on the device used to register.</p>"
    : `<p><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe from participant email updates</a></p>`;
  return {
    from: env.EMAIL_FROM_ADDRESS,
    to: destinationFor(row)!,
    subject: singleLine(subject),
    text,
    html: `<!doctype html><html lang="en"><body><p>Hi ${escapeHtml(participantName)},</p>`
      + `<p><strong>${escapeHtml(action)}</strong></p>`
      + `<p>Event: ${escapeHtml(eventName)}<br><a href="${escapeHtml(raceUrl)}">View race status</a></p>`
      + "<p>Race progress can change, so reminders do not promise a start time.</p>"
      + `${htmlPreference}</body></html>`,
  };
};

const renderSms = (row: NotificationRow): OutboundSms => {
  const { action } = actionText(row);
  return { to: destinationFor(row)!, body: `QuickDucks: ${singleLine(action)} Reply STOP to opt out.` };
};

interface AwsRequestOptions {
  service: string;
  host: string;
  path: string;
  method: "GET" | "POST";
  body?: string;
}

const signedAwsFetch = async (env: Env, options: AwsRequestOptions): Promise<Response> => {
  if (
    env.AWS_REGION !== "us-east-1"
    || typeof env.AWS_ACCESS_KEY_ID !== "string" || env.AWS_ACCESS_KEY_ID.length < 16
    || typeof env.AWS_SECRET_ACCESS_KEY !== "string" || env.AWS_SECRET_ACCESS_KEY.length < 32
  ) throw new ParticipantSendError("AWS_CONFIGURATION_INVALID", false);
  const body = options.body ?? "";
  const payloadHash = hex(await sha256(body));
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const contentHeader = options.method === "POST" ? "content-type:application/json\n" : "";
  const signedHeaders = options.method === "POST"
    ? "content-type;host;x-amz-content-sha256;x-amz-date"
    : "host;x-amz-content-sha256;x-amz-date";
  const canonicalHeaders = `${contentHeader}host:${options.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `${options.method}\n${options.path}\n\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${env.AWS_REGION}/${options.service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(textEncoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmac(dateKey, env.AWS_REGION);
  const serviceKey = await hmac(regionKey, options.service);
  const signingKey = await hmac(serviceKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));
  try {
    return await fetch(`https://${options.host}${options.path}`, {
      method: options.method,
      headers: {
        authorization: `AWS4-HMAC-SHA256 Credential=${env.AWS_ACCESS_KEY_ID}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        ...(options.method === "POST" ? { "content-type": "application/json" } : {}),
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
      },
      ...(options.method === "POST" ? { body } : {}),
    });
  } catch {
    throw new ParticipantSendError("AWS_NETWORK_ERROR", true);
  }
};

export const sendSmsWithAws: SmsSender = async (message, env) => {
  if (typeof env.SMS_ORIGINATION_IDENTITY !== "string" || env.SMS_ORIGINATION_IDENTITY.trim() === "") {
    throw new ParticipantSendError("SMS_CONFIGURATION_INVALID", false);
  }
  const body = JSON.stringify({
    DestinationPhoneNumber: message.to,
    MessageBody: message.body,
    MessageType: "TRANSACTIONAL",
    OriginationIdentity: env.SMS_ORIGINATION_IDENTITY,
  });
  const response = await signedAwsFetch(env, {
    service: "sms-voice",
    host: `sms-voice.${env.AWS_REGION}.amazonaws.com`,
    path: "/v2/sms/text",
    method: "POST",
    body,
  });
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new ParticipantSendError(retryable ? "SMS_TEMPORARY_FAILURE" : "SMS_REJECTED", retryable);
  }
  let providerMessageId: string | null = null;
  try {
    const result = await response.json() as { MessageId?: unknown };
    if (typeof result.MessageId === "string" && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.MessageId)) {
      providerMessageId = result.MessageId;
    }
  } catch {
    // Provider acceptance is authoritative even when its optional ID is absent.
  }
  return { providerMessageId };
};

export const checkAwsProviderSuppression: ProviderSuppressionChecker = async (channel, destination, env) => {
  if (channel === "EMAIL") {
    const path = `/v2/email/suppression/addresses/${encodeURIComponent(destination)}`;
    const response = await signedAwsFetch(env, {
      service: "ses",
      host: `email.${env.AWS_REGION}.amazonaws.com`,
      path,
      method: "GET",
    });
    if (response.status === 404) return false;
    if (response.ok) return true;
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new ParticipantSendError(
      retryable ? "SES_SUPPRESSION_CHECK_TEMPORARY_FAILURE" : "SES_SUPPRESSION_CHECK_FAILED",
      retryable,
    );
  }
  const response = await signedAwsFetch(env, {
    service: "sms-voice",
    host: `sms-voice.${env.AWS_REGION}.amazonaws.com`,
    path: "/v2/phone-numbers/opt-out",
    method: "POST",
    body: JSON.stringify({ PhoneNumber: destination }),
  });
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new ParticipantSendError(
      retryable ? "SMS_OPTOUT_CHECK_TEMPORARY_FAILURE" : "SMS_OPTOUT_CHECK_FAILED",
      retryable,
    );
  }
  try {
    const result = await response.json() as { IsOptedOut?: unknown };
    if (typeof result.IsOptedOut === "boolean") return result.IsOptedOut;
  } catch {
    // A malformed success cannot be treated as permission to send.
  }
  throw new ParticipantSendError("SMS_OPTOUT_CHECK_FAILED", true);
};

const recordSuppression = async (
  env: Env,
  channel: ParticipantNotificationChannel,
  destinationHash: string,
  reason: "EMAIL_UNSUBSCRIBE" | "PROVIDER_SUPPRESSION" | "SMS_STOP",
): Promise<void> => {
  await env.DB.prepare(
    `INSERT INTO participant_notification_suppressions
      (id, channel, key_version, destination_hmac, reason_code)
     VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
  ).bind(crypto.randomUUID(), channel, activeSuppressionKeyVersion(env), destinationHash, reason).run();
};

const locallySuppressed = async (
  env: Env,
  channel: ParticipantNotificationChannel,
  hashes: readonly { version: number; hash: string }[],
): Promise<boolean> => {
  for (const candidate of hashes) {
    const row = await env.DB.prepare(
      `SELECT 1 AS suppressed FROM participant_notification_suppressions
        WHERE channel = ? AND key_version = ? AND destination_hmac = ? LIMIT 1`,
    ).bind(channel, candidate.version, candidate.hash).first<{ suppressed: number }>();
    if (row !== null) return true;
  }
  return false;
};

export const processParticipantNotification = async (
  env: Env,
  notificationId: string,
  emailSender: EmailSender = sendEmailWithSes,
  smsSender: SmsSender = sendSmsWithAws,
  suppressionChecker: ProviderSuppressionChecker = checkAwsProviderSuppression,
): Promise<ParticipantProcessingResult> => {
  if (!notificationIdPattern.test(notificationId)) return "NOOP";
  const initial = await claimRow(env, notificationId);
  if (initial === null) return "NOOP";
  const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  if (initial.status === "SENDING") {
    if (initial.sending_started_at !== null && initial.sending_started_at >= staleBefore) return "RETRY";
    await failAmbiguousDelivery(env, notificationId, initial.sending_started_at, initial.delivery_claim_token);
    return "FAILED";
  }
  if (!sendableStatuses.has(initial.status)) return "NOOP";
  const now = new Date().toISOString();
  if (initial.retry_after !== null && initial.retry_after > now) return "RETRY";
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
          WHERE id = ? AND status IN ('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING')
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

  let row: NotificationRow | null;
  try {
    row = await notificationRow(env, notificationId);
  } catch {
    const retryAt = isoAfter(backoffMilliseconds(attemptNumber));
    const failedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts SET status = 'TEMPORARY_FAILURE', completed_at = ?,
                error_code = 'AUTHORITATIVE_RELOAD_FAILED'
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(failedAt, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = CASE WHEN channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'RETRY_PENDING' END,
                sending_started_at = NULL, delivery_claim_token = NULL,
                last_error_code = 'AUTHORITATIVE_RELOAD_FAILED', retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(retryAt, failedAt, notificationId, attemptId),
    ]);
    return "RETRY";
  }
  if (row === null) {
    await finishAttempt(env, notificationId, attemptId, "CANCELLED", "RACE_ASSIGNMENT_CHANGED");
    return "CANCELLED";
  }
  const invalid = validationFailure(row);
  if (invalid === "UNSUPPORTED_TEMPLATE") {
    await finishAttempt(env, notificationId, attemptId, "FAILED", invalid);
    return "FAILED";
  }
  if (invalid !== null) {
    await finishAttempt(env, notificationId, attemptId, "CANCELLED", invalid);
    return "CANCELLED";
  }
  const destination = destinationFor(row)!;
  let destinationHash: string;
  try {
    const hashes = await destinationHashes(row.channel, destination, env);
    destinationHash = hashes[0].hash;
    if (await locallySuppressed(env, row.channel, hashes)) {
      await finishAttempt(env, notificationId, attemptId, "SUPPRESSED", "DESTINATION_SUPPRESSED");
      return "CANCELLED";
    }
    if (await suppressionChecker(row.channel, destination, env)) {
      await recordSuppression(
        env,
        row.channel,
        destinationHash,
        row.channel === "SMS" ? "SMS_STOP" : "PROVIDER_SUPPRESSION",
      );
      await finishAttempt(env, notificationId, attemptId, "SUPPRESSED", "PROVIDER_SUPPRESSED");
      return "CANCELLED";
    }
  } catch (error) {
    const failure = error instanceof ParticipantSendError
      ? error
      : new ParticipantSendError("SUPPRESSION_CHECK_FAILURE", true);
    const completedAt = new Date().toISOString();
    const exhausted = !failure.retryable || attemptNumber >= maxDeliveryAttempts;
    const code = failure.retryable && exhausted ? "DELIVERY_RETRIES_EXHAUSTED" : failure.safeCode;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts SET status = ?, completed_at = ?, error_code = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(exhausted ? "PERMANENT_FAILURE" : "TEMPORARY_FAILURE", completedAt, code, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications SET status = ?, sending_started_at = NULL,
                delivery_claim_token = NULL, terminal_at = ?, last_error_code = ?,
                retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(
        exhausted ? "FAILED" : row.channel === "SMS" ? "WAITING_FOR_SYNC" : "RETRY_PENDING",
        exhausted ? completedAt : null,
        code,
        exhausted ? null : isoAfter(backoffMilliseconds(attemptNumber)),
        completedAt,
        notificationId,
        attemptId,
      ),
    ]);
    return exhausted ? "FAILED" : "RETRY";
  }

  // Provider suppression lookups can take longer than a D1 read. Reload once
  // more after them so a consent withdrawal, unsubscribe, STOP mirror, cleared
  // contact, or assignment/lifecycle change that committed during that lookup
  // still wins before the provider call.
  let latest: NotificationRow | null;
  let latestReadFailed = false;
  try {
    latest = await notificationRow(env, notificationId);
  } catch {
    latest = null;
    latestReadFailed = true;
  }
  if (latestReadFailed) {
    const retryAt = isoAfter(backoffMilliseconds(attemptNumber));
    const failedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts SET status = 'TEMPORARY_FAILURE', completed_at = ?,
                error_code = 'FINAL_STATE_RECHECK_FAILED'
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(failedAt, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = CASE WHEN channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'RETRY_PENDING' END,
                sending_started_at = NULL, delivery_claim_token = NULL,
                last_error_code = 'FINAL_STATE_RECHECK_FAILED', retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(retryAt, failedAt, notificationId, attemptId),
    ]);
    return "RETRY";
  }
  if (latest === null) {
    await finishAttempt(env, notificationId, attemptId, "CANCELLED", "AUTHORITATIVE_STATE_CHANGED");
    return "CANCELLED";
  }
  const latestInvalid = validationFailure(latest);
  if (latestInvalid !== null) {
    await finishAttempt(
      env,
      notificationId,
      attemptId,
      latestInvalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED",
      latestInvalid,
    );
    return latestInvalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED";
  }
  const latestDestination = destinationFor(latest)!;
  const latestHashes = await destinationHashes(latest.channel, latestDestination, env);
  if (await locallySuppressed(env, latest.channel, latestHashes)) {
    await finishAttempt(env, notificationId, attemptId, "SUPPRESSED", "DESTINATION_SUPPRESSED");
    return "CANCELLED";
  }
  if (latest.channel !== row.channel || latestDestination !== destination) {
    const retryAt = isoAfter(60_000);
    const changedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts SET status = 'TEMPORARY_FAILURE', completed_at = ?,
                error_code = 'CONTACT_CHANGED_DURING_DELIVERY'
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(changedAt, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = CASE WHEN channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'RETRY_PENDING' END,
                sending_started_at = NULL, delivery_claim_token = NULL,
                last_error_code = 'CONTACT_CHANGED_DURING_DELIVERY', retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(retryAt, changedAt, notificationId, attemptId),
    ]);
    return "RETRY";
  }
  row = latest;
  const activeHash = latestHashes.find(
    (candidate) => candidate.version === activeSuppressionKeyVersion(env),
  );
  if (activeHash === undefined) {
    await finishAttempt(env, notificationId, attemptId, "FAILED", "DESTINATION_HMAC_CONFIGURATION_INVALID");
    return "FAILED";
  }
  try {
    const persisted = await env.DB.prepare(
      `UPDATE email_notifications SET destination_hmac = ?,
              destination_hmac_key_version = ?, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(activeHash.hash, activeHash.version, new Date().toISOString(), notificationId, attemptId).run();
    if ((persisted.meta?.changes ?? 0) !== 1) return "RETRY";
  } catch {
    const failedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts SET status = 'TEMPORARY_FAILURE', completed_at = ?,
                error_code = 'DESTINATION_HMAC_PERSIST_FAILED'
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(failedAt, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = CASE WHEN channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'RETRY_PENDING' END,
                sending_started_at = NULL, delivery_claim_token = NULL,
                last_error_code = 'DESTINATION_HMAC_PERSIST_FAILED', retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(isoAfter(backoffMilliseconds(attemptNumber)), failedAt, notificationId, attemptId),
    ]);
    return "RETRY";
  }

  let result: ProviderSendResult;
  try {
    result = row.channel === "EMAIL"
      ? await emailSender(renderEmail(row, env), env)
      : await smsSender(renderSms(row), env);
  } catch (error) {
    const failure = error instanceof EmailSendError || error instanceof ParticipantSendError
      ? error
      : new ParticipantSendError("PROVIDER_SENDER_FAILURE", true);
    const completedAt = new Date().toISOString();
    const exhausted = !failure.retryable || attemptNumber >= maxDeliveryAttempts;
    const code = failure.retryable && exhausted ? "DELIVERY_RETRIES_EXHAUSTED" : failure.safeCode;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts SET status = ?, completed_at = ?, error_code = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(exhausted ? "PERMANENT_FAILURE" : "TEMPORARY_FAILURE", completedAt, code, attemptId),
      env.DB.prepare(
        `UPDATE email_notifications SET status = ?, sending_started_at = NULL,
                delivery_claim_token = NULL, terminal_at = ?, last_error_code = ?,
                retry_after = ?, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(
        exhausted ? "FAILED" : row.channel === "SMS" ? "WAITING_FOR_SYNC" : "RETRY_PENDING",
        exhausted ? completedAt : null,
        code,
        exhausted ? null : isoAfter(backoffMilliseconds(attemptNumber)),
        completedAt,
        notificationId,
        attemptId,
      ),
    ]);
    return exhausted ? "FAILED" : "RETRY";
  }

  const providerMessageId = typeof result.providerMessageId === "string"
      && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(result.providerMessageId)
    ? result.providerMessageId
    : null;
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

interface PublishRow {
  id: string;
  event_id: string;
  channel: ParticipantNotificationChannel;
  status: string;
  retry_after: string | null;
  updated_at: string;
}

const publishOne = async (env: Env, notificationId: string): Promise<void> => {
  if (!notificationIdPattern.test(notificationId)) return;
  const row = await env.DB.prepare(
    `SELECT id, event_id, channel, status, retry_after, updated_at
       FROM email_notifications WHERE id = ? LIMIT 1`,
  ).bind(notificationId).first<PublishRow>();
  if (row === null) return;
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  if (row.status === "RETRY_PENDING" && row.retry_after !== null && row.retry_after > now) return;
  if (row.status === "QUEUED" && row.updated_at > staleBefore) return;
  if (!new Set(["WAITING_FOR_SYNC", "PENDING", "RETRY_PENDING", "QUEUED"]).has(row.status)) return;

  const lease = await env.DB.prepare(
    `UPDATE email_notifications SET status = 'QUEUED', updated_at = ?
      WHERE id = ? AND status = ? AND updated_at = ?
        AND (status NOT IN ('WAITING_FOR_SYNC', 'RETRY_PENDING') OR retry_after IS NULL OR retry_after <= ?)
        AND (status != 'QUEUED' OR updated_at <= ?)`,
  ).bind(now, row.id, row.status, row.updated_at, now, staleBefore).run();
  if ((lease.meta?.changes ?? 0) === 0) return;

  const lastAttempt = await env.DB.prepare(
    `SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt
       FROM email_attempts WHERE notification_id = ? AND stage = 'QUEUE'`,
  ).bind(notificationId).first<AttemptNumberRow>();
  const attemptNumber = Number(lastAttempt?.last_attempt ?? 0) + 1;
  const attemptId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  try {
    const queue = row.channel === "EMAIL" ? env.EMAIL_QUEUE : env.SMS_QUEUE;
    await queue.send(notificationId);
    const completedAt = new Date().toISOString();
    await env.DB.prepare(
      `INSERT INTO email_attempts
        (id, event_id, notification_id, attempt_number, stage, status, started_at, completed_at)
       VALUES (?, ?, ?, ?, 'QUEUE', 'QUEUED', ?, ?)`,
    ).bind(attemptId, row.event_id, notificationId, attemptNumber, startedAt, completedAt).run();
  } catch {
    const completedAt = new Date().toISOString();
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO email_attempts
            (id, event_id, notification_id, attempt_number, stage, status,
             started_at, completed_at, error_code)
           VALUES (?, ?, ?, ?, 'QUEUE', 'TEMPORARY_FAILURE', ?, ?, 'QUEUE_PUBLISH_FAILED')`,
        ).bind(attemptId, row.event_id, notificationId, attemptNumber, startedAt, completedAt),
        env.DB.prepare(
          `UPDATE email_notifications SET status = CASE WHEN channel = 'SMS' THEN 'WAITING_FOR_SYNC' ELSE 'RETRY_PENDING' END,
                  last_error_code = 'QUEUE_PUBLISH_FAILED', retry_after = ?, updated_at = ?
            WHERE id = ? AND status = 'QUEUED' AND updated_at = ?`,
        ).bind(isoAfter(backoffMilliseconds(attemptNumber)), completedAt, notificationId, now),
      ]);
    } catch {
      // A stale QUEUED lease is rediscovered by cron. Never fail a domain write.
    }
  }
};

export const publishParticipantNotification = async (env: Env, notificationId: string): Promise<void> => {
  try {
    await publishOne(env, notificationId);
  } catch {
    // Publication is always best effort after the atomic domain batch commits.
  }
};

export const publishPendingParticipantNotifications = async (env: Env): Promise<void> => {
  try {
    const now = new Date().toISOString();
    const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
    const pending = await env.DB.prepare(
      `SELECT id FROM email_notifications
        WHERE (status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= ?))
           OR (status = 'WAITING_FOR_SYNC' AND (retry_after IS NULL OR retry_after <= ?))
           OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?))
           OR (status = 'QUEUED' AND updated_at <= ?)
        ORDER BY created_at, id LIMIT 100`,
    ).bind(now, now, now, staleBefore).all<{ id: string }>();
    // Sequential publication deliberately bounds pressure on D1 and Queue.
    for (const row of pending.results) await publishParticipantNotification(env, row.id);
  } catch {
    // The cron or the next committed mutation will retry the durable rows.
  }
};

export const handleParticipantNotificationQueue = async (
  batch: MessageBatch<unknown>,
  env: Env,
  emailSender: EmailSender = sendEmailWithSes,
  smsSender: SmsSender = sendSmsWithAws,
  suppressionChecker: ProviderSuppressionChecker = checkAwsProviderSuppression,
): Promise<void> => {
  for (const message of batch.messages) {
    if (typeof message.body !== "string" || !notificationIdPattern.test(message.body)) {
      message.ack();
      continue;
    }
    try {
      const result = await processParticipantNotification(
        env,
        message.body,
        emailSender,
        smsSender,
        suppressionChecker,
      );
      if (result === "RETRY") message.retry({ delaySeconds: 60 });
      else message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
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

const unsubscribePage = (token: string, completed: boolean): Response => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Email updates</title><style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;line-height:1.5}button{font:inherit;padding:.75rem 1rem}</style></head><body><main>`
    + (completed
      ? "<h1>Email updates stopped</h1><p>This address will not receive more QuickDucks participant email updates. SMS preferences were not changed.</p>"
      : `<h1>Stop participant email updates?</h1><p>This stops future QuickDucks participant emails to this address.</p><form method="post" action="/notifications/unsubscribe/${token}"><button type="submit">Stop email updates</button></form>`)
    + "</main></body></html>",
  { status: 200, headers: unsubscribeHeaders },
);

export const handleEmailUnsubscribe = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/notifications\/unsubscribe\/([0-9a-f]{64})$/);
  if (match === null) return null;
  const token = match[1];
  if (!unsubscribeTokenPattern.test(token)) return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare(
    `SELECT n.registration_id, n.destination_hmac, n.destination_hmac_key_version, r.email
       FROM email_notifications n
       JOIN registrations r ON r.id = n.registration_id AND r.event_id = n.event_id
      WHERE n.unsubscribe_token = ? AND n.channel = 'EMAIL' LIMIT 1`,
  ).bind(token).first<{
    registration_id: string;
    destination_hmac: string | null;
    destination_hmac_key_version: number | null;
    email: string | null;
  }>();
  if (row === null || (row.destination_hmac === null && row.email === null)) {
    return new Response("Not found", { status: 404, headers: unsubscribeHeaders });
  }
  if (request.method === "GET") return unsubscribePage(token, false);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  const destinationHash = row.destination_hmac ?? await destinationHmac("EMAIL", row.email!, env);
  const destinationKeyVersion = row.destination_hmac_key_version ?? activeSuppressionKeyVersion(env);
  const currentDestinationHash = row.email === null ? null : await destinationHmac("EMAIL", row.email, env);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO participant_notification_suppressions
        (id, channel, key_version, destination_hmac, reason_code, created_at)
       VALUES (?, 'EMAIL', ?, ?, 'EMAIL_UNSUBSCRIBE', ?)
       ON CONFLICT DO NOTHING`,
    ).bind(crypto.randomUUID(), destinationKeyVersion, destinationHash, now),
    env.DB.prepare(
      `UPDATE email_notifications SET status = 'SUPPRESSED', terminal_at = ?,
              status_reason = 'EMAIL_UNSUBSCRIBE', retry_after = NULL, updated_at = ?
        WHERE registration_id = ? AND channel = 'EMAIL'
          AND status IN ('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING')
          AND (destination_hmac = ? OR (destination_hmac IS NULL AND ? = ?))`,
    ).bind(now, now, row.registration_id, destinationHash, destinationHash, currentDestinationHash),
  ]);
  return unsubscribePage(token, true);
};
