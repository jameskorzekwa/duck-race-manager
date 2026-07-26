import type { StaffActor } from "./auth.ts";
import { isCommandId } from "./registration.ts";
import type { Env } from "./types.ts";

const headers = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
} as const;

const json = (value: unknown, status = 200): Response =>
  Response.json(value, { status, headers });

const notificationStatuses = new Set([
  "WAITING_FOR_SYNC",
  "PENDING",
  "QUEUED",
  "SENDING",
  "SENT",
  "RETRY_PENDING",
  "DELIVERED",
  "FAILED",
  "BOUNCED",
  "COMPLAINED",
  "SUPPRESSED",
  "CANCELLED",
]);

const terminalNotificationStatuses = new Set([
  "DELIVERED",
  "FAILED",
  "BOUNCED",
  "COMPLAINED",
  "SUPPRESSED",
  "CANCELLED",
]);

const dispositionInventoryStatus = {
  RETURNED: "AVAILABLE",
  KEPT: "KEPT",
  MISSING: "MISSING",
  DAMAGED: "DAMAGED",
  QUARANTINED: "QUARANTINED",
  RETIRED: "RETIRED",
  UNACCOUNTED_FOR: "UNACCOUNTED_FOR",
} as const;

type DuckDisposition = keyof typeof dispositionInventoryStatus;

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > 8_192) return null;
  try {
    const body = await request.text();
    if (body.length > 8_192) return null;
    const parsed = JSON.parse(body) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const adminRequired = (actor: StaffActor): Response | null =>
  actor.isSystemAdmin ? null : json({ error: "Administrator permission required." }, 403);

const validPathId = (value: string): boolean => /^[A-Za-z0-9_-]{1,128}$/.test(value);

const numberValue = (value: unknown): number => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
};

interface ExistingCommand {
  event_id: string;
  command_type: string;
  result_id: string | null;
}

const findCommand = (env: Env, commandId: string): Promise<ExistingCommand | null> =>
  env.DB.prepare(
    "SELECT event_id, command_type, result_id FROM race_commands WHERE id = ? LIMIT 1",
  ).bind(commandId).first<ExistingCommand>();

interface EventState {
  id: string;
  name: string;
  status: string;
  purge_status: string | null;
}

const getEventState = (env: Env, eventId: string): Promise<EventState | null> =>
  env.DB.prepare(
    `SELECT e.id, e.name, e.status, epc.status AS purge_status
       FROM events e
       LEFT JOIN event_purge_claims epc ON epc.event_id = e.id
      WHERE e.id = ?
      LIMIT 1`,
  ).bind(eventId).first<EventState>();

const operationalSummary = async (env: Env, eventId: string): Promise<Response> => {
  const event = await getEventState(env, eventId);
  if (event === null) return json({ error: "Event not found." }, 404);

  const [registrations, ducks, heats, returns, notifications] = await Promise.all([
    env.DB.prepare(
      `SELECT COUNT(*) AS total_count,
              SUM(CASE WHEN r.status = 'SUBMITTED' THEN 1 ELSE 0 END) AS submitted_count,
              SUM(CASE WHEN r.status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_count,
              SUM(CASE WHEN r.status IN ('SUBMITTED', 'ACTIVE') AND da.id IS NULL THEN 1 ELSE 0 END) AS unpaired_count
         FROM registrations r
         LEFT JOIN race_entries re ON re.registration_id = r.id
         LEFT JOIN duck_assignments da ON da.race_entry_id = re.id AND da.valid_to IS NULL
        WHERE r.event_id = ?`,
    ).bind(eventId).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS reserved_count,
              SUM(CASE WHEN ded.id IS NULL AND da.id IS NULL AND ed.released_at IS NULL THEN 1 ELSE 0 END) AS unassigned_count,
              SUM(CASE WHEN da.id IS NOT NULL AND d.inventory_status != 'IN_USE' THEN 1 ELSE 0 END) AS inventory_mismatch_count,
              SUM(CASE WHEN dt.id IS NULL THEN 1 ELSE 0 END) AS missing_active_tag_count
         FROM event_ducks ed
         JOIN ducks d ON d.id = ed.duck_id
         LEFT JOIN duck_assignments da ON da.event_duck_id = ed.id AND da.valid_to IS NULL
         LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
         LEFT JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'ACTIVE'
        WHERE ed.event_id = ?`,
    ).bind(eventId).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total_count,
              SUM(CASE WHEN status IN ('RUNNING', 'AWAITING_RESULT') THEN 1 ELSE 0 END) AS blocking_count,
              SUM(CASE WHEN status NOT IN ('FINALIZED', 'CANCELLED') THEN 1 ELSE 0 END) AS unfinished_count,
              SUM(CASE WHEN status = 'AWAITING_RESULT' THEN 1 ELSE 0 END) AS awaiting_result_count
         FROM heats
        WHERE event_id = ?`,
    ).bind(eventId).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT COUNT(ed.id) AS total_count,
              SUM(CASE WHEN ded.id IS NULL THEN 1 ELSE 0 END) AS unresolved_count,
              SUM(CASE WHEN ed.released_at IS NULL THEN 1 ELSE 0 END) AS unreleased_count,
              SUM(CASE WHEN da.id IS NOT NULL THEN 1 ELSE 0 END) AS active_assignment_count,
              (SELECT COUNT(*) FROM return_batches rb
                WHERE rb.event_id = ? AND rb.status IN ('OPEN', 'FINALIZING')) AS open_batch_count
         FROM event_ducks ed
         LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
         LEFT JOIN duck_assignments da ON da.event_duck_id = ed.id AND da.valid_to IS NULL
        WHERE ed.event_id = ?`,
    ).bind(eventId, eventId).first<Record<string, unknown>>(),
    env.DB.prepare(
      `SELECT COUNT(*) AS total_count,
              SUM(CASE WHEN status NOT IN ('DELIVERED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'CANCELLED') THEN 1 ELSE 0 END) AS nonterminal_count,
              SUM(CASE WHEN status IN ('FAILED', 'BOUNCED', 'COMPLAINED') THEN 1 ELSE 0 END) AS failed_count,
              SUM(CASE WHEN status = 'RETRY_PENDING' THEN 1 ELSE 0 END) AS retry_pending_count
         FROM email_notifications
        WHERE event_id = ?`,
    ).bind(eventId).first<Record<string, unknown>>(),
  ]);

  const registrationBlockers = numberValue(registrations?.unpaired_count);
  const duckBlockers = numberValue(ducks?.inventory_mismatch_count) + numberValue(ducks?.missing_active_tag_count);
  const heatBlockers = numberValue(heats?.blocking_count);
  const returnBlockers = numberValue(returns?.unresolved_count)
    + numberValue(returns?.unreleased_count)
    + numberValue(returns?.active_assignment_count)
    + numberValue(returns?.open_batch_count);
  const notificationBlockers = numberValue(notifications?.nonterminal_count);

  return json({
    event: { id: event.id, name: event.name, status: event.status, purgeStatus: event.purge_status },
    blockerCount: registrationBlockers + duckBlockers + heatBlockers + returnBlockers + notificationBlockers,
    areas: {
      registration: {
        blockerCount: registrationBlockers,
        total: numberValue(registrations?.total_count),
        submitted: numberValue(registrations?.submitted_count),
        active: numberValue(registrations?.active_count),
        unpaired: registrationBlockers,
      },
      duck: {
        blockerCount: duckBlockers,
        reserved: numberValue(ducks?.reserved_count),
        unassigned: numberValue(ducks?.unassigned_count),
        inventoryMismatches: numberValue(ducks?.inventory_mismatch_count),
        missingActiveTags: numberValue(ducks?.missing_active_tag_count),
      },
      heat: {
        blockerCount: heatBlockers,
        total: numberValue(heats?.total_count),
        unfinished: numberValue(heats?.unfinished_count),
        awaitingResult: numberValue(heats?.awaiting_result_count),
      },
      return: {
        blockerCount: returnBlockers,
        total: numberValue(returns?.total_count),
        unresolved: numberValue(returns?.unresolved_count),
        unreleased: numberValue(returns?.unreleased_count),
        activeAssignments: numberValue(returns?.active_assignment_count),
        openBatches: numberValue(returns?.open_batch_count),
      },
      notification: {
        blockerCount: notificationBlockers,
        total: numberValue(notifications?.total_count),
        nonterminal: notificationBlockers,
        failed: numberValue(notifications?.failed_count),
        retryPending: numberValue(notifications?.retry_pending_count),
      },
    },
  });
};

interface NotificationListRow {
  id: string;
  registration_id: string;
  notification_type: string;
  status: string;
  template_version: number;
  scheduled_at: string | null;
  queued_at: string | null;
  sent_at: string | null;
  terminal_at: string | null;
  status_reason: string | null;
  last_error_code: string | null;
  created_at: string;
  first_name: string;
  last_name: string;
  heat_number: number | null;
  round: string | null;
  attempt_count: number;
  last_attempt_status: string | null;
  last_attempt_error_code: string | null;
}

const listNotifications = async (url: URL, env: Env, eventId: string): Promise<Response> => {
  const status = url.searchParams.get("status")?.trim().toUpperCase() ?? null;
  if (status !== null && !notificationStatuses.has(status)) {
    return json({ error: "Invalid notification status." }, 400);
  }
  const requestedLimit = Number(url.searchParams.get("limit") ?? 50);
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 100
    ? requestedLimit
    : 50;
  const beforeValue = url.searchParams.get("before");
  const before = beforeValue !== null && !Number.isNaN(Date.parse(beforeValue))
    ? new Date(beforeValue).toISOString()
    : null;
  if (beforeValue !== null && before === null) return json({ error: "Invalid pagination timestamp." }, 400);

  const statusClause = status === null ? "" : "AND n.status = ?";
  const beforeClause = before === null ? "" : "AND n.created_at < ?";
  const args: unknown[] = [eventId];
  if (status !== null) args.push(status);
  if (before !== null) args.push(before);
  args.push(limit);
  const rows = await env.DB.prepare(
    `SELECT n.id, n.registration_id, n.notification_type, n.status,
            n.template_version, n.scheduled_at, n.queued_at, n.sent_at,
            n.terminal_at, n.status_reason, n.last_error_code, n.created_at,
            r.first_name, r.last_name, h.heat_number, h.round,
            (SELECT COUNT(*) FROM email_attempts count_attempt
              WHERE count_attempt.notification_id = n.id) AS attempt_count,
            last_attempt.status AS last_attempt_status,
            last_attempt.error_code AS last_attempt_error_code
       FROM email_notifications n
       JOIN registrations r ON r.id = n.registration_id AND r.event_id = n.event_id
       LEFT JOIN heats h ON h.id = n.heat_id AND h.event_id = n.event_id
       LEFT JOIN email_attempts last_attempt ON last_attempt.id = (
         SELECT ea.id FROM email_attempts ea
          WHERE ea.notification_id = n.id
          ORDER BY ea.attempt_number DESC, ea.created_at DESC
          LIMIT 1
       )
      WHERE n.event_id = ? ${statusClause} ${beforeClause}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ?`,
  ).bind(...args).all<NotificationListRow>();

  return json({
    notifications: rows.results.map((row) => ({
      id: row.id,
      registrationId: row.registration_id,
      participantName: `${row.first_name} ${row.last_name}`,
      type: row.notification_type,
      status: row.status,
      terminal: terminalNotificationStatuses.has(row.status),
      templateVersion: row.template_version,
      heat: row.heat_number === null ? null : { round: row.round, number: row.heat_number },
      scheduledAt: row.scheduled_at,
      queuedAt: row.queued_at,
      sentAt: row.sent_at,
      terminalAt: row.terminal_at,
      statusReason: row.status_reason,
      errorCode: row.last_error_code,
      createdAt: row.created_at,
      attempts: row.attempt_count,
      lastAttempt: row.last_attempt_status === null ? null : {
        status: row.last_attempt_status,
        errorCode: row.last_attempt_error_code,
      },
    })),
  });
};

interface AttemptRow {
  id: string;
  attempt_number: number;
  stage: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  error_code: string | null;
}

const listNotificationAttempts = async (
  env: Env,
  eventId: string,
  notificationId: string,
): Promise<Response> => {
  const notification = await env.DB.prepare(
    "SELECT id, status FROM email_notifications WHERE id = ? AND event_id = ? LIMIT 1",
  ).bind(notificationId, eventId).first<{ id: string; status: string }>();
  if (notification === null) return json({ error: "Notification not found." }, 404);
  const attempts = await env.DB.prepare(
    `SELECT id, attempt_number, stage, status, started_at, completed_at, error_code
       FROM email_attempts
      WHERE notification_id = ? AND event_id = ?
      ORDER BY attempt_number DESC, created_at DESC
      LIMIT 100`,
  ).bind(notificationId, eventId).all<AttemptRow>();
  return json({
    notification: { id: notification.id, status: notification.status },
    attempts: attempts.results.map((attempt) => ({
      id: attempt.id,
      number: attempt.attempt_number,
      stage: attempt.stage,
      status: attempt.status,
      startedAt: attempt.started_at,
      completedAt: attempt.completed_at,
      errorCode: attempt.error_code,
    })),
  });
};

interface RetryAttemptRow {
  id: string;
  notification_id: string;
  status: string;
  attempt_number: number;
}

const publishRetry = async (
  env: Env,
  eventId: string,
  notificationId: string,
  attempt: RetryAttemptRow,
  replayed: boolean,
): Promise<Response> => {
  if (attempt.status === "QUEUED") {
    return json({ notificationId, status: "QUEUED", replayed: true });
  }

  const now = new Date().toISOString();
  try {
    // The consumer receives no participant data or private token, only this durable record ID.
    await env.EMAIL_QUEUE.send(notificationId);
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts
            SET status = 'QUEUED', completed_at = ?, error_code = NULL
          WHERE id = ? AND event_id = ? AND status IN ('PENDING', 'TEMPORARY_FAILURE')`,
      ).bind(now, attempt.id, eventId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = 'QUEUED', queued_at = ?, retry_after = NULL,
                last_error_code = NULL, updated_at = ?
          WHERE id = ? AND event_id = ? AND status IN ('PENDING', 'RETRY_PENDING')`,
      ).bind(now, now, notificationId, eventId),
    ]);
    return json({ notificationId, status: "QUEUED", replayed }, replayed ? 200 : 202);
  } catch {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE email_attempts
            SET status = 'TEMPORARY_FAILURE', completed_at = ?, error_code = 'QUEUE_PUBLISH_FAILED'
          WHERE id = ? AND event_id = ?`,
      ).bind(now, attempt.id, eventId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = 'RETRY_PENDING', last_error_code = 'QUEUE_PUBLISH_FAILED', updated_at = ?
          WHERE id = ? AND event_id = ? AND status = 'PENDING'`,
      ).bind(now, notificationId, eventId),
    ]);
    return json({ error: "The retry is saved but could not be queued. Retry the same command." }, 503);
  }
};

const retryNotification = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  notificationId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  if (typeof commandId !== "string" || !isCommandId(commandId)) {
    return json({ error: "A valid command identifier is required." }, 400);
  }

  const existing = await findCommand(env, commandId);
  if (existing !== null) {
    if (
      existing.event_id !== eventId
      || existing.command_type !== "RETRY_NOTIFICATION"
      || existing.result_id !== notificationId
    ) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const attempt = await env.DB.prepare(
      `SELECT id, notification_id, status, attempt_number
         FROM email_attempts
        WHERE source_command_id = ? AND event_id = ? AND notification_id = ?
        LIMIT 1`,
    ).bind(commandId, eventId, notificationId).first<RetryAttemptRow>();
    return attempt === null
      ? json({ error: "The saved retry has no durable queue attempt." }, 409)
      : publishRetry(env, eventId, notificationId, attempt, true);
  }

  const now = new Date().toISOString();
  const attemptId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, n.event_id, 'RETRY_NOTIFICATION', n.id, ?, ?
           FROM email_notifications n
           LEFT JOIN event_purge_claims epc ON epc.event_id = n.event_id
          WHERE n.id = ? AND n.event_id = ?
            AND n.status IN ('FAILED', 'RETRY_PENDING')
            AND epc.event_id IS NULL`,
      ).bind(commandId, now, now, notificationId, eventId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = 'PENDING', terminal_at = NULL, status_reason = NULL,
                last_error_code = NULL, retry_after = NULL, updated_at = ?
          WHERE id = ? AND event_id = ?
            AND status IN ('FAILED', 'RETRY_PENDING')
            AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'RETRY_NOTIFICATION')`,
      ).bind(now, notificationId, eventId, commandId),
      env.DB.prepare(
        `INSERT INTO email_attempts
          (id, event_id, notification_id, attempt_number, stage, status,
           source_command_id, started_at)
         SELECT ?, ?, ?, COALESCE(MAX(ea.attempt_number), 0) + 1,
                'QUEUE', 'PENDING', ?, ?
           FROM race_commands c
           LEFT JOIN email_attempts ea ON ea.notification_id = ?
          WHERE c.id = ? AND c.event_id = ? AND c.command_type = 'RETRY_NOTIFICATION'
          GROUP BY c.id`,
      ).bind(attemptId, eventId, notificationId, commandId, now, notificationId, commandId, eventId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'NOTIFICATION_RETRY_REQUESTED', 'EMAIL_NOTIFICATION', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = 'RETRY_NOTIFICATION'`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        commandId,
        notificationId,
        now,
        JSON.stringify({ staff_profile_id: actor.id }),
        commandId,
        eventId,
      ),
    ]);
  } catch {
    const replay = await findCommand(env, commandId);
    if (replay === null) return json({ error: "The notification retry conflicted with another update." }, 409);
  }

  const attempt = await env.DB.prepare(
    `SELECT id, notification_id, status, attempt_number
       FROM email_attempts
      WHERE source_command_id = ? AND event_id = ? AND notification_id = ?
      LIMIT 1`,
  ).bind(commandId, eventId, notificationId).first<RetryAttemptRow>();
  return attempt === null
    ? json({ error: "Only failed notifications can be retried." }, 409)
    : publishRetry(env, eventId, notificationId, attempt, false);
};

const terminalNotificationAction = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  notificationId: string,
  action: "SUPPRESS" | "CANCEL",
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const reason = typeof payload?.reason === "string" ? payload.reason.trim().replace(/\s+/g, " ") : "";
  if (
    typeof commandId !== "string"
    || !isCommandId(commandId)
    || reason.length < 4
    || reason.length > 500
  ) {
    return json({ error: "A valid command and reason between 4 and 500 characters are required." }, 400);
  }

  const commandType = action === "SUPPRESS" ? "SUPPRESS_NOTIFICATION" : "CANCEL_NOTIFICATION";
  const targetStatus = action === "SUPPRESS" ? "SUPPRESSED" : "CANCELLED";
  const existing = await findCommand(env, commandId);
  if (existing !== null) {
    if (existing.event_id !== eventId || existing.command_type !== commandType || existing.result_id !== notificationId) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const notification = await env.DB.prepare(
      `SELECT id, status, status_reason
         FROM email_notifications
        WHERE id = ? AND event_id = ?
        LIMIT 1`,
    ).bind(notificationId, eventId).first<{ id: string; status: string; status_reason: string | null }>();
    if (notification === null || notification.status !== targetStatus || notification.status_reason !== reason) {
      return json({ error: "The replayed command does not match this request." }, 409);
    }
    return json({ notificationId, status: targetStatus, replayed: true });
  }

  const eligibleStatuses = action === "SUPPRESS"
    ? "('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING', 'FAILED')"
    : "('WAITING_FOR_SYNC', 'PENDING', 'QUEUED', 'RETRY_PENDING')";
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, n.event_id, ?, n.id, ?, ?
           FROM email_notifications n
           LEFT JOIN event_purge_claims epc ON epc.event_id = n.event_id
          WHERE n.id = ? AND n.event_id = ? AND n.status IN ${eligibleStatuses}
            AND epc.event_id IS NULL`,
      ).bind(commandId, commandType, now, now, notificationId, eventId),
      env.DB.prepare(
        `UPDATE email_notifications
            SET status = ?, terminal_at = ?, status_reason = ?, retry_after = NULL, updated_at = ?
          WHERE id = ? AND event_id = ?
            AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = ?)`,
      ).bind(targetStatus, now, reason, now, notificationId, eventId, commandId, commandType),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, ?, 'EMAIL_NOTIFICATION', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = ?`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        commandId,
        action === "SUPPRESS" ? "NOTIFICATION_SUPPRESSED" : "NOTIFICATION_CANCELLED",
        notificationId,
        now,
        JSON.stringify({ staff_profile_id: actor.id, reason_recorded: true }),
        commandId,
        eventId,
        commandType,
      ),
    ]);
  } catch {
    return json({ error: "The notification update conflicted with another operation." }, 409);
  }

  const saved = await findCommand(env, commandId);
  return saved === null
    ? json({ error: `This notification cannot be ${action === "SUPPRESS" ? "suppressed" : "cancelled"} in its current state.` }, 409)
    : json({ notificationId, status: targetStatus, replayed: false }, 201);
};

interface ReturnBatchRow {
  id: string;
  event_id: string;
  status: string;
  started_at: string;
  finalized_at: string | null;
  item_count: number;
}

const returnBatchResponse = (batch: ReturnBatchRow, replayed: boolean): Response => json({
  batch: {
    id: batch.id,
    eventId: batch.event_id,
    status: batch.status,
    itemCount: numberValue(batch.item_count),
    startedAt: batch.started_at,
    finalizedAt: batch.finalized_at,
  },
  replayed,
}, replayed ? 200 : 201);

const getReturnBatchByCommand = (
  env: Env,
  commandId: string,
  commandType: string,
): Promise<ReturnBatchRow | null> => env.DB.prepare(
  `SELECT rb.id, rb.event_id, rb.status, rb.started_at, rb.finalized_at,
          (SELECT COUNT(*) FROM return_batch_items i
            WHERE i.batch_id = rb.id AND i.undone_at IS NULL) AS item_count
     FROM race_commands c
     JOIN return_batches rb ON rb.id = c.result_id AND rb.event_id = c.event_id
    WHERE c.id = ? AND c.command_type = ?
    LIMIT 1`,
).bind(commandId, commandType).first<ReturnBatchRow>();

const createReturnBatch = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  if (typeof commandId !== "string" || !isCommandId(commandId)) {
    return json({ error: "A valid command identifier is required." }, 400);
  }

  const existing = await findCommand(env, commandId);
  if (existing !== null) {
    if (existing.event_id !== eventId || existing.command_type !== "CREATE_RETURN_BATCH") {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getReturnBatchByCommand(env, commandId, "CREATE_RETURN_BATCH");
    return replay === null ? json({ error: "The saved batch could not be loaded." }, 409) : returnBatchResponse(replay, true);
  }

  const event = await getEventState(env, eventId);
  if (event === null) return json({ error: "Event not found." }, 404);
  if (!(["COMPLETED", "RETURN_PROCESSING"].includes(event.status)) || event.purge_status !== null) {
    return json({ error: "Return batches require a completed, writable event." }, 409);
  }

  const batchId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, e.id, 'CREATE_RETURN_BATCH', ?, ?, ?
           FROM events e
           LEFT JOIN event_purge_claims epc ON epc.event_id = e.id
          WHERE e.id = ? AND e.status IN ('COMPLETED', 'RETURN_PROCESSING')
            AND epc.event_id IS NULL`,
      ).bind(commandId, batchId, now, now, eventId),
      env.DB.prepare(
        `INSERT INTO return_batches
          (id, event_id, status, source_command_id, started_by_staff_profile_id, started_at, updated_at)
         SELECT ?, ?, 'OPEN', ?, ?, ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = 'CREATE_RETURN_BATCH'`,
      ).bind(batchId, eventId, commandId, actor.id, now, now, commandId, eventId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'RETURN_BATCH_CREATED', 'RETURN_BATCH', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = 'CREATE_RETURN_BATCH'`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, batchId, now,
        JSON.stringify({ staff_profile_id: actor.id }), commandId, eventId,
      ),
    ]);
  } catch {
    const replay = await getReturnBatchByCommand(env, commandId, "CREATE_RETURN_BATCH");
    return replay === null
      ? json({ error: "The return batch conflicted with another update." }, 409)
      : returnBatchResponse(replay, true);
  }

  const saved = await getReturnBatchByCommand(env, commandId, "CREATE_RETURN_BATCH");
  return saved === null
    ? json({ error: "The event is no longer available for returns." }, 409)
    : returnBatchResponse(saved, false);
};

interface ReturnItemRow {
  id: string;
  batch_id: string;
  event_id: string;
  sequence_number: number;
  disposition: DuckDisposition;
  visible_number: number;
  undone_at: string | null;
}

const returnItemResponse = (item: ReturnItemRow, replayed: boolean): Response => json({
  item: {
    id: item.id,
    batchId: item.batch_id,
    sequence: item.sequence_number,
    visibleNumber: item.visible_number,
    disposition: item.disposition,
    undone: item.undone_at !== null,
  },
  replayed,
}, replayed ? 200 : 201);

const getReturnItemByCommand = (
  env: Env,
  commandId: string,
  commandType: "ADD_RETURN_BATCH_ITEM" | "UNDO_RETURN_BATCH_ITEM",
): Promise<ReturnItemRow | null> => env.DB.prepare(
  `SELECT i.id, i.batch_id, i.event_id, i.sequence_number, i.disposition,
          d.visible_number, i.undone_at
     FROM race_commands c
     JOIN return_batch_items i ON i.id = c.result_id AND i.event_id = c.event_id
     JOIN event_ducks ed ON ed.id = i.event_duck_id AND ed.event_id = i.event_id
     JOIN ducks d ON d.id = ed.duck_id
    WHERE c.id = ? AND c.command_type = ?
    LIMIT 1`,
).bind(commandId, commandType).first<ReturnItemRow>();

const addReturnBatchItem = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  batchId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const visibleNumber = payload?.visibleNumber;
  const dispositionValue = payload?.disposition ?? "RETURNED";
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || typeof visibleNumber !== "number" || !Number.isSafeInteger(visibleNumber)
    || visibleNumber < 1 || visibleNumber > 999_999_999
    || typeof dispositionValue !== "string" || !(dispositionValue in dispositionInventoryStatus)
  ) {
    return json({ error: "Command, visible duck number, and valid disposition are required." }, 400);
  }
  const disposition = dispositionValue as DuckDisposition;

  const existing = await findCommand(env, commandId);
  if (existing !== null) {
    if (existing.event_id !== eventId || existing.command_type !== "ADD_RETURN_BATCH_ITEM") {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getReturnItemByCommand(env, commandId, "ADD_RETURN_BATCH_ITEM");
    if (
      replay === null || replay.batch_id !== batchId || replay.visible_number !== visibleNumber
      || replay.disposition !== disposition
    ) {
      return json({ error: "The replayed command does not match this batch item." }, 409);
    }
    return returnItemResponse(replay, true);
  }

  const context = await env.DB.prepare(
    `SELECT ed.id AS event_duck_id
       FROM return_batches rb
       JOIN events e ON e.id = rb.event_id
       JOIN event_ducks ed ON ed.event_id = rb.event_id AND ed.released_at IS NULL
       JOIN ducks d ON d.id = ed.duck_id AND d.visible_number = ?
       LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
       LEFT JOIN event_purge_claims epc ON epc.event_id = rb.event_id
      WHERE rb.id = ? AND rb.event_id = ? AND rb.status = 'OPEN'
        AND e.status IN ('COMPLETED', 'RETURN_PROCESSING')
        AND ded.id IS NULL AND epc.event_id IS NULL
      LIMIT 1`,
  ).bind(visibleNumber, batchId, eventId).first<{ event_duck_id: string }>();
  if (context === null) {
    return json({ error: "The open batch or unresolved event duck was not found." }, 409);
  }

  const itemId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
          SELECT ?, rb.event_id, 'ADD_RETURN_BATCH_ITEM', ?, ?, ?
            FROM return_batches rb
            JOIN events e ON e.id = rb.event_id
            JOIN event_ducks ed
              ON ed.id = ? AND ed.event_id = rb.event_id AND ed.released_at IS NULL
            LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
            LEFT JOIN event_purge_claims epc ON epc.event_id = rb.event_id
           WHERE rb.id = ? AND rb.event_id = ? AND rb.status = 'OPEN'
             AND e.status IN ('COMPLETED', 'RETURN_PROCESSING')
             AND ded.id IS NULL AND epc.event_id IS NULL`,
      ).bind(commandId, itemId, now, now, context.event_duck_id, batchId, eventId),
      env.DB.prepare(
        `INSERT INTO return_batch_items
          (id, event_id, batch_id, event_duck_id, sequence_number, disposition,
           source_command_id, added_by_staff_profile_id, added_at)
         SELECT ?, ?, rb.id, ?, COALESCE(MAX(i.sequence_number), 0) + 1, ?, ?, ?, ?
           FROM return_batches rb
           LEFT JOIN return_batch_items i ON i.batch_id = rb.id
          WHERE rb.id = ? AND rb.event_id = ? AND rb.status = 'OPEN'
            AND EXISTS (
              SELECT 1 FROM race_commands c
               WHERE c.id = ? AND c.command_type = 'ADD_RETURN_BATCH_ITEM'
            )
          GROUP BY rb.id`,
      ).bind(
        itemId, eventId, context.event_duck_id, disposition, commandId, actor.id, now,
        batchId, eventId, commandId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'RETURN_BATCH_ITEM_ADDED', 'RETURN_BATCH_ITEM', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = 'ADD_RETURN_BATCH_ITEM'`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, itemId, now,
        JSON.stringify({ staff_profile_id: actor.id, batch_id: batchId, visible_number: visibleNumber, disposition }),
        commandId, eventId,
      ),
    ]);
  } catch {
    const replay = await getReturnItemByCommand(env, commandId, "ADD_RETURN_BATCH_ITEM");
    return replay === null
      ? json({ error: "That duck is already staged or the batch changed. Refresh and try again." }, 409)
      : returnItemResponse(replay, true);
  }

  const saved = await getReturnItemByCommand(env, commandId, "ADD_RETURN_BATCH_ITEM");
  return saved === null
    ? json({ error: "The batch changed before this duck could be added." }, 409)
    : returnItemResponse(saved, false);
};

const undoLastReturnBatchItem = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  batchId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  if (typeof commandId !== "string" || !isCommandId(commandId)) {
    return json({ error: "A valid command identifier is required." }, 400);
  }

  const existing = await findCommand(env, commandId);
  if (existing !== null) {
    if (existing.event_id !== eventId || existing.command_type !== "UNDO_RETURN_BATCH_ITEM") {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getReturnItemByCommand(env, commandId, "UNDO_RETURN_BATCH_ITEM");
    return replay === null || replay.batch_id !== batchId
      ? json({ error: "The replayed command does not match this return batch." }, 409)
      : returnItemResponse(replay, true);
  }

  const item = await env.DB.prepare(
    `SELECT i.id, i.batch_id, i.event_id, i.sequence_number, i.disposition,
            d.visible_number, i.undone_at
       FROM return_batch_items i
       JOIN return_batches rb ON rb.id = i.batch_id AND rb.event_id = i.event_id
       JOIN event_ducks ed ON ed.id = i.event_duck_id AND ed.event_id = i.event_id
       JOIN ducks d ON d.id = ed.duck_id
       LEFT JOIN event_purge_claims epc ON epc.event_id = i.event_id
      WHERE i.batch_id = ? AND i.event_id = ? AND i.undone_at IS NULL
        AND rb.status = 'OPEN' AND epc.event_id IS NULL
      ORDER BY i.sequence_number DESC
      LIMIT 1`,
  ).bind(batchId, eventId).first<ReturnItemRow>();
  if (item === null) return json({ error: "The open batch has no item to undo." }, 409);

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, i.event_id, 'UNDO_RETURN_BATCH_ITEM', i.id, ?, ?
           FROM return_batch_items i
           JOIN return_batches rb ON rb.id = i.batch_id AND rb.event_id = i.event_id
           LEFT JOIN event_purge_claims epc ON epc.event_id = i.event_id
          WHERE i.id = ? AND i.batch_id = ? AND i.event_id = ? AND i.undone_at IS NULL
            AND rb.status = 'OPEN' AND epc.event_id IS NULL`,
      ).bind(commandId, now, now, item.id, batchId, eventId),
      env.DB.prepare(
        `UPDATE return_batch_items
            SET undo_command_id = ?, undone_by_staff_profile_id = ?, undone_at = ?
          WHERE id = ? AND batch_id = ? AND event_id = ? AND undone_at IS NULL
            AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'UNDO_RETURN_BATCH_ITEM')`,
      ).bind(commandId, actor.id, now, item.id, batchId, eventId, commandId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'RETURN_BATCH_ITEM_UNDONE', 'RETURN_BATCH_ITEM', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = 'UNDO_RETURN_BATCH_ITEM'`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, item.id, now,
        JSON.stringify({ staff_profile_id: actor.id, batch_id: batchId, visible_number: item.visible_number }),
        commandId, eventId,
      ),
    ]);
  } catch {
    return json({ error: "The last batch item changed before it could be undone." }, 409);
  }

  const saved = await getReturnItemByCommand(env, commandId, "UNDO_RETURN_BATCH_ITEM");
  return saved === null
    ? json({ error: "The last batch item changed before it could be undone." }, 409)
    : returnItemResponse(saved, false);
};

const finalizeReturnBatch = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  batchId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  if (typeof commandId !== "string" || !isCommandId(commandId)) {
    return json({ error: "A valid command identifier is required." }, 400);
  }

  const existing = await findCommand(env, commandId);
  if (existing !== null) {
    if (existing.event_id !== eventId || existing.command_type !== "FINALIZE_RETURN_BATCH") {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const replay = await getReturnBatchByCommand(env, commandId, "FINALIZE_RETURN_BATCH");
    return replay === null || replay.id !== batchId
      ? json({ error: "The replayed command does not match this return batch." }, 409)
      : returnBatchResponse(replay, true);
  }

  const batch = await env.DB.prepare(
    `SELECT rb.id, rb.event_id, rb.status, rb.started_at, rb.finalized_at,
            COUNT(i.id) AS item_count
       FROM return_batches rb
       JOIN events e ON e.id = rb.event_id
       LEFT JOIN return_batch_items i ON i.batch_id = rb.id AND i.undone_at IS NULL
       LEFT JOIN event_purge_claims epc ON epc.event_id = rb.event_id
      WHERE rb.id = ? AND rb.event_id = ? AND rb.status = 'OPEN'
        AND e.status IN ('COMPLETED', 'RETURN_PROCESSING') AND epc.event_id IS NULL
      GROUP BY rb.id
      LIMIT 1`,
  ).bind(batchId, eventId).first<ReturnBatchRow>();
  if (batch === null) return json({ error: "Open return batch not found." }, 409);
  if (numberValue(batch.item_count) === 0) return json({ error: "Add at least one duck before finalizing the batch." }, 409);

  const now = new Date().toISOString();
  const inventoryCase = `CASE (
    SELECT i.disposition FROM return_batch_items i
    JOIN event_ducks item_ed ON item_ed.id = i.event_duck_id AND item_ed.event_id = i.event_id
    WHERE i.batch_id = ? AND i.undone_at IS NULL AND item_ed.duck_id = ducks.id
    LIMIT 1
  )
    WHEN 'RETURNED' THEN 'AVAILABLE'
    WHEN 'KEPT' THEN 'KEPT'
    WHEN 'MISSING' THEN 'MISSING'
    WHEN 'DAMAGED' THEN 'DAMAGED'
    WHEN 'QUARANTINED' THEN 'QUARANTINED'
    WHEN 'RETIRED' THEN 'RETIRED'
    WHEN 'UNACCOUNTED_FOR' THEN 'UNACCOUNTED_FOR'
  END`;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE return_batches
            SET status = 'FINALIZING', finalize_command_id = ?,
                finalized_by_staff_profile_id = ?, updated_at = ?
          WHERE id = ? AND event_id = ? AND status = 'OPEN'
            AND EXISTS (SELECT 1 FROM return_batch_items WHERE batch_id = ? AND undone_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM event_purge_claims WHERE event_id = ?)`,
      ).bind(commandId, actor.id, now, batchId, eventId, batchId, eventId),
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT ?, rb.event_id, 'FINALIZE_RETURN_BATCH', rb.id, ?, ?
           FROM return_batches rb
          WHERE rb.id = ? AND rb.event_id = ? AND rb.status = 'FINALIZING'
            AND rb.finalize_command_id = ?`,
      ).bind(commandId, now, now, batchId, eventId, commandId),
      env.DB.prepare(
        `INSERT INTO duck_event_dispositions
          (id, event_id, event_duck_id, disposition, recorded_by_staff_profile_id,
           source_command_id, recorded_at)
         SELECT lower(hex(randomblob(16))), i.event_id, i.event_duck_id, i.disposition, ?, ?, ?
           FROM return_batch_items i
           JOIN race_commands c ON c.id = ? AND c.event_id = i.event_id
          WHERE i.batch_id = ? AND i.event_id = ? AND i.undone_at IS NULL`,
      ).bind(actor.id, commandId, now, commandId, batchId, eventId),
      env.DB.prepare(
        `UPDATE duck_assignments
            SET valid_to = ?,
                end_reason = (SELECT i.disposition FROM return_batch_items i
                               WHERE i.batch_id = ? AND i.undone_at IS NULL
                                 AND i.event_duck_id = duck_assignments.event_duck_id LIMIT 1),
                ended_by_staff_profile_id = ?
          WHERE event_id = ? AND valid_to IS NULL
            AND event_duck_id IN (
              SELECT i.event_duck_id FROM return_batch_items i
               WHERE i.batch_id = ? AND i.undone_at IS NULL
            )
            AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'FINALIZE_RETURN_BATCH')`,
      ).bind(now, batchId, actor.id, eventId, batchId, commandId),
      env.DB.prepare(
        `UPDATE event_ducks
            SET released_at = ?,
                release_reason = (SELECT i.disposition FROM return_batch_items i
                                   WHERE i.batch_id = ? AND i.undone_at IS NULL
                                     AND i.event_duck_id = event_ducks.id LIMIT 1),
                released_by_staff_profile_id = ?
          WHERE event_id = ? AND released_at IS NULL
            AND id IN (SELECT event_duck_id FROM return_batch_items WHERE batch_id = ? AND undone_at IS NULL)
            AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'FINALIZE_RETURN_BATCH')`,
      ).bind(now, batchId, actor.id, eventId, batchId, commandId),
      env.DB.prepare(
        `UPDATE ducks
            SET inventory_status = ${inventoryCase}, inventory_status_changed_at = ?,
                updated_at = ?, revision = revision + 1
          WHERE id IN (
            SELECT ed.duck_id FROM event_ducks ed
            JOIN return_batch_items i ON i.event_duck_id = ed.id AND i.event_id = ed.event_id
            WHERE i.batch_id = ? AND i.undone_at IS NULL
          )
          AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'FINALIZE_RETURN_BATCH')`,
      ).bind(batchId, now, now, batchId, commandId),
      env.DB.prepare(
        `UPDATE events SET status = 'RETURN_PROCESSING', updated_at = ?
          WHERE id = ? AND status IN ('COMPLETED', 'RETURN_PROCESSING')
            AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'FINALIZE_RETURN_BATCH')`,
      ).bind(now, eventId, commandId),
      env.DB.prepare(
        `UPDATE return_batches
            SET status = 'FINALIZED', finalized_at = ?, updated_at = ?
          WHERE id = ? AND event_id = ? AND status = 'FINALIZING' AND finalize_command_id = ?
            AND EXISTS (SELECT 1 FROM race_commands WHERE id = ? AND command_type = 'FINALIZE_RETURN_BATCH')`,
      ).bind(now, now, batchId, eventId, commandId, commandId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
         SELECT ?, ?, ?, 'RETURN_BATCH_FINALIZED', 'RETURN_BATCH', ?, 'STAFF', ?, ?
           FROM race_commands
          WHERE id = ? AND event_id = ? AND command_type = 'FINALIZE_RETURN_BATCH'`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, batchId, now,
        JSON.stringify({ staff_profile_id: actor.id, item_count: numberValue(batch.item_count) }),
        commandId, eventId,
      ),
    ]);
  } catch {
    const replay = await getReturnBatchByCommand(env, commandId, "FINALIZE_RETURN_BATCH");
    return replay === null
      ? json({ error: "The batch conflicted with another disposition or return operation." }, 409)
      : returnBatchResponse(replay, true);
  }

  const saved = await getReturnBatchByCommand(env, commandId, "FINALIZE_RETURN_BATCH");
  return saved === null
    ? json({ error: "The batch changed before it could be finalized." }, 409)
    : returnBatchResponse(saved, false);
};

interface AuditTimelineRow {
  id: string;
  source: string;
  action: string;
  subject_type: string;
  subject_id: string;
  actor_type: string;
  actor_display_name: string | null;
  occurred_at: string;
  safe_code: string | null;
}

const auditTimeline = async (url: URL, env: Env, eventId: string): Promise<Response> => {
  const requestedLimit = Number(url.searchParams.get("limit") ?? 100);
  const limit = Number.isInteger(requestedLimit) && requestedLimit >= 1 && requestedLimit <= 200
    ? requestedLimit
    : 100;
  const beforeValue = url.searchParams.get("before");
  const before = beforeValue !== null && !Number.isNaN(Date.parse(beforeValue))
    ? new Date(beforeValue).toISOString()
    : null;
  if (beforeValue !== null && before === null) return json({ error: "Invalid pagination timestamp." }, 400);

  const rows = await env.DB.prepare(
    `SELECT timeline.id, timeline.source, timeline.action, timeline.subject_type,
            timeline.subject_id, timeline.actor_type, timeline.actor_display_name,
            timeline.occurred_at, timeline.safe_code
       FROM (
         SELECT a.id, 'DOMAIN' AS source, a.action, a.subject_type, a.subject_id,
                a.actor_type, sp.display_name AS actor_display_name,
                a.occurred_at, NULL AS safe_code
           FROM audit_events a
           LEFT JOIN staff_profiles sp
             ON sp.id = json_extract(a.details_json, '$.staff_profile_id')
          WHERE a.event_id = ?
         UNION ALL
         SELECT ea.id, 'NOTIFICATION_ATTEMPT' AS source,
                'NOTIFICATION_' || ea.stage || '_' || ea.status AS action,
                'EMAIL_NOTIFICATION' AS subject_type, ea.notification_id AS subject_id,
                'SYSTEM' AS actor_type, NULL AS actor_display_name,
                COALESCE(ea.completed_at, ea.started_at) AS occurred_at,
                ea.error_code AS safe_code
           FROM email_attempts ea
          WHERE ea.event_id = ?
       ) timeline
      WHERE (? IS NULL OR timeline.occurred_at < ?)
      ORDER BY timeline.occurred_at DESC, timeline.id DESC
      LIMIT ?`,
  ).bind(eventId, eventId, before, before, limit).all<AuditTimelineRow>();

  return json({
    events: rows.results.map((row) => ({
      id: row.id,
      source: row.source,
      action: row.action,
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      actorType: row.actor_type,
      actorDisplayName: row.actor_display_name,
      occurredAt: row.occurred_at,
      code: row.safe_code,
    })),
  });
};

interface PurgeGateCounts {
  other_event_count: number;
  blocking_heat_count: number;
  pending_command_count: number;
  nonterminal_notification_count: number;
  unresolved_disposition_count: number;
  unreleased_reservation_count: number;
  active_assignment_count: number;
  open_return_batch_count: number;
}

const getPurgeGateCounts = (env: Env, eventId: string): Promise<PurgeGateCounts | null> =>
  env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM events other WHERE other.id != e.id) AS other_event_count,
       (SELECT COUNT(*) FROM heats h
         WHERE h.event_id = e.id AND h.status IN ('RUNNING', 'AWAITING_RESULT')) AS blocking_heat_count,
       (SELECT COUNT(*) FROM race_commands c
         WHERE c.event_id = e.id AND c.completed_at IS NULL) AS pending_command_count,
       (SELECT COUNT(*) FROM email_notifications n
         WHERE n.event_id = e.id
           AND n.status NOT IN ('DELIVERED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'CANCELLED')) AS nonterminal_notification_count,
       (SELECT COUNT(*) FROM event_ducks ed
         LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
         WHERE ed.event_id = e.id AND ded.id IS NULL) AS unresolved_disposition_count,
       (SELECT COUNT(*) FROM event_ducks ed
         WHERE ed.event_id = e.id AND ed.released_at IS NULL) AS unreleased_reservation_count,
       (SELECT COUNT(*) FROM duck_assignments da
         WHERE da.event_id = e.id AND da.valid_to IS NULL) AS active_assignment_count,
       (SELECT COUNT(*) FROM return_batches rb
         WHERE rb.event_id = e.id AND rb.status IN ('OPEN', 'FINALIZING')) AS open_return_batch_count
      FROM events e
     WHERE e.id = ?
     LIMIT 1`,
  ).bind(eventId).first<PurgeGateCounts>();

const purgeGateSummary = async (env: Env, eventId: string): Promise<Response> => {
  const event = await env.DB.prepare(
    `SELECT e.id, e.name, e.status, epc.status AS purge_status,
            epc.claimed_at, sp.display_name AS claimed_by
       FROM events e
       LEFT JOIN event_purge_claims epc ON epc.event_id = e.id
       LEFT JOIN staff_profiles sp ON sp.id = epc.claimed_by_staff_profile_id
      WHERE e.id = ?
      LIMIT 1`,
  ).bind(eventId).first<{
    id: string;
    name: string;
    status: string;
    purge_status: string | null;
    claimed_at: string | null;
    claimed_by: string | null;
  }>();
  if (event === null) return json({ error: "Event not found." }, 404);
  const counts = await getPurgeGateCounts(env, eventId);
  if (counts === null) return json({ error: "Event not found." }, 404);

  const blockers = {
    eventNotArchived: event.status !== "ARCHIVED",
    otherEvents: numberValue(counts.other_event_count),
    blockingHeats: numberValue(counts.blocking_heat_count),
    pendingCommands: numberValue(counts.pending_command_count),
    nonterminalNotifications: numberValue(counts.nonterminal_notification_count),
    unresolvedDispositions: numberValue(counts.unresolved_disposition_count),
    unreleasedReservations: numberValue(counts.unreleased_reservation_count),
    activeAssignments: numberValue(counts.active_assignment_count),
    openReturnBatches: numberValue(counts.open_return_batch_count),
  };
  const ready = !blockers.eventNotArchived
    && Object.entries(blockers).every(([key, value]) => key === "eventNotArchived" || value === 0)
    && event.purge_status === null;
  return json({
    event: { id: event.id, name: event.name, status: event.status },
    ready,
    blockers,
    claim: event.purge_status === null ? null : {
      status: event.purge_status,
      claimedAt: event.claimed_at,
      claimedBy: event.claimed_by,
    },
  });
};

const claimEventPurge = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const confirmation = payload?.confirmation;
  if (typeof commandId !== "string" || !isCommandId(commandId) || typeof confirmation !== "string") {
    return json({ error: "A valid command and typed purge confirmation are required." }, 400);
  }
  const event = await env.DB.prepare(
    "SELECT id, name, status FROM events WHERE id = ? LIMIT 1",
  ).bind(eventId).first<{ id: string; name: string; status: string }>();
  if (event === null) return json({ error: "Event not found." }, 404);
  if (confirmation !== `DELETE ${event.name}`) {
    return json({ error: `Type DELETE ${event.name} to confirm permanent deletion.` }, 422);
  }

  const existingClaim = await env.DB.prepare(
    `SELECT command_id, status, claimed_at
       FROM event_purge_claims
      WHERE event_id = ?
      LIMIT 1`,
  ).bind(eventId).first<{ command_id: string; status: string; claimed_at: string }>();
  if (existingClaim !== null) {
    return existingClaim.command_id === commandId
      ? json({ eventId, status: existingClaim.status, claimedAt: existingClaim.claimed_at, replayed: true })
      : json({ error: "This event already has an active purge claim." }, 409);
  }

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO event_purge_claims
          (event_id, command_id, status, claimed_by_staff_profile_id, claimed_at)
         SELECT e.id, ?, 'PURGING', ?, ?
           FROM events e
          WHERE e.id = ? AND e.status = 'ARCHIVED'
            AND NOT EXISTS (SELECT 1 FROM events other WHERE other.id != e.id)
            AND NOT EXISTS (SELECT 1 FROM heats h WHERE h.event_id = e.id AND h.status IN ('RUNNING', 'AWAITING_RESULT'))
            AND NOT EXISTS (SELECT 1 FROM race_commands c WHERE c.event_id = e.id AND c.completed_at IS NULL)
            AND NOT EXISTS (
              SELECT 1 FROM email_notifications n WHERE n.event_id = e.id
                AND n.status NOT IN ('DELIVERED', 'FAILED', 'BOUNCED', 'COMPLAINED', 'SUPPRESSED', 'CANCELLED')
            )
            AND NOT EXISTS (
              SELECT 1 FROM event_ducks ed
              LEFT JOIN duck_event_dispositions ded ON ded.event_duck_id = ed.id
              WHERE ed.event_id = e.id AND ded.id IS NULL
            )
            AND NOT EXISTS (SELECT 1 FROM event_ducks ed WHERE ed.event_id = e.id AND ed.released_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM duck_assignments da WHERE da.event_id = e.id AND da.valid_to IS NULL)
            AND NOT EXISTS (SELECT 1 FROM return_batches rb WHERE rb.event_id = e.id AND rb.status IN ('OPEN', 'FINALIZING'))
            AND NOT EXISTS (SELECT 1 FROM event_purge_claims epc WHERE epc.event_id = e.id)`,
      ).bind(commandId, actor.id, now, eventId),
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at)
         SELECT epc.command_id, epc.event_id, 'CLAIM_EVENT_PURGE', epc.event_id, epc.claimed_at, epc.claimed_at
           FROM event_purge_claims epc
          WHERE epc.event_id = ? AND epc.command_id = ?`,
      ).bind(eventId, commandId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id, actor_type, occurred_at, details_json)
         SELECT ?, epc.event_id, epc.command_id, 'EVENT_PURGE_CLAIMED', 'EVENT', epc.event_id, 'STAFF', epc.claimed_at, ?
           FROM event_purge_claims epc
          WHERE epc.event_id = ? AND epc.command_id = ?`,
      ).bind(
        crypto.randomUUID(), JSON.stringify({ staff_profile_id: actor.id }), eventId, commandId,
      ),
    ]);
  } catch {
    return json({ error: "The purge claim conflicted with another operation." }, 409);
  }

  const claim = await env.DB.prepare(
    `SELECT command_id, status, claimed_at
       FROM event_purge_claims
      WHERE event_id = ? AND command_id = ?
      LIMIT 1`,
  ).bind(eventId, commandId).first<{ command_id: string; status: string; claimed_at: string }>();
  if (claim === null) {
    const gateResponse = await purgeGateSummary(env, eventId);
    const gate = await gateResponse.json<Record<string, unknown>>();
    return json({ error: "The event is not purge-ready.", gate }, 409);
  }
  return json({ eventId, status: claim.status, claimedAt: claim.claimed_at, replayed: false }, 201);
};

export const handleSupportOperations = async (
  request: Request,
  env: Env,
  actor: StaffActor,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const prefix = "/api/v1/staff/support";
  if (!url.pathname.startsWith(`${prefix}/`)) return null;

  const summaryMatch = url.pathname.match(/^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/summary$/);
  if (summaryMatch !== null && request.method === "GET") {
    const denied = adminRequired(actor);
    return denied ?? operationalSummary(env, summaryMatch[1]);
  }

  const auditMatch = url.pathname.match(/^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/audit$/);
  if (auditMatch !== null && request.method === "GET") {
    const denied = adminRequired(actor);
    return denied ?? auditTimeline(url, env, auditMatch[1]);
  }

  const purgeGateMatch = url.pathname.match(/^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/purge-gate$/);
  if (purgeGateMatch !== null && request.method === "GET") {
    const denied = adminRequired(actor);
    return denied ?? purgeGateSummary(env, purgeGateMatch[1]);
  }

  const purgeClaimMatch = url.pathname.match(/^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/purge-claim$/);
  if (purgeClaimMatch !== null && request.method === "POST") {
    const denied = adminRequired(actor);
    return denied ?? claimEventPurge(request, env, actor, purgeClaimMatch[1]);
  }

  const notificationAttemptsMatch = url.pathname.match(
    /^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/notifications\/([A-Za-z0-9_-]{1,128})\/attempts$/,
  );
  if (notificationAttemptsMatch !== null && request.method === "GET") {
    const denied = adminRequired(actor);
    return denied ?? listNotificationAttempts(env, notificationAttemptsMatch[1], notificationAttemptsMatch[2]);
  }

  const notificationActionMatch = url.pathname.match(
    /^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/notifications\/([A-Za-z0-9_-]{1,128})\/(retry|suppress|cancel)$/,
  );
  if (notificationActionMatch !== null && request.method === "POST") {
    const denied = adminRequired(actor);
    if (denied !== null) return denied;
    const [, eventId, notificationId, action] = notificationActionMatch;
    if (!validPathId(eventId) || !validPathId(notificationId)) return json({ error: "Invalid path identifier." }, 400);
    if (action === "retry") return retryNotification(request, env, actor, eventId, notificationId);
    return terminalNotificationAction(
      request,
      env,
      actor,
      eventId,
      notificationId,
      action === "suppress" ? "SUPPRESS" : "CANCEL",
    );
  }

  const notificationsMatch = url.pathname.match(
    /^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/notifications$/,
  );
  if (notificationsMatch !== null && request.method === "GET") {
    const denied = adminRequired(actor);
    return denied ?? listNotifications(url, env, notificationsMatch[1]);
  }

  const returnItemMatch = url.pathname.match(
    /^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/return-batches\/([A-Za-z0-9_-]{1,128})\/items$/,
  );
  if (returnItemMatch !== null && request.method === "POST") {
    return addReturnBatchItem(request, env, actor, returnItemMatch[1], returnItemMatch[2]);
  }

  const undoReturnMatch = url.pathname.match(
    /^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/return-batches\/([A-Za-z0-9_-]{1,128})\/undo-last$/,
  );
  if (undoReturnMatch !== null && request.method === "POST") {
    return undoLastReturnBatchItem(request, env, actor, undoReturnMatch[1], undoReturnMatch[2]);
  }

  const finalizeReturnMatch = url.pathname.match(
    /^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/return-batches\/([A-Za-z0-9_-]{1,128})\/finalize$/,
  );
  if (finalizeReturnMatch !== null && request.method === "POST") {
    return finalizeReturnBatch(request, env, actor, finalizeReturnMatch[1], finalizeReturnMatch[2]);
  }

  const returnBatchMatch = url.pathname.match(
    /^\/api\/v1\/staff\/support\/events\/([A-Za-z0-9_-]{1,128})\/return-batches$/,
  );
  if (returnBatchMatch !== null && request.method === "POST") {
    return createReturnBatch(request, env, actor, returnBatchMatch[1]);
  }

  return null;
};
