import {
  checkEmailSuppressedWithSes,
  EmailSendError,
  sendEmailWithSes,
  type EmailSender,
  type EmailSuppressionChecker,
  type OutboundEmail,
} from "./email-notifications.ts";
import { normalizeUsPhone } from "./registration.ts";
import { unsubscribeUrlFor } from "./notification-unsubscribe.ts";
import type { Env } from "./types.ts";

export const PARTICIPANT_NOTIFICATION_TYPES = [
  "REGISTRATION_CONFIRMED",
  "ROUND_ONE_ASSIGNED",
  "FINAL_ASSIGNED",
  "HEAT_UPCOMING",
  "ROUND_RESULT",
  "FINAL_RESULT",
] as const;

export type ParticipantNotificationType = typeof PARTICIPANT_NOTIFICATION_TYPES[number];
export type NotificationChannel = "EMAIL" | "SMS";

const notificationIdPattern = /^[A-Za-z0-9_-]{1,128}$/;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const encoder = new TextEncoder();

const channelCondition = (channel: NotificationChannel, registrationAlias = "r"): string => channel === "EMAIL"
  ? `${registrationAlias}.email IS NOT NULL AND ${registrationAlias}.email_notifications_enabled = 1`
  : `${registrationAlias}.phone IS NOT NULL AND ${registrationAlias}.sms_notifications_enabled = 1`;

const insertRegistrationForChannel = (
  env: Env,
  eventId: string,
  registrationId: string,
  commandId: string,
  now: string,
  channel: NotificationChannel,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO participant_notifications
    (id, event_id, registration_id, channel, notification_type, lifecycle_key,
     status, template_version, created_by_command_id, scheduled_at, updated_at)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, '${channel}',
          'REGISTRATION_CONFIRMED', 'registration:' || r.id,
          'PENDING', 1, ?, ?, ?
     FROM registrations r
    WHERE r.event_id = ? AND r.id = ? AND ${channelCondition(channel)}
      AND EXISTS (
        SELECT 1 FROM race_commands rc
         WHERE rc.id = ? AND rc.event_id = r.event_id AND rc.result_id = r.id
           AND rc.command_type IN ('CREATE_REGISTRATION', 'CREATE_STAFF_REGISTRATION')
      )
   ON CONFLICT DO NOTHING`,
).bind(commandId, now, now, eventId, registrationId, commandId);

export const registrationNotificationStatements = (
  env: Env,
  eventId: string,
  registrationId: string,
  commandId: string,
  now: string,
): D1PreparedStatement[] => ["EMAIL", "SMS"].map((channel) => insertRegistrationForChannel(
  env, eventId, registrationId, commandId, now, channel as NotificationChannel,
));

// Existing email assignment rows remain the migration-compatible email outbox.
// This statement adds the independent SMS side without exposing it to the old
// email consumer during migration-first deployment or rollback.
export const roundOneSmsAssignmentStatement = (
  env: Env,
  eventId: string,
  registrationId: string,
  heatId: string,
  duckAssignmentId: string,
  commandId: string,
  now: string,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO participant_notifications
    (id, event_id, registration_id, channel, notification_type, lifecycle_key,
     heat_id, duck_assignment_id, status, template_version,
     created_by_command_id, scheduled_at, updated_at)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, 'SMS',
          'ROUND_ONE_ASSIGNED', 'round-one-assignment:' || h.id,
          h.id, da.id, 'PENDING', 1, ?, ?, ?
     FROM registrations r
     JOIN race_entries re ON re.registration_id = r.id AND re.event_id = r.event_id
     JOIN heat_entries he ON he.race_entry_id = re.id AND he.event_id = r.event_id
     JOIN heats h ON h.id = he.heat_id AND h.round = 'ROUND_ONE'
     JOIN duck_assignments da
       ON da.id = ? AND da.event_id = r.event_id AND da.race_entry_id = re.id
      AND da.valid_to IS NULL
    WHERE r.event_id = ? AND r.id = ? AND h.id = ? AND r.status = 'ACTIVE'
      AND ${channelCondition("SMS")}
      AND EXISTS (SELECT 1 FROM race_commands rc WHERE rc.id = ? AND rc.event_id = r.event_id)
   ON CONFLICT DO NOTHING`,
).bind(commandId, now, now, duckAssignmentId, eventId, registrationId, heatId, commandId);

const upcomingForChannel = (
  env: Env,
  eventId: string,
  heatSelector: string,
  selectorArgs: readonly unknown[],
  commandId: string,
  now: string,
  channel: NotificationChannel,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO participant_notifications
    (id, event_id, registration_id, channel, notification_type, lifecycle_key,
     heat_id, duck_assignment_id, status, template_version,
     created_by_command_id, scheduled_at, updated_at)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, '${channel}', 'HEAT_UPCOMING',
          'upcoming:' || ? || ':' || h.id, h.id, da.id,
          'PENDING', 1, ?, ?, ?
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     JOIN duck_assignments da
        ON da.race_entry_id = re.id AND da.event_id = h.event_id AND da.valid_to IS NULL
     WHERE h.event_id = ? AND (${heatSelector})
       AND h.status IN ('LOADING', 'READY', 'CALLING')
       AND NOT EXISTS (
         SELECT 1 FROM heats previous
          WHERE previous.event_id = h.event_id AND previous.round = h.round
            AND previous.heat_number < h.heat_number
            AND previous.status NOT IN ('FINALIZED', 'CANCELLED')
       )
       AND r.status = 'ACTIVE' AND ${channelCondition(channel)}
       AND EXISTS (SELECT 1 FROM race_commands rc WHERE rc.id = ? AND rc.event_id = h.event_id)
   ON CONFLICT DO NOTHING`,
).bind(commandId, commandId, now, now, eventId, ...selectorArgs, commandId);

export const firstHeatUpcomingStatements = (
  env: Env,
  eventId: string,
  round: "ROUND_ONE" | "FINAL",
  commandId: string,
  now: string,
): D1PreparedStatement[] => ["EMAIL", "SMS"].map((channel) => upcomingForChannel(
  env,
  eventId,
  `h.round = ? AND h.heat_number = (
     SELECT MIN(first_heat.heat_number) FROM heats first_heat
      WHERE first_heat.event_id = h.event_id AND first_heat.round = h.round
        AND first_heat.status IN ('LOADING', 'READY', 'CALLING')
   )`,
  [round],
  commandId,
  now,
  channel as NotificationChannel,
));

export const nextHeatUpcomingStatements = (
  env: Env,
  eventId: string,
  completedHeatId: string,
  commandId: string,
  now: string,
): D1PreparedStatement[] => ["EMAIL", "SMS"].map((channel) => upcomingForChannel(
  env,
  eventId,
  `h.round = (SELECT completed.round FROM heats completed WHERE completed.id = ?)
   AND h.heat_number = (
     SELECT MIN(next_heat.heat_number)
       FROM heats next_heat JOIN heats completed ON completed.id = ?
      WHERE next_heat.event_id = completed.event_id AND next_heat.round = completed.round
        AND next_heat.heat_number > completed.heat_number
        AND next_heat.status IN ('LOADING', 'READY', 'CALLING')
   )`,
  [completedHeatId, completedHeatId],
  commandId,
  now,
  channel as NotificationChannel,
));

export const heatUpcomingStatements = (
  env: Env,
  eventId: string,
  heatId: string,
  commandId: string,
  now: string,
): D1PreparedStatement[] => ["EMAIL", "SMS"].map((channel) => upcomingForChannel(
  env,
  eventId,
  "h.id = ?",
  [heatId],
  commandId,
  now,
  channel as NotificationChannel,
));

const resultForChannel = (
  env: Env,
  eventId: string,
  heatId: string,
  commandId: string,
  now: string,
  channel: NotificationChannel,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO participant_notifications
    (id, event_id, registration_id, channel, notification_type, lifecycle_key,
     heat_id, duck_assignment_id, result_revision, status, template_version,
     created_by_command_id, scheduled_at, updated_at)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, '${channel}',
          CASE h.round WHEN 'FINAL' THEN 'FINAL_RESULT' ELSE 'ROUND_RESULT' END,
          'result:' || h.id || ':' || MAX(hr.revision), h.id, da.id, MAX(hr.revision),
          'PENDING', 1, ?, ?, ?
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = h.event_id AND da.valid_to IS NULL
     JOIN heat_results hr ON hr.heat_id = h.id AND hr.status = 'FINALIZED'
    WHERE h.event_id = ? AND h.id = ? AND h.status = 'FINALIZED'
      AND r.status = 'ACTIVE' AND ${channelCondition(channel)}
      AND EXISTS (SELECT 1 FROM race_commands rc WHERE rc.id = ? AND rc.event_id = h.event_id)
    GROUP BY r.id
   ON CONFLICT DO NOTHING`,
).bind(commandId, now, now, eventId, heatId, commandId);

const finalistForChannel = (
  env: Env,
  eventId: string,
  qualifyingHeatId: string,
  commandId: string,
  now: string,
  channel: NotificationChannel,
): D1PreparedStatement => env.DB.prepare(
  `INSERT INTO participant_notifications
    (id, event_id, registration_id, channel, notification_type, lifecycle_key,
     heat_id, duck_assignment_id, result_revision, status, template_version,
     created_by_command_id, scheduled_at, updated_at)
   SELECT lower(hex(randomblob(16))), r.event_id, r.id, '${channel}', 'FINAL_ASSIGNED',
          'final-assignment:' || final_heat.id || ':' || winner.revision,
          final_heat.id, da.id, winner.revision, 'PENDING', 1, ?, ?, ?
     FROM heat_results winner
     JOIN heats qualifier ON qualifier.id = winner.heat_id AND qualifier.round = 'ROUND_ONE'
     JOIN heat_entries final_entry
       ON final_entry.event_id = winner.event_id AND final_entry.race_entry_id = winner.race_entry_id
      AND final_entry.round = 'FINAL'
     JOIN heats final_heat ON final_heat.id = final_entry.heat_id AND final_heat.round = 'FINAL'
     JOIN race_entries re ON re.id = winner.race_entry_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = winner.event_id
     JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = winner.event_id AND da.valid_to IS NULL
    WHERE winner.event_id = ? AND winner.heat_id = ? AND winner.status = 'FINALIZED'
      AND winner.place = 1 AND r.status = 'ACTIVE' AND ${channelCondition(channel)}
      AND EXISTS (SELECT 1 FROM race_commands rc WHERE rc.id = ? AND rc.event_id = winner.event_id)
   ON CONFLICT DO NOTHING`,
).bind(commandId, now, now, eventId, qualifyingHeatId, commandId);

export const resultNotificationStatements = (
  env: Env,
  eventId: string,
  heatId: string,
  commandId: string,
  now: string,
  includeFinalAssignment: boolean,
  includeNextUpcoming = true,
): D1PreparedStatement[] => {
  const statements = ["EMAIL", "SMS"].map((channel) => resultForChannel(
    env, eventId, heatId, commandId, now, channel as NotificationChannel,
  ));
  if (includeFinalAssignment) statements.push(...["EMAIL", "SMS"].map((channel) => finalistForChannel(
    env, eventId, heatId, commandId, now, channel as NotificationChannel,
  )));
  if (includeNextUpcoming) {
    statements.push(...nextHeatUpcomingStatements(env, eventId, heatId, commandId, now));
  }
  return statements;
};

export interface OutboundSms {
  to: string;
  text: string;
}

export interface SmsSendResult {
  providerMessageId: string | null;
}

export type SmsSender = (sms: OutboundSms, env: Env) => Promise<SmsSendResult>;
export type SmsSuppressionChecker = (phone: string, env: Env) => Promise<boolean>;

export class SmsSendError extends Error {
  readonly safeCode: string;
  readonly retryable: boolean;
  readonly ambiguous: boolean;

  constructor(safeCode: string, retryable: boolean, ambiguous = false) {
    super(safeCode);
    this.safeCode = safeCode;
    this.retryable = retryable;
    this.ambiguous = ambiguous;
  }
}

const sha256 = async (value: string): Promise<Uint8Array> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
const hex = (value: Uint8Array): string =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const hmac = async (key: Uint8Array, value: string): Promise<Uint8Array> => {
  const imported = await crypto.subtle.importKey(
    "raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, encoder.encode(value)));
};

const signedSnsQuery = async (
  parameters: Readonly<Record<string, string>>,
  env: Env,
  operation: "SEND" | "SUPPRESSION_CHECK",
): Promise<Response> => {
  if (
    env.AWS_REGION !== "us-east-1"
    || typeof env.AWS_ACCESS_KEY_ID !== "string" || env.AWS_ACCESS_KEY_ID.length < 16
    || typeof env.AWS_SECRET_ACCESS_KEY !== "string" || env.AWS_SECRET_ACCESS_KEY.length < 32
  ) throw new SmsSendError("SNS_CONFIGURATION_INVALID", false);
  const body = new URLSearchParams(Object.entries(parameters).sort(([left], [right]) => left.localeCompare(right))).toString();
  const host = `sns.${env.AWS_REGION}.amazonaws.com`;
  const path = "/";
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = hex(await sha256(body));
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
  const contentType = "application/x-www-form-urlencoded; charset=utf-8";
  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const canonicalRequest = `POST\n${path}\n\n${canonicalHeaders}${signedHeaders}\n${payloadHash}`;
  const scope = `${date}/${env.AWS_REGION}/sns/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${hex(await sha256(canonicalRequest))}`;
  const dateKey = await hmac(encoder.encode(`AWS4${env.AWS_SECRET_ACCESS_KEY}`), date);
  const regionKey = await hmac(dateKey, env.AWS_REGION);
  const serviceKey = await hmac(regionKey, "sns");
  const signature = hex(await hmac(await hmac(serviceKey, "aws4_request"), stringToSign));
  try {
    return await fetch(`https://${host}/`, {
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
    if (operation === "SEND") throw new SmsSendError("DELIVERY_OUTCOME_UNKNOWN", false, true);
    throw new SmsSendError("SNS_OPT_OUT_CHECK_FAILED", true);
  }
};

export const sendSmsWithSns: SmsSender = async (sms, env) => {
  const response = await signedSnsQuery({
    Action: "Publish",
    Message: sms.text,
    "MessageAttributes.entry.1.Name": "AWS.SNS.SMS.SMSType",
    "MessageAttributes.entry.1.Value.DataType": "String",
    "MessageAttributes.entry.1.Value.StringValue": "Transactional",
    PhoneNumber: sms.to,
    Version: "2010-03-31",
  }, env, "SEND");
  if (!response.ok) {
    if (response.status === 429) throw new SmsSendError("SNS_THROTTLED", true);
    if (response.status === 408 || response.status >= 500) {
      throw new SmsSendError("DELIVERY_OUTCOME_UNKNOWN", false, true);
    }
    throw new SmsSendError("SNS_REJECTED", false);
  }
  const responseText = await response.text().catch(() => "");
  const messageId = responseText.match(/<MessageId>([A-Za-z0-9._:/+=-]{1,256})<\/MessageId>/)?.[1] ?? null;
  return { providerMessageId: messageId };
};

export const checkSmsOptedOutWithSns: SmsSuppressionChecker = async (phone, env) => {
  const response = await signedSnsQuery({
    Action: "CheckIfPhoneNumberIsOptedOut",
    phoneNumber: phone,
    Version: "2010-03-31",
  }, env, "SUPPRESSION_CHECK");
  if (!response.ok) {
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
    throw new SmsSendError(
      retryable ? "SNS_OPT_OUT_CHECK_FAILED" : "SNS_OPT_OUT_CHECK_REJECTED",
      retryable,
    );
  }
  const responseText = await response.text().catch(() => "");
  return /<isOptedOut>\s*true\s*<\/isOptedOut>/i.test(responseText);
};

interface NotificationRow {
  id: string;
  event_id: string;
  registration_id: string;
  channel: NotificationChannel;
  notification_type: ParticipantNotificationType;
  template_version: number;
  heat_id: string | null;
  duck_assignment_id: string | null;
  active_duck_assignment_id: string | null;
  result_revision: number | null;
  current_result_revision: number | null;
  status: string;
  event_name: string;
  event_status: string;
  first_name: string;
  email: string | null;
  phone: string | null;
  email_notifications_enabled: number;
  sms_notifications_enabled: number;
  registration_status: string;
  heat_round: string | null;
  heat_number: number | null;
  heat_status: string | null;
  heat_entry_id: string | null;
  visible_number: number | null;
  place: number | null;
  previous_open_heats: number;
}

interface ClaimRow {
  status: string;
  sending_started_at: string | null;
  delivery_claim_token: string | null;
  retry_after: string | null;
}

const rowFor = (env: Env, id: string): Promise<NotificationRow | null> => env.DB.prepare(
  `SELECT n.id, n.event_id, n.registration_id, n.channel, n.notification_type,
          n.template_version, n.heat_id, n.duck_assignment_id, n.result_revision, n.status,
          e.name AS event_name, e.status AS event_status,
          r.first_name, r.email, r.phone, r.email_notifications_enabled,
          r.sms_notifications_enabled, r.status AS registration_status,
          da.id AS active_duck_assignment_id, d.visible_number,
          h.round AS heat_round, h.heat_number, h.status AS heat_status,
          he.id AS heat_entry_id,
          (SELECT MAX(current_result.revision) FROM heat_results current_result
            WHERE current_result.heat_id = n.heat_id AND current_result.status = 'FINALIZED') AS current_result_revision,
          (SELECT current_place.place FROM heat_results current_place
            JOIN race_entries current_entry ON current_entry.id = current_place.race_entry_id
           WHERE current_place.heat_id = n.heat_id AND current_entry.registration_id = n.registration_id
             AND current_place.status = 'FINALIZED' LIMIT 1) AS place,
          CASE WHEN h.id IS NULL THEN 0 ELSE (
            SELECT COUNT(*) FROM heats previous
             WHERE previous.event_id = h.event_id AND previous.round = h.round
               AND previous.heat_number < h.heat_number
               AND previous.status NOT IN ('FINALIZED', 'CANCELLED')
          ) END AS previous_open_heats
     FROM participant_notifications n
     JOIN events e ON e.id = n.event_id
     JOIN registrations r ON r.id = n.registration_id AND r.event_id = n.event_id
     JOIN race_entries re ON re.registration_id = r.id AND re.event_id = r.event_id
     LEFT JOIN heats h ON h.id = n.heat_id AND h.event_id = n.event_id
     LEFT JOIN heat_entries he
       ON he.heat_id = n.heat_id AND he.race_entry_id = re.id AND he.event_id = n.event_id
     LEFT JOIN duck_assignments da
       ON da.race_entry_id = re.id AND da.event_id = n.event_id AND da.valid_to IS NULL
     LEFT JOIN ducks d ON d.id = da.duck_id
    WHERE n.id = ? LIMIT 1`,
).bind(id).first<NotificationRow>();

const claimFor = (env: Env, id: string): Promise<ClaimRow | null> => env.DB.prepare(
  `SELECT status, sending_started_at, delivery_claim_token, retry_after
     FROM participant_notifications WHERE id = ? LIMIT 1`,
).bind(id).first<ClaimRow>();

const e164Phone = (value: string | null): string | null => {
  if (value === null || normalizeUsPhone(value) === null) return null;
  const digits = value.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  return digits.length === 10 ? `+1${digits}` : null;
};

const validationFailure = (row: NotificationRow): string | null => {
  if (!(PARTICIPANT_NOTIFICATION_TYPES as readonly string[]).includes(row.notification_type) || row.template_version !== 1) {
    return "UNSUPPORTED_TEMPLATE";
  }
  if (row.registration_status !== "ACTIVE" && row.registration_status !== "SUBMITTED") return "REGISTRATION_NOT_ACTIVE";
  if (row.channel === "EMAIL") {
    if (row.email_notifications_enabled !== 1 || row.email === null || !emailPattern.test(row.email)) return "EMAIL_NOT_OPTED_IN";
  } else if (row.sms_notifications_enabled !== 1 || e164Phone(row.phone) === null) return "SMS_NOT_OPTED_IN";
  if (row.notification_type === "REGISTRATION_CONFIRMED") return null;
  if (
    row.heat_id === null || row.heat_entry_id === null || row.duck_assignment_id === null
    || row.active_duck_assignment_id === null || row.duck_assignment_id !== row.active_duck_assignment_id
    || row.heat_round === null || row.heat_number === null || row.visible_number === null
  ) return "RACE_ASSIGNMENT_CHANGED";
  if (row.notification_type === "HEAT_UPCOMING") {
    if (!new Set(["LOADING", "READY", "CALLING"]).has(row.heat_status ?? "") || row.previous_open_heats !== 0) {
      return "HEAT_NO_LONGER_UPCOMING";
    }
  } else if (row.notification_type === "ROUND_RESULT" || row.notification_type === "FINAL_RESULT") {
    if (row.heat_status !== "FINALIZED" || row.result_revision !== row.current_result_revision) return "RESULT_CHANGED";
  } else if (!new Set(["PLANNED", "LOADING", "READY", "CALLING"]).has(row.heat_status ?? "")) {
    return "HEAT_ASSIGNMENT_NO_LONGER_ACTIONABLE";
  }
  return null;
};

const singleLine = (value: string): string => value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
const escapeHtml = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const actionFor = (row: NotificationRow): string => {
  const round = row.heat_round === "FINAL" ? "Final" : "Round One";
  const heat = row.heat_number === null ? round : `${round}, Heat ${row.heat_number}`;
  const duck = row.visible_number === null ? "your duck" : `Duck #${row.visible_number}`;
  switch (row.notification_type) {
    case "REGISTRATION_CONFIRMED": return `Your registration for ${singleLine(row.event_name)} is confirmed.`;
    case "ROUND_ONE_ASSIGNED": return `${duck} is assigned to ${heat}.`;
    case "FINAL_ASSIGNED": return `${duck} qualified and is assigned to the Final.`;
    case "HEAT_UPCOMING": return `${heat} is next. Please bring ${duck} to the pond.`;
    case "ROUND_RESULT": return row.place === 1
      ? `${duck} won ${heat} and advanced to the Final.`
      : `${heat} has an official result. ${duck} did not advance to the Final.`;
    case "FINAL_RESULT": return row.place === null
      ? `The Final result is official. ${duck} did not place on the podium.`
      : `The Final result is official. ${duck} finished in place ${row.place}.`;
  }
};

const renderEmail = async (row: NotificationRow, env: Env): Promise<OutboundEmail> => {
  const action = actionFor(row);
  const raceUrl = new URL("/race", env.APP_ORIGIN).toString();
  const unsubscribeUrl = await unsubscribeUrlFor(row.id, env);
  const text = [
    `Hi ${singleLine(row.first_name)},`, "", action, "", `Race status: ${raceUrl}`,
    "", "Race progress can change, so reminders do not promise a start time.",
    `Unsubscribe from email updates: ${unsubscribeUrl}`,
  ].join("\n");
  return {
    from: env.EMAIL_FROM_ADDRESS,
    to: row.email!,
    subject: singleLine(action),
    text,
    html: `<!doctype html><html lang="en"><body><p>Hi ${escapeHtml(singleLine(row.first_name))},</p>`
      + `<p><strong>${escapeHtml(action)}</strong></p><p><a href="${escapeHtml(raceUrl)}">View race status</a></p>`
      + "<p>Race progress can change, so reminders do not promise a start time.</p>"
      + `<p><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe from email updates</a></p></body></html>`,
    headers: [
      { name: "List-Unsubscribe", value: `<${unsubscribeUrl}>` },
      { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
    ],
  };
};

const renderSms = (row: NotificationRow): OutboundSms => ({
  to: e164Phone(row.phone)!,
  text: `QuickDucks: ${actionFor(row)} Reply STOP to opt out.`,
});

export interface ParticipantNotificationDependencies {
  emailSender: EmailSender;
  smsSender: SmsSender;
  emailSuppressionChecker: EmailSuppressionChecker;
  smsSuppressionChecker: SmsSuppressionChecker;
}

const defaults: ParticipantNotificationDependencies = {
  emailSender: sendEmailWithSes,
  smsSender: sendSmsWithSns,
  emailSuppressionChecker: checkEmailSuppressedWithSes,
  smsSuppressionChecker: checkSmsOptedOutWithSns,
};

export type ParticipantProcessingResult = "SENT" | "CANCELLED" | "FAILED" | "NOOP" | "RETRY";

const completeClaim = async (
  env: Env,
  id: string,
  claimId: string,
  status: "CANCELLED" | "SUPPRESSED" | "FAILED",
  reason: string,
): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE participant_notification_attempts
          SET status = 'PERMANENT_FAILURE', completed_at = ?, error_code = ?
        WHERE id = ? AND notification_id = ? AND status = 'SENDING'`,
    ).bind(now, reason, claimId, id),
    env.DB.prepare(
      `UPDATE participant_notifications
          SET status = ?, terminal_at = ?, status_reason = ?, last_error_code = ?,
              retry_after = NULL, sending_started_at = NULL,
              delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(status, now, reason, status === "FAILED" ? reason : null, now, id, claimId),
  ]);
};

const suppressChannel = async (env: Env, row: NotificationRow, claimId: string): Promise<void> => {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO participant_notification_suppressions
      (event_id, registration_id, channel, source, created_at)
     VALUES (?, ?, ?, 'PROVIDER_SUPPRESSION', ?)
     ON CONFLICT(event_id, registration_id, channel) DO NOTHING`,
  ).bind(row.event_id, row.registration_id, row.channel, now).run();
  await completeClaim(env, row.id, claimId, "SUPPRESSED", `${row.channel}_PROVIDER_SUPPRESSED`);
  await env.DB.prepare(
    `UPDATE participant_notifications
        SET status = 'SUPPRESSED', terminal_at = ?, status_reason = ?,
            retry_after = NULL, last_error_code = NULL, updated_at = ?
      WHERE event_id = ? AND registration_id = ? AND channel = ?
        AND status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')`,
  ).bind(now, `${row.channel}_PROVIDER_SUPPRESSED`, now, row.event_id, row.registration_id, row.channel).run();
};

export const processParticipantNotification = async (
  env: Env,
  id: string,
  dependencies: Partial<ParticipantNotificationDependencies> = {},
): Promise<ParticipantProcessingResult> => {
  if (!notificationIdPattern.test(id)) return "NOOP";
  const claim = await claimFor(env, id);
  if (claim === null) return "NOOP";
  const staleBefore = new Date(Date.now() - 2 * 60_000).toISOString();
  if (claim.status === "SENDING") {
    if (claim.sending_started_at !== null && claim.sending_started_at >= staleBefore) return "RETRY";
    await completeClaim(env, id, claim.delivery_claim_token ?? "", "FAILED", "DELIVERY_OUTCOME_UNKNOWN");
    return "FAILED";
  }
  if (!new Set(["PENDING", "QUEUED", "RETRY_PENDING"]).has(claim.status)) return "NOOP";
  if (claim.retry_after !== null && claim.retry_after > new Date().toISOString()) return "RETRY";

  const attemptRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt
       FROM participant_notification_attempts
      WHERE notification_id = ? AND stage = 'DELIVERY'`,
  ).bind(id).first<{ last_attempt: number }>();
  const attemptNumber = Number(attemptRow?.last_attempt ?? 0) + 1;
  const claimId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE participant_notifications
            SET status = 'SENDING', sending_started_at = ?, delivery_claim_token = ?, updated_at = ?
          WHERE id = ? AND status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')
            AND (retry_after IS NULL OR retry_after <= ?)`,
      ).bind(now, claimId, now, id, now),
      env.DB.prepare(
        `INSERT INTO participant_notification_attempts
          (id, event_id, notification_id, attempt_number, stage, status, started_at)
         SELECT ?, event_id, id, ?, 'DELIVERY', 'SENDING', ?
           FROM participant_notifications
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(claimId, attemptNumber, now, id, claimId),
    ]);
  } catch {
    return "RETRY";
  }
  const claimed = await env.DB.prepare(
    "SELECT 1 AS claimed FROM participant_notification_attempts WHERE id = ? AND status = 'SENDING' LIMIT 1",
  ).bind(claimId).first<{ claimed: number }>();
  if (claimed === null) return "RETRY";

  const row = await rowFor(env, id);
  if (row === null) {
    await completeClaim(env, id, claimId, "CANCELLED", "REGISTRATION_NOT_ACTIVE");
    return "CANCELLED";
  }
  const invalid = validationFailure(row);
  if (invalid !== null) {
    await completeClaim(env, id, claimId, invalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED", invalid);
    return invalid === "UNSUPPORTED_TEMPLATE" ? "FAILED" : "CANCELLED";
  }
  const localSuppression = await env.DB.prepare(
    `SELECT 1 AS suppressed FROM participant_notification_suppressions
      WHERE event_id = ? AND registration_id = ? AND channel = ? LIMIT 1`,
  ).bind(row.event_id, row.registration_id, row.channel).first<{ suppressed: number }>();
  if (localSuppression !== null) {
    await completeClaim(env, id, claimId, "SUPPRESSED", `${row.channel}_SUPPRESSED`);
    return "CANCELLED";
  }

  const adapters = { ...defaults, ...dependencies };
  let sendResult: { providerMessageId: string | null };
  try {
    if (row.channel === "EMAIL") {
      if (await adapters.emailSuppressionChecker(row.email!, env)) {
        await suppressChannel(env, row, claimId);
        return "CANCELLED";
      }
      sendResult = await adapters.emailSender(await renderEmail(row, env), env);
    } else {
      const phone = e164Phone(row.phone)!;
      if (await adapters.smsSuppressionChecker(phone, env)) {
        await suppressChannel(env, row, claimId);
        return "CANCELLED";
      }
      sendResult = await adapters.smsSender(renderSms(row), env);
    }
  } catch (error) {
    const failure = error instanceof EmailSendError || error instanceof SmsSendError
      ? error
      : new SmsSendError("PROVIDER_FAILURE", false, true);
    const ambiguous = failure.ambiguous;
    const exhausted = failure.retryable && attemptNumber >= 5;
    const retryable = failure.retryable && !exhausted && !ambiguous;
    const code = ambiguous ? "DELIVERY_OUTCOME_UNKNOWN"
      : exhausted ? "DELIVERY_RETRIES_EXHAUSTED" : failure.safeCode;
    const completedAt = new Date().toISOString();
    const backoffSeconds = Math.min(900, 30 * (2 ** Math.min(attemptNumber - 1, 5)));
    const retryAfter = retryable ? new Date(Date.now() + backoffSeconds * 1000).toISOString() : null;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE participant_notification_attempts
            SET status = ?, completed_at = ?, error_code = ?
          WHERE id = ? AND status = 'SENDING'`,
      ).bind(retryable ? "TEMPORARY_FAILURE" : "PERMANENT_FAILURE", completedAt, code, claimId),
      env.DB.prepare(
        `UPDATE participant_notifications
            SET status = ?, terminal_at = ?, status_reason = ?, last_error_code = ?,
                retry_after = ?, sending_started_at = NULL, delivery_claim_token = NULL, updated_at = ?
          WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
      ).bind(
        retryable ? "RETRY_PENDING" : "FAILED", retryable ? null : completedAt,
        retryable ? null : code, code, retryAfter, completedAt, id, claimId,
      ),
    ]);
    return retryable ? "RETRY" : "FAILED";
  }

  const providerMessageId = typeof sendResult.providerMessageId === "string"
      && /^[A-Za-z0-9._:/+=-]{1,256}$/.test(sendResult.providerMessageId)
    ? sendResult.providerMessageId : null;
  const sentAt = new Date().toISOString();
  // This write stays outside the provider catch. If it fails after acceptance,
  // the stale SENDING claim is terminalized and never sent a second time.
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE participant_notification_attempts
          SET status = 'SENT', completed_at = ?, provider_message_id = ?, error_code = NULL
        WHERE id = ? AND status = 'SENDING'`,
    ).bind(sentAt, providerMessageId, claimId),
    env.DB.prepare(
      `UPDATE participant_notifications
          SET status = 'SENT', sent_at = ?, terminal_at = ?, status_reason = 'PROVIDER_ACCEPTED',
              last_error_code = NULL, retry_after = NULL, sending_started_at = NULL,
              delivery_claim_token = NULL, updated_at = ?
        WHERE id = ? AND status = 'SENDING' AND delivery_claim_token = ?`,
    ).bind(sentAt, sentAt, sentAt, id, claimId),
  ]);
  return "SENT";
};

const publishOne = async (env: Env, id: string): Promise<void> => {
  if (!notificationIdPattern.test(id)) return;
  const staleQueuedBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  const notification = await env.DB.prepare(
    `SELECT id, event_id
       FROM participant_notifications
      WHERE id = ? AND (
        status IN ('PENDING', 'RETRY_PENDING')
        OR (status = 'QUEUED' AND queued_at <= ?)
      ) LIMIT 1`,
  ).bind(id, staleQueuedBefore).first<{ id: string; event_id: string }>();
  if (notification === null) return;
  const attemptRow = await env.DB.prepare(
    `SELECT COALESCE(MAX(attempt_number), 0) AS last_attempt
       FROM participant_notification_attempts
      WHERE notification_id = ? AND stage = 'QUEUE'`,
  ).bind(id).first<{ last_attempt: number }>();
  const attemptNumber = Number(attemptRow?.last_attempt ?? 0) + 1;
  const attemptId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  try {
    // Queue payloads contain only the opaque outbox identifier. Contact, consent,
    // result, and suppression state are all reloaded after the delivery claim.
    await env.PARTICIPANT_NOTIFICATION_QUEUE.send(id);
    const completedAt = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO participant_notification_attempts
          (id, event_id, notification_id, attempt_number, stage, status, started_at, completed_at)
         VALUES (?, ?, ?, ?, 'QUEUE', 'QUEUED', ?, ?)`,
      ).bind(attemptId, notification.event_id, id, attemptNumber, startedAt, completedAt),
      env.DB.prepare(
        `UPDATE participant_notifications
            SET status = 'QUEUED', queued_at = ?, retry_after = NULL,
                last_error_code = NULL, updated_at = ?
          WHERE id = ? AND status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')`,
      ).bind(completedAt, completedAt, id),
    ]);
  } catch {
    const completedAt = new Date().toISOString();
    const failureCount = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM participant_notification_attempts
        WHERE notification_id = ? AND stage = 'QUEUE' AND status = 'TEMPORARY_FAILURE'`,
    ).bind(id).first<{ count: number }>().catch(() => null);
    const delay = Math.min(3600, 30 * (2 ** Math.min(Number(failureCount?.count ?? 0), 7)));
    try {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO participant_notification_attempts
            (id, event_id, notification_id, attempt_number, stage, status,
             started_at, completed_at, error_code)
           VALUES (?, ?, ?, ?, 'QUEUE', 'TEMPORARY_FAILURE', ?, ?, 'QUEUE_PUBLISH_FAILED')`,
        ).bind(attemptId, notification.event_id, id, attemptNumber, startedAt, completedAt),
        env.DB.prepare(
          `UPDATE participant_notifications
              SET status = 'RETRY_PENDING', retry_after = ?,
                  last_error_code = 'QUEUE_PUBLISH_FAILED', updated_at = ?
            WHERE id = ? AND status IN ('PENDING', 'QUEUED', 'RETRY_PENDING')`,
        ).bind(new Date(Date.now() + delay * 1000).toISOString(), completedAt, id),
      ]);
    } catch {
      // The durable row remains discoverable by reconciliation.
    }
  }
};

export const publishParticipantNotification = async (env: Env, id: string): Promise<void> => {
  if (env.PARTICIPANT_NOTIFICATION_QUEUE?.send === undefined) return;
  try {
    await publishOne(env, id);
  } catch {
    // The outbox remains discoverable by scheduled reconciliation.
  }
};

export const publishParticipantNotificationsForCommand = async (
  env: Env,
  commandId: string,
): Promise<void> => {
  if (env.PARTICIPANT_NOTIFICATION_QUEUE?.send === undefined) return;
  try {
    const rows = await env.DB.prepare(
      `SELECT id FROM participant_notifications
        WHERE created_by_command_id = ? AND status = 'PENDING'
        ORDER BY created_at, id LIMIT 100`,
    ).bind(commandId).all<{ id: string }>();
    for (const row of rows.results) await publishOne(env, row.id);
  } catch {
    // The cron reconciler owns recovery; race mutations never inherit transport
    // failure.
  }
};

export const dispatchPendingParticipantNotifications = async (env: Env): Promise<void> => {
  const now = new Date().toISOString();
  const staleQueuedBefore = new Date(Date.now() - 5 * 60_000).toISOString();
  const rows = await env.DB.prepare(
    `SELECT id FROM participant_notifications
      WHERE (status = 'PENDING' AND (scheduled_at IS NULL OR scheduled_at <= ?))
         OR (status = 'RETRY_PENDING' AND (retry_after IS NULL OR retry_after <= ?))
         OR (status = 'QUEUED' AND queued_at <= ?)
      ORDER BY created_at, id LIMIT 25`,
  ).bind(now, now, staleQueuedBefore).all<{ id: string }>();
  // Sequential publication is intentional: a minute tick cannot burst one
  // hundred concurrent requests at a recovering queue.
  for (const row of rows.results) await publishOne(env, row.id);
};

export const handleParticipantNotificationQueue = async (
  batch: MessageBatch<unknown>,
  env: Env,
  dependencies: Partial<ParticipantNotificationDependencies> = {},
): Promise<void> => {
  for (const message of batch.messages) {
    if (typeof message.body !== "string" || !notificationIdPattern.test(message.body)) {
      message.ack();
      continue;
    }
    try {
      const result = await processParticipantNotification(env, message.body, dependencies);
      if (result === "RETRY") message.retry({ delaySeconds: 60 });
      else message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
};
