import { publishPendingParticipantNotifications } from "./email-notifications.ts";
import type { Env } from "./types.ts";

export type ParticipantNotificationType =
  | "REGISTRATION_CONFIRMED"
  | "HEAT_ASSIGNED"
  | "FINAL_ASSIGNED"
  | "HEAT_UPCOMING"
  | "ROUND_RESULT";

interface NotificationInput {
  eventId: string;
  registrationId: string;
  commandId: string;
  type: ParticipantNotificationType;
  lifecycleKey: string;
  now: string;
  heatId?: string | null;
  duckAssignmentId?: string | null;
  heatRunSequence?: number | null;
  resultRevision?: number | null;
}

// Two rows, one per independently consented channel. Contact values never enter
// the outbox or queue; the consumer reloads them after claiming delivery.
export const participantNotificationStatements = (
  env: Env,
  input: NotificationInput,
): D1PreparedStatement[] => (["EMAIL", "SMS"] as const).map((channel) => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, channel, lifecycle_key, heat_run_sequence,
     result_revision, status, template_version, created_by_command_id,
     scheduled_at, updated_at)
   SELECT ?, r.event_id, r.id, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 1, ?, ?, ?
     FROM registrations r
     JOIN events e ON e.id = r.event_id
    WHERE r.id = ? AND r.event_id = ?
      AND EXISTS (SELECT 1 FROM race_commands rc
                   WHERE rc.id = ? AND rc.event_id = r.event_id)
      AND ((? = 'EMAIL' AND r.email IS NOT NULL AND r.email_notifications_enabled = 1)
        OR (? = 'SMS' AND e.sms_notifications_enabled = 1
          AND r.phone IS NOT NULL AND r.sms_notifications_enabled = 1))
   ON CONFLICT DO NOTHING`,
).bind(
  crypto.randomUUID(),
  input.heatId ?? null,
  input.duckAssignmentId ?? null,
  input.type,
  channel,
  input.lifecycleKey,
  input.heatRunSequence ?? null,
  input.resultRevision ?? null,
  input.commandId,
  input.now,
  input.now,
  input.registrationId,
  input.eventId,
  input.commandId,
  channel,
  channel,
));

interface HeatNotificationInput {
  eventId: string;
  heatId: string;
  commandId: string;
  type: "HEAT_UPCOMING" | "ROUND_RESULT";
  lifecycleKeyPrefix: string;
  now: string;
  heatRunSequence?: number | null;
  resultRevision?: number | null;
}

// Set-based form for every participant on a heat roster. SQLite supplies the
// randomness, while fixed version/variant nibbles keep these IDs on the same
// RFC 4122 v4 contract as notifications created by the one-participant form.
// Logical uniqueness remains the channel/lifecycle key, not this transport ID.
export const heatNotificationStatements = (
  env: Env,
  input: HeatNotificationInput,
): D1PreparedStatement[] => (["EMAIL", "SMS"] as const).map((channel) => env.DB.prepare(
  `INSERT INTO email_notifications
    (id, event_id, registration_id, heat_id, duck_assignment_id,
     notification_type, channel, lifecycle_key, heat_run_sequence,
     result_revision, status, template_version, created_by_command_id,
     scheduled_at, updated_at)
    SELECT lower(
             hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4'
             || substr(hex(randomblob(2)), 2, 3) || '-8'
             || substr(hex(randomblob(2)), 2, 3) || '-' || hex(randomblob(6))
           ), h.event_id, r.id, h.id, da.id,
          ?, ?, ? || ':' || r.id, ?, ?, 'PENDING', 1, ?, ?, ?
     FROM heats h
     JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
     JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = h.event_id
     JOIN registrations r ON r.id = re.registration_id AND r.event_id = h.event_id
     JOIN events e ON e.id = h.event_id
     JOIN duck_assignments da
       ON da.event_id = h.event_id AND da.race_entry_id = re.id AND da.valid_to IS NULL
    WHERE h.id = ? AND h.event_id = ?
      AND r.status = 'ACTIVE'
       AND EXISTS (SELECT 1 FROM race_commands rc
                    WHERE rc.id = ? AND rc.event_id = h.event_id)
         AND (? <> 'HEAT_UPCOMING' OR NOT EXISTS (
          SELECT 1
            FROM heats earlier
           WHERE earlier.event_id = h.event_id
             AND earlier.status NOT IN ('FINALIZED', 'CANCELLED')
             AND earlier.round = h.round
             AND earlier.heat_number < h.heat_number
        ))
       AND ((? = 'EMAIL' AND r.email IS NOT NULL AND r.email_notifications_enabled = 1)
        OR (? = 'SMS' AND e.sms_notifications_enabled = 1
          AND r.phone IS NOT NULL AND r.sms_notifications_enabled = 1))
   ON CONFLICT DO NOTHING`,
).bind(
  input.type,
  channel,
  input.lifecycleKeyPrefix,
  input.heatRunSequence ?? null,
  input.resultRevision ?? null,
  input.commandId,
  input.now,
  input.now,
  input.heatId,
  input.eventId,
  input.commandId,
  input.type,
  channel,
  channel,
));

export const cancelChannelNotificationsStatement = (
  env: Env,
  registrationId: string,
  channel: "EMAIL" | "SMS",
  commandId: string,
  now: string,
  reason: string,
): D1PreparedStatement => env.DB.prepare(
  `UPDATE email_notifications
      SET status = 'CANCELLED', terminal_at = ?, status_reason = ?,
          retry_after = NULL, last_error_code = NULL, updated_at = ?
    WHERE registration_id = ? AND channel = ?
      AND status IN ('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING')
      AND EXISTS (SELECT 1 FROM race_commands rc WHERE rc.id = ?)`,
).bind(now, reason, now, registrationId, channel, commandId);

export const publishParticipantNotifications = publishPendingParticipantNotifications;
