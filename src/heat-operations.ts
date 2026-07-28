import type { StaffActor } from "./auth.ts";
import { requireAnyRole } from "./authorization.ts";
import { publicDisplayName } from "./race-board.ts";
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

const readJson = async (request: Request): Promise<Record<string, unknown> | null> => {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const length = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(length) && length > 16_384) return null;
  try {
    const text = await request.text();
    if (text.length > 16_384) return null;
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

const fingerprint = async (value: unknown): Promise<string> => {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const validRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const reasonFrom = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const reason = value.trim().replace(/\s+/g, " ");
  return reason.length >= 4 && reason.length <= 500 ? reason : null;
};

type Round = "ROUND_ONE" | "FINAL";

interface CommandRow {
  event_id: string;
  command_type: string;
  result_id: string | null;
  request_fingerprint: string | null;
}

const findCommand = (env: Env, commandId: string): Promise<CommandRow | null> =>
  env.DB.prepare(
    `SELECT event_id, command_type, result_id, request_fingerprint
       FROM race_commands
      WHERE id = ?`,
  ).bind(commandId).first<CommandRow>();

const commandMatches = (
  command: CommandRow,
  eventId: string,
  heatId: string,
  type: string,
  requestFingerprint: string,
): boolean => command.event_id === eventId
  && command.result_id === heatId
  && command.command_type === type
  && command.request_fingerprint === requestFingerprint;

interface HeatSummaryRow {
  id: string;
  event_id: string;
  round: Round;
  heat_number: number;
  status: string;
  target_size: number | null;
  revision: number;
  roster_locked_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  finalized_at: string | null;
  roster_size: number;
  published_result_count: number;
}

const heatSummary = (row: HeatSummaryRow): Record<string, unknown> => ({
  id: row.id,
  eventId: row.event_id,
  round: row.round,
  number: row.heat_number,
  status: row.status,
  targetSize: row.target_size,
  rosterSize: row.roster_size,
  publishedResultCount: row.published_result_count,
  revision: row.revision,
  rosterLocked: row.roster_locked_at !== null,
  rosterLockedAt: row.roster_locked_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  finalizedAt: row.finalized_at,
});

const heatSummarySql = `SELECT h.id, h.event_id, h.round, h.heat_number, h.status,
       h.target_size, h.revision, h.roster_locked_at, h.started_at,
       h.finished_at, h.finalized_at,
       (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) AS roster_size,
       (SELECT COUNT(*) FROM heat_results hr
         WHERE hr.heat_id = h.id AND hr.status = 'FINALIZED') AS published_result_count
  FROM heats h`;

const getHeatSummary = (
  env: Env,
  eventId: string,
  heatId: string,
): Promise<HeatSummaryRow | null> => env.DB.prepare(
  `${heatSummarySql} WHERE h.event_id = ? AND h.id = ? LIMIT 1`,
).bind(eventId, heatId).first<HeatSummaryRow>();

const listHeats = async (env: Env, eventId: string): Promise<Response> => {
  const event = await env.DB.prepare(
    "SELECT id, name, status FROM events WHERE id = ?",
  ).bind(eventId).first<{ id: string; name: string; status: string }>();
  if (event === null) return json({ error: "Event not found." }, 404);
  const heats = await env.DB.prepare(
    `${heatSummarySql}
      WHERE h.event_id = ?
      ORDER BY CASE h.round WHEN 'ROUND_ONE' THEN 0 ELSE 1 END, h.heat_number`,
  ).bind(eventId).all<HeatSummaryRow>();
  return json({ event, heats: heats.results.map(heatSummary) });
};

interface RosterRow {
  heat_entry_id: string;
  race_entry_id: string;
  slot_number: number;
  assignment_source: string;
  registration_id: string;
  first_name: string;
  last_name: string;
  registration_status: string;
  duck_assignment_id: string | null;
  duck_id: string | null;
  visible_number: number | null;
}

// The registration and duck identifiers are the console's existing selection
// keys for the participant and inventory sections, so a roster entry can link
// straight into them. They are internal identifiers, not participant contact
// data, and the duck join already excludes closed assignments.
const rosterSql = `SELECT he.id AS heat_entry_id, he.race_entry_id, he.slot_number,
       he.assignment_source, r.id AS registration_id, r.first_name, r.last_name,
       r.status AS registration_status, da.id AS duck_assignment_id,
       da.duck_id, d.visible_number
  FROM heat_entries he
  JOIN race_entries re ON re.id = he.race_entry_id
  JOIN registrations r ON r.id = re.registration_id
   LEFT JOIN duck_assignments da ON da.id = (
     SELECT da2.id FROM duck_assignments da2
      WHERE da2.event_id = he.event_id AND da2.race_entry_id = he.race_entry_id
        AND da2.valid_to IS NULL
      ORDER BY da2.valid_from DESC LIMIT 1
   )
  LEFT JOIN ducks d ON d.id = da.duck_id
 WHERE he.event_id = ? AND he.heat_id = ?
 ORDER BY he.slot_number`;

interface PublishedResultRow {
  id: string;
  race_entry_id: string;
  place: number;
  revision: number;
  finalized_at: string;
  first_name: string;
  last_name: string;
  visible_number: number;
  source_command_id: string;
}

const publishedResults = (
  env: Env,
  eventId: string,
  heatId: string,
): Promise<D1Result<PublishedResultRow>> => env.DB.prepare(
  `SELECT hr.id, hr.race_entry_id, hr.place, hr.revision, hr.finalized_at,
          hr.source_command_id, r.first_name, r.last_name, d.visible_number
     FROM heat_results hr
     JOIN race_entries re ON re.id = hr.race_entry_id
     JOIN registrations r ON r.id = re.registration_id
     JOIN duck_assignments da ON da.id = hr.duck_assignment_id
     JOIN ducks d ON d.id = da.duck_id
    WHERE hr.event_id = ? AND hr.heat_id = ? AND hr.status = 'FINALIZED'
    ORDER BY hr.place`,
).bind(eventId, heatId).all<PublishedResultRow>();

const rosterResponse = (row: RosterRow): Record<string, unknown> => ({
  heatEntryId: row.heat_entry_id,
  raceEntryId: row.race_entry_id,
  slotNumber: row.slot_number,
  assignmentSource: row.assignment_source,
  participant: {
    registrationId: row.registration_id,
    firstName: row.first_name,
    lastName: row.last_name,
    registrationStatus: row.registration_status,
  },
  duck: row.visible_number === null
    ? null
    : { id: row.duck_id, visibleNumber: row.visible_number },
});

const resultResponseRow = (row: PublishedResultRow): Record<string, unknown> => ({
  id: row.id,
  raceEntryId: row.race_entry_id,
  place: row.place,
  revision: row.revision,
  finalizedAt: row.finalized_at,
  participant: { firstName: row.first_name, lastName: row.last_name },
  duck: { visibleNumber: row.visible_number },
});

const getHeatDetail = async (env: Env, eventId: string, heatId: string): Promise<Response> => {
  const heat = await getHeatSummary(env, eventId, heatId);
  if (heat === null) return json({ error: "Heat not found." }, 404);
  const [roster, results] = await Promise.all([
    env.DB.prepare(rosterSql).bind(eventId, heatId).all<RosterRow>(),
    publishedResults(env, eventId, heatId),
  ]);
  return json({
    heat: heatSummary(heat),
    roster: roster.results.map(rosterResponse),
    results: results.results.map(resultResponseRow),
  });
};

// The announcer projection is deliberately slot, participant name, and duck
// number, and it deliberately does NOT carry the participant-chosen duck name
// even though that name is now public everywhere else.
//
// This station is a script for someone holding a live microphone. Reading a name
// out loud is the one place where a name that slipped past the filter stops
// being text a visitor can look away from and becomes a public-address
// announcement to a family event, with no undo and no moderation step in
// between. The board, the duck pages, and the search results are all filtered
// text that staff can clear in seconds; a spoken word cannot be cleared at all.
//
// The number is also what the announcer actually needs: the roster is read out
// to line racers up against the duck in the water, and a chosen name is one more
// ambiguous token to get wrong at volume. Nothing is lost by leaving it out —
// the announcer can see it on the participant console if they ever need it.
const announcerRoster = async (env: Env, eventId: string, heatId: string): Promise<Response> => {
  const heat = await getHeatSummary(env, eventId, heatId);
  if (heat === null) return json({ error: "Heat not found." }, 404);
  const roster = await env.DB.prepare(rosterSql).bind(eventId, heatId).all<RosterRow>();
  return json({
    heat: heatSummary(heat),
    roster: roster.results.map((row) => ({
      slotNumber: row.slot_number,
      raceEntryId: row.race_entry_id,
      displayName: `${row.first_name} ${row.last_name}`,
      duckNumber: row.visible_number,
    })),
  });
};

const finishScan = async (url: URL, env: Env, eventId: string, heatId: string): Promise<Response> => {
  const value = url.searchParams.get("value")?.trim() ?? "";
  if (value.length === 0 || value.length > 512) {
    return json({ error: "Enter a duck number or the complete QuickDucks tag URL." }, 400);
  }

  let visibleNumber: number | null = null;
  let tagToken: string | null = null;
  if (/^[1-9]\d{0,8}$/.test(value)) {
    visibleNumber = Number(value);
  } else {
    try {
      const tagUrl = new URL(value);
      const match = tagUrl.pathname.match(/^\/t\/([A-Za-z0-9_-]{22,128})$/);
      if (
        tagUrl.origin !== new URL(env.APP_ORIGIN).origin
        || tagUrl.search.length > 0
        || tagUrl.hash.length > 0
        || match === null
      ) throw new Error("invalid tag URL");
      tagToken = match[1];
    } catch {
      return json({ error: "Use the complete QuickDucks tag URL or a visible duck number." }, 400);
    }
  }

  const heat = await getHeatSummary(env, eventId, heatId);
  if (heat === null) return json({ error: "Heat not found." }, 404);
  if (heat.status !== "AWAITING_RESULT") {
    return json({ error: "Mark this heat finished before scanning its result. Then scan the duck again." }, 409);
  }

  const selection = await env.DB.prepare(
    `SELECT he.race_entry_id, r.first_name, r.last_name, r.status AS registration_status,
            e.public_name_policy,
            d.visible_number
       FROM heat_entries he
       JOIN heats h ON h.id = he.heat_id AND h.event_id = he.event_id
       JOIN events e ON e.id = h.event_id
       JOIN race_entries re ON re.id = he.race_entry_id
       JOIN registrations r ON r.id = re.registration_id
       JOIN duck_assignments da
         ON da.event_id = he.event_id AND da.race_entry_id = he.race_entry_id
        AND da.valid_to IS NULL
       JOIN ducks d ON d.id = da.duck_id
       LEFT JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'ACTIVE'
      WHERE he.event_id = ? AND he.heat_id = ?
        AND ((? IS NOT NULL AND dt.token = ?) OR (? IS NOT NULL AND d.visible_number = ?))
      LIMIT 1`,
  ).bind(
    eventId,
    heatId,
    tagToken,
    tagToken,
    visibleNumber,
    visibleNumber,
  ).first<{
    race_entry_id: string;
    first_name: string;
    last_name: string;
    public_name_policy: string;
    registration_status: string;
    visible_number: number;
  }>();
  if (selection !== null) {
    if (selection.registration_status !== "ACTIVE") {
      return json({
        error: "That roster entry is no longer active. Do not record a result; ask the race director to resolve the roster.",
      }, 422);
    }
    return json({
      selection: {
        raceEntryId: selection.race_entry_id,
        participantDisplayName: publicDisplayName(
          selection.public_name_policy,
          selection.first_name,
          selection.last_name,
        ),
        visibleNumber: selection.visible_number,
      },
    });
  }

  const knownDuck = await env.DB.prepare(
    `SELECT 1 AS known
       FROM event_ducks ed
       JOIN ducks d ON d.id = ed.duck_id
       LEFT JOIN duck_tags dt ON dt.duck_id = d.id AND dt.status = 'ACTIVE'
      WHERE ed.event_id = ?
        AND ((? IS NOT NULL AND dt.token = ?) OR (? IS NOT NULL AND d.visible_number = ?))
      LIMIT 1`,
  ).bind(eventId, tagToken, tagToken, visibleNumber, visibleNumber).first<{ known: number }>();
  return knownDuck === null
    ? json({ error: "That duck was not found for this race." }, 404)
    : json({ error: "That duck is not in the selected heat." }, 422);
};

// Rosters are editable in the window before their round starts, which is the
// only window in which they are still unlocked plans: starting a round locks
// every planned heat of that round to LOADING in the same batch as the status
// change, so a heat that is PLANNED and unlocked and whose event has already
// reached that round cannot exist. Round-one rosters are therefore replaceable
// while registration is closed, and the final's roster while round one runs,
// which is exactly where the readiness blockers send an operator to remove a
// withdrawn racer or repair an undersized heat.
const rosterEditableEventStatus: Record<Round, string> = {
  ROUND_ONE: "REGISTRATION_CLOSED",
  FINAL: "ROUND_ONE",
};

const rosterCommandCommitted = `EXISTS (
    SELECT 1 FROM race_commands rc
     WHERE rc.id = ? AND rc.event_id = ? AND rc.command_type = 'REPLACE_HEAT_ROSTER'
       AND rc.result_id = ?
  )`;

const rosterWindowError: Record<Round, string> = {
  ROUND_ONE: "A round-one roster can be replaced only while registration is closed and round one has not started.",
  FINAL: "The final roster can be replaced only during round one, before the final starts.",
};

const updateRoster = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  heatId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const revision = payload?.revision;
  const raceEntryIds = payload?.raceEntryIds;
  if (
    typeof commandId !== "string" || !isCommandId(commandId) || !validRevision(revision)
    || !Array.isArray(raceEntryIds) || raceEntryIds.length === 0 || raceEntryIds.length > 200
    || raceEntryIds.some((id) => typeof id !== "string" || id.length === 0 || id.length > 128)
    || new Set(raceEntryIds).size !== raceEntryIds.length
  ) {
    return json({ error: "Command, heat revision, and a unique non-empty roster are required." }, 400);
  }
  const ids = raceEntryIds as string[];
  const requestFingerprint = await fingerprint({ heatId, ids });
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    if (!commandMatches(previous, eventId, heatId, "REPLACE_HEAT_ROSTER", requestFingerprint)) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const response = await getHeatDetail(env, eventId, heatId);
    const body = await response.json<Record<string, unknown>>();
    return json({ ...body, replayed: true });
  }

  const heat = await getHeatSummary(env, eventId, heatId);
  if (heat === null) return json({ error: "Heat not found." }, 404);
  if (heat.status !== "PLANNED" || heat.roster_locked_at !== null) {
    return json({ error: "A heat roster can be edited only before it is locked." }, 409);
  }
  const event = await env.DB.prepare("SELECT status FROM events WHERE id = ?")
    .bind(eventId).first<{ status: string }>();
  if (event === null) return json({ error: "Event not found." }, 404);
  if (event.status !== rosterEditableEventStatus[heat.round]) {
    return json({ error: rosterWindowError[heat.round] }, 409);
  }
  if (heat.revision !== revision) return json({ error: "The heat changed. Refresh and try again." }, 409);

  const placeholders = ids.map(() => "?").join(", ");
  const eligible = await env.DB.prepare(
    `SELECT DISTINCT re.id
       FROM race_entries re
       JOIN registrations r ON r.id = re.registration_id
       JOIN duck_assignments da
         ON da.event_id = re.event_id AND da.race_entry_id = re.id AND da.valid_to IS NULL
      WHERE re.event_id = ? AND re.id IN (${placeholders}) AND r.status = 'ACTIVE'
        AND NOT EXISTS (
          SELECT 1 FROM heat_entries other
           WHERE other.event_id = re.event_id AND other.round = ?
             AND other.race_entry_id = re.id AND other.heat_id != ?
        )
        AND (
          ? = 'ROUND_ONE'
          OR EXISTS (
            SELECT 1 FROM heat_results winner
            JOIN heats won_heat ON won_heat.id = winner.heat_id
             WHERE winner.event_id = re.event_id AND winner.race_entry_id = re.id
               AND winner.status = 'FINALIZED' AND winner.place = 1
               AND won_heat.round = 'ROUND_ONE' AND won_heat.status = 'FINALIZED'
          )
        )`,
  ).bind(eventId, ...ids, heat.round, heatId, heat.round).all<{ id: string }>();
  if (eligible.results.length !== ids.length) {
    return json({ error: "Every roster entry must be eligible and absent from another heat in this round." }, 409);
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at,
         actor_staff_profile_id, request_fingerprint)
       SELECT ?, ?, 'REPLACE_HEAT_ROSTER', ?, ?, ?, ?, ?
        FROM heats h JOIN events e ON e.id = h.event_id
        WHERE h.id = ? AND h.event_id = ? AND h.status = 'PLANNED'
          AND h.roster_locked_at IS NULL AND h.revision = ?
          AND ((h.round = 'ROUND_ONE' AND e.status = 'REGISTRATION_CLOSED')
            OR (h.round = 'FINAL' AND e.status = 'ROUND_ONE'))`,
    ).bind(commandId, eventId, heatId, now, now, actor.id, requestFingerprint, heatId, eventId, revision),
    // The command row above is the sentinel for the rest of the batch: when its
    // guard rejected the write, this delete matches nothing and the whole
    // replacement is a no-op instead of depending on a later foreign key to
    // fail. The inserts below still carry `source_command_id`, so both layers
    // agree on the same committed command.
    env.DB.prepare(
      `DELETE FROM heat_entries
        WHERE event_id = ? AND heat_id = ?
          AND ${rosterCommandCommitted}`,
    ).bind(eventId, heatId, commandId, eventId, heatId),
  ];
  for (const [index, raceEntryId] of ids.entries()) {
    statements.push(env.DB.prepare(
      `INSERT INTO heat_entries
        (id, event_id, heat_id, race_entry_id, round, slot_number,
         assignment_source, assigned_at, source_command_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      eventId,
      heatId,
      raceEntryId,
      heat.round,
      index + 1,
      heat.round === "FINAL" ? "WINNER_PROMOTION" : "BALANCED_DRAW",
      now,
      commandId,
    ));
  }
  statements.push(
    env.DB.prepare(
      `UPDATE heats SET target_size = ?, revision = revision + 1,
              source_command_id = ?, updated_at = ?
        WHERE id = ? AND event_id = ? AND status = 'PLANNED'
          AND roster_locked_at IS NULL AND revision = ?
          AND ${rosterCommandCommitted}`,
    ).bind(ids.length, commandId, now, heatId, eventId, revision, commandId, eventId, heatId),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_id, command_id, action, subject_type, subject_id,
         actor_type, occurred_at, details_json)
       VALUES (?, ?, ?, 'HEAT_ROSTER_REPLACED', 'HEAT', ?, 'STAFF', ?, ?)`,
    ).bind(
      crypto.randomUUID(), eventId, commandId, heatId, now,
      JSON.stringify({ staff_profile_id: actor.id, race_entry_ids: ids }),
    ),
  );
  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: "The roster conflicted with another update. Refresh and try again." }, 409);
  }
  const response = await getHeatDetail(env, eventId, heatId);
  const body = await response.json<Record<string, unknown>>();
  return json({ ...body, replayed: false });
};

// One roster entry that holds no open duck assignment. The heat roster names the
// race entry and the duck is resolved through whichever assignment is currently
// open, so a deleted or unpaired duck shows up here with no change to the roster
// itself.
const unpairedRosterSql = `SELECT 1 AS missing
     FROM heat_entries he
    WHERE he.event_id = ? AND he.heat_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM duck_assignments da
         WHERE da.event_id = he.event_id
           AND da.race_entry_id = he.race_entry_id
           AND da.valid_to IS NULL
      )
    LIMIT 1`;

const transitionDefinitions = {
  lock: { command: "LOCK_HEAT", expected: "PLANNED", next: "LOADING", audit: "HEAT_LOCKED" },
  ready: { command: "READY_HEAT", expected: "LOADING", next: "READY", audit: "HEAT_READY" },
  call: { command: "CALL_HEAT", expected: "READY", next: "CALLING", audit: "HEAT_CALLED" },
  start: { command: "START_HEAT", expected: "CALLING", next: "RUNNING", audit: "HEAT_STARTED" },
  finish: { command: "FINISH_HEAT", expected: "RUNNING", next: "AWAITING_RESULT", audit: "HEAT_FINISHED" },
} as const;

type TransitionName = keyof typeof transitionDefinitions;

const transitionHeat = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  heatId: string,
  transition: TransitionName,
): Promise<Response> => {
  const definition = transitionDefinitions[transition];
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const revision = payload?.revision;
  if (typeof commandId !== "string" || !isCommandId(commandId) || !validRevision(revision)) {
    return json({ error: "Command identifier and heat revision are required." }, 400);
  }
  const requestFingerprint = await fingerprint({ heatId, transition });
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    if (!commandMatches(previous, eventId, heatId, definition.command, requestFingerprint)) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const heat = await getHeatSummary(env, eventId, heatId);
    return heat === null
      ? json({ error: "Heat not found." }, 404)
      : json({ heat: heatSummary(heat), replayed: true });
  }

  const heat = await getHeatSummary(env, eventId, heatId);
  if (heat === null) return json({ error: "Heat not found." }, 404);
  if (heat.revision !== revision) return json({ error: "The heat changed. Refresh and try again." }, 409);
  if (heat.status !== definition.expected) {
    return json({ error: `This heat must be ${definition.expected} before it can ${transition}.` }, 409);
  }
  if (transition === "lock" && heat.roster_size === 0) {
    return json({ error: "A heat must have at least one roster entry before it is locked." }, 409);
  }
  if (transition === "lock") {
    const inactiveRoster = await env.DB.prepare(
      `SELECT 1 AS inactive
         FROM heat_entries he
         JOIN race_entries re ON re.id = he.race_entry_id
         JOIN registrations r ON r.id = re.registration_id
        WHERE he.event_id = ? AND he.heat_id = ? AND r.status != 'ACTIVE'
        LIMIT 1`,
    ).bind(eventId, heatId).first<{ inactive: number }>();
    if (inactiveRoster !== null) {
      return json({
        error: "Every roster participant must be ACTIVE. Update this planned, unlocked roster before locking it.",
      }, 409);
    }
  }
  if (transition === "start") {
    const blockingHeat = await env.DB.prepare(
      `SELECT status
         FROM heats
        WHERE event_id = ? AND id != ? AND status IN ('RUNNING', 'AWAITING_RESULT')
        LIMIT 1`,
    ).bind(eventId, heatId).first<{ status: string }>();
    if (blockingHeat !== null) {
      return json({
        error: blockingHeat.status === "AWAITING_RESULT"
          ? "Publish the official result for the previous heat before starting this heat."
          : "Another heat is still running. Finish it and publish its result before starting this heat.",
      }, 409);
    }
    // Everyone on the water needs a duck. A duck can be deleted at any point,
    // including after a roster is locked, and the participant keeps their place
    // in the heat with nothing to race. This is the gate that stops the heat
    // going off without them, and it is repeated as SQL inside the batch below.
    const missingDuck = await env.DB.prepare(unpairedRosterSql).bind(eventId, heatId).first<{ missing: number }>();
    if (missingDuck !== null) {
      return json({
        error: "Every racer in this heat needs a duck. Pair the racers still waiting, then start the heat.",
      }, 409);
    }
  }

  const now = new Date().toISOString();
  const commandLockGuard = transition === "lock"
    ? `AND h.roster_locked_at IS NULL
       AND EXISTS (SELECT 1 FROM heat_entries he WHERE he.heat_id = h.id)
       AND NOT EXISTS (
         SELECT 1 FROM heat_entries he
         JOIN race_entries re ON re.id = he.race_entry_id
         JOIN registrations r ON r.id = re.registration_id
          WHERE he.heat_id = h.id AND r.status != 'ACTIVE'
       )`
    : "";
  const updateLockGuard = transition === "lock"
    ? `AND roster_locked_at IS NULL
       AND EXISTS (SELECT 1 FROM heat_entries he WHERE he.heat_id = heats.id)
       AND NOT EXISTS (
         SELECT 1 FROM heat_entries he
         JOIN race_entries re ON re.id = he.race_entry_id
         JOIN registrations r ON r.id = re.registration_id
          WHERE he.heat_id = heats.id AND r.status != 'ACTIVE'
       )`
    : "";
  // The everyone-holds-a-duck rule is repeated here as SQL, so a duck deleted
  // between the preflight above and this batch aborts the start rather than
  // sending a racer out with nothing. It correlates on the heat the surrounding
  // statement already identifies rather than binding the identifier twice.
  const fullyPairedGuard = (heatColumn: string): string => `AND NOT EXISTS (
         SELECT 1 FROM heat_entries he
          WHERE he.heat_id = ${heatColumn}
            AND NOT EXISTS (
              SELECT 1 FROM duck_assignments da
               WHERE da.event_id = he.event_id
                 AND da.race_entry_id = he.race_entry_id
                 AND da.valid_to IS NULL
            )
       )`;
  const commandStartGuard = transition === "start"
    ? `AND NOT EXISTS (
         SELECT 1 FROM heats other
          WHERE other.event_id = h.event_id AND other.id != h.id
            AND other.status IN ('RUNNING', 'AWAITING_RESULT')
       )
       ${fullyPairedGuard("h.id")}`
    : "";
  const updateStartGuard = transition === "start"
    ? `AND NOT EXISTS (
         SELECT 1 FROM heats other
          WHERE other.event_id = heats.event_id AND other.id != heats.id
            AND other.status IN ('RUNNING', 'AWAITING_RESULT')
       )
       ${fullyPairedGuard("heats.id")}`
    : "";
  let updateSql = `UPDATE heats SET status = ?, revision = revision + 1,
      source_command_id = ?, updated_at = ?`;
  const updateArgs: unknown[] = [definition.next, commandId, now];
  if (transition === "lock") {
    updateSql += ", roster_locked_at = ?, roster_locked_by_staff_profile_id = ?";
    updateArgs.push(now, actor.id);
  } else if (transition === "start") {
    updateSql += ", started_at = ?";
    updateArgs.push(now);
  } else if (transition === "finish") {
    updateSql += ", finished_at = ?";
    updateArgs.push(now);
  }
  updateSql += ` WHERE id = ? AND event_id = ? AND status = ? AND revision = ?
    ${updateLockGuard} ${updateStartGuard}`;
  updateArgs.push(heatId, eventId, definition.expected, revision);

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at,
           actor_staff_profile_id, request_fingerprint)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
           FROM heats h JOIN events e ON e.id = h.event_id
          WHERE h.id = ? AND h.event_id = ? AND h.status = ? AND h.revision = ?
            AND ((h.round = 'ROUND_ONE' AND e.status = 'ROUND_ONE')
              OR (h.round = 'FINAL' AND e.status = 'FINAL'))
             ${commandLockGuard} ${commandStartGuard}`,
      ).bind(
        commandId, eventId, definition.command, heatId, now, now, actor.id,
        requestFingerprint, heatId, eventId, definition.expected, revision,
      ),
      env.DB.prepare(updateSql).bind(...updateArgs),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, ?, 'HEAT', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, definition.audit, heatId, now,
        JSON.stringify({ staff_profile_id: actor.id, from: definition.expected, to: definition.next }),
      ),
    ]);
  } catch {
    const message = transition === "start"
      ? "Another heat is running or awaiting its official result, a racer lost their duck, or this heat changed. Refresh both stations before trying again."
      : "The heat transition conflicted with another update. Refresh and try again.";
    return json({ error: message }, 409);
  }
  const updated = await getHeatSummary(env, eventId, heatId);
  return json({ heat: updated === null ? null : heatSummary(updated), replayed: false }, 201);
};

const resettableHeatStatuses = ["READY", "CALLING", "RUNNING", "AWAITING_RESULT"] as const;

const resetHeat = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  heatId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const revision = payload?.revision;
  if (typeof commandId !== "string" || !isCommandId(commandId) || !validRevision(revision)) {
    return json({ error: "Command identifier and heat revision are required." }, 400);
  }
  const requestFingerprint = await fingerprint({ heatId, operation: "reset" });
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    if (!commandMatches(previous, eventId, heatId, "RESET_HEAT", requestFingerprint)) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const heat = await getHeatSummary(env, eventId, heatId);
    return heat === null
      ? json({ error: "Heat not found." }, 404)
      : json({ heat: heatSummary(heat), replayed: true });
  }

  const heat = await getHeatSummary(env, eventId, heatId);
  if (heat === null) return json({ error: "Heat not found." }, 404);
  if (heat.revision !== revision) return json({ error: "The heat changed. Refresh and try again." }, 409);
  if (!(resettableHeatStatuses as readonly string[]).includes(heat.status)) {
    return json({ error: "Only a READY, CALLING, RUNNING, or AWAITING_RESULT heat can be reset." }, 409);
  }
  if (heat.roster_locked_at === null || heat.roster_size === 0) {
    return json({ error: "A heat can be reset only with its locked roster intact." }, 409);
  }
  if (heat.published_result_count !== 0) {
    return json({ error: "Published results must be reopened or corrected; they cannot be reset." }, 409);
  }

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at,
           actor_staff_profile_id, request_fingerprint)
         SELECT ?, ?, 'RESET_HEAT', ?, ?, ?, ?, ?
           FROM heats h JOIN events e ON e.id = h.event_id
          WHERE h.id = ? AND h.event_id = ? AND h.revision = ?
            AND h.status IN ('READY', 'CALLING', 'RUNNING', 'AWAITING_RESULT')
            AND h.roster_locked_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM heat_entries he
               WHERE he.event_id = h.event_id AND he.heat_id = h.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM heat_results hr
               WHERE hr.event_id = h.event_id AND hr.heat_id = h.id
                 AND hr.status = 'FINALIZED'
            )
            AND ((h.round = 'ROUND_ONE' AND e.status = 'ROUND_ONE')
              OR (h.round = 'FINAL' AND e.status = 'FINAL'))`,
      ).bind(
        commandId, eventId, heatId, now, now, actor.id, requestFingerprint,
        heatId, eventId, revision,
      ),
      env.DB.prepare(
        `UPDATE heats
            SET status = 'LOADING', started_at = NULL, finished_at = NULL,
                finalized_at = NULL, revision = revision + 1,
                source_command_id = ?, updated_at = ?
          WHERE id = ? AND event_id = ? AND revision = ?
            AND status IN ('READY', 'CALLING', 'RUNNING', 'AWAITING_RESULT')
            AND roster_locked_at IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM heat_entries he
               WHERE he.event_id = heats.event_id AND he.heat_id = heats.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM heat_results hr
               WHERE hr.event_id = heats.event_id AND hr.heat_id = heats.id
                 AND hr.status = 'FINALIZED'
            )
            AND EXISTS (
              SELECT 1 FROM events e
               WHERE e.id = heats.event_id
                 AND ((heats.round = 'ROUND_ONE' AND e.status = 'ROUND_ONE')
                   OR (heats.round = 'FINAL' AND e.status = 'FINAL'))
            )
            AND EXISTS (
              SELECT 1 FROM race_commands rc
               WHERE rc.id = ? AND rc.event_id = ? AND rc.command_type = 'RESET_HEAT'
                 AND rc.result_id = heats.id
            )`,
      ).bind(commandId, now, heatId, eventId, revision, commandId, eventId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, 'HEAT_RESET', 'HEAT', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, heatId, now,
        JSON.stringify({ staff_profile_id: actor.id, from: heat.status, to: "LOADING" }),
      ),
    ]);
  } catch {
    return json({ error: "The heat changed, lost its locked roster, or gained a published result. Refresh and try again." }, 409);
  }
  const updated = await getHeatSummary(env, eventId, heatId);
  return json({ heat: updated === null ? null : heatSummary(updated), replayed: false }, 201);
};

interface ResultInput {
  raceEntryId: string;
  place: number;
}

const parseResults = (value: unknown): ResultInput[] | null => {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) return null;
  const results: ResultInput[] = [];
  for (const item of value) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (
      typeof row.raceEntryId !== "string" || row.raceEntryId.length === 0 || row.raceEntryId.length > 128
      || typeof row.place !== "number" || !Number.isSafeInteger(row.place) || row.place < 1
    ) return null;
    results.push({ raceEntryId: row.raceEntryId, place: row.place });
  }
  results.sort((a, b) => a.place - b.place);
  if (new Set(results.map((row) => row.raceEntryId)).size !== results.length) return null;
  if (new Set(results.map((row) => row.place)).size !== results.length) return null;
  return results;
};

interface ResultContext extends HeatSummaryRow {
  event_status: string;
  final_heat_capacity: number;
  result_revision: number;
}

const resultContext = (
  env: Env,
  eventId: string,
  heatId: string,
): Promise<ResultContext | null> => env.DB.prepare(
  `SELECT h.id, h.event_id, h.round, h.heat_number, h.status, h.target_size,
          h.revision, h.roster_locked_at, h.started_at, h.finished_at, h.finalized_at,
          e.status AS event_status, e.final_heat_capacity,
          (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) AS roster_size,
          (SELECT COUNT(*) FROM heat_results current
            WHERE current.heat_id = h.id AND current.status = 'FINALIZED') AS published_result_count,
          MAX(
            COALESCE((SELECT MAX(current_history.revision) FROM heat_results current_history
                      WHERE current_history.heat_id = h.id), 0),
            COALESCE((SELECT MAX(old_history.revision) FROM heat_result_history old_history
                      WHERE old_history.heat_id = h.id), 0)
          ) AS result_revision
     FROM heats h JOIN events e ON e.id = h.event_id
    WHERE h.event_id = ? AND h.id = ? LIMIT 1`,
).bind(eventId, heatId).first<ResultContext>();

interface ResultRosterRow {
  race_entry_id: string;
  duck_assignment_id: string | null;
  registration_status: string;
}

const resultRoster = (
  env: Env,
  eventId: string,
  heatId: string,
): Promise<D1Result<ResultRosterRow>> => env.DB.prepare(
  `SELECT he.race_entry_id, da.id AS duck_assignment_id,
          r.status AS registration_status
     FROM heat_entries he
     JOIN race_entries re ON re.id = he.race_entry_id
     JOIN registrations r ON r.id = re.registration_id
     LEFT JOIN duck_assignments da ON da.id = (
        SELECT da2.id FROM duck_assignments da2
         WHERE da2.event_id = he.event_id AND da2.race_entry_id = he.race_entry_id
           AND da2.valid_to IS NULL
         LIMIT 1
      )
    WHERE he.event_id = ? AND he.heat_id = ?`,
).bind(eventId, heatId).all<ResultRosterRow>();

const validateResultSet = (
  round: Round,
  results: ResultInput[],
  roster: ResultRosterRow[],
): Response | null => {
  const finalPlaceCount = Math.min(3, roster.length);
  const validPlaces = round === "ROUND_ONE"
    ? results.length === 1 && results[0]?.place === 1
    : results.length === finalPlaceCount && results.every((result, index) => result.place === index + 1);
  if (!validPlaces) {
    return json({ error: round === "ROUND_ONE"
      ? "A round-one result must contain exactly one first-place winner."
      : `A final result must contain exactly places 1 through ${finalPlaceCount}.` }, 422);
  }
  const rosterIds = new Set(roster.map((entry) => entry.race_entry_id));
  if (results.some((result) => !rosterIds.has(result.raceEntryId))) {
    return json({ error: "Every result must identify a participant on this heat roster." }, 422);
  }
  const byRaceEntry = new Map(roster.map((entry) => [entry.race_entry_id, entry]));
  if (results.some((result) => byRaceEntry.get(result.raceEntryId)?.registration_status !== "ACTIVE")) {
    return json({
      error: "Every selected result participant must still be ACTIVE. Refresh the heat and ask the race director to resolve inactive roster entries.",
    }, 422);
  }
  if (results.some((result) => byRaceEntry.get(result.raceEntryId)?.duck_assignment_id === null)) {
    return json({ error: "Every selected result participant must still have a current duck assignment." }, 422);
  }
  return null;
};

const finalizedResultResponse = async (
  env: Env,
  eventId: string,
  heatId: string,
  replayed: boolean,
): Promise<Response> => {
  const [heat, results] = await Promise.all([
    getHeatSummary(env, eventId, heatId),
    publishedResults(env, eventId, heatId),
  ]);
  return json({
    heat: heat === null ? null : heatSummary(heat),
    results: results.results.map(resultResponseRow),
    replayed,
  }, replayed ? 200 : 201);
};

const finalizeResults = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  heatId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const revision = payload?.revision;
  const results = parseResults(payload?.results);
  if (typeof commandId !== "string" || !isCommandId(commandId) || !validRevision(revision) || results === null) {
    return json({ error: "Command, heat revision, and valid result places are required." }, 400);
  }
  const requestFingerprint = await fingerprint({ heatId, results });
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    return commandMatches(previous, eventId, heatId, "FINALIZE_HEAT_RESULT", requestFingerprint)
      ? finalizedResultResponse(env, eventId, heatId, true)
      : json({ error: "This command identifier was already used for another operation." }, 409);
  }

  const [context, rosterResult] = await Promise.all([
    resultContext(env, eventId, heatId),
    resultRoster(env, eventId, heatId),
  ]);
  if (context === null) return json({ error: "Heat not found." }, 404);
  if (context.status !== "AWAITING_RESULT" || context.revision !== revision) {
    return json({ error: "The heat is not awaiting this result revision." }, 409);
  }
  const validation = validateResultSet(context.round, results, rosterResult.results);
  if (validation !== null) return validation;
  if (
    (context.round === "ROUND_ONE" && context.event_status !== "ROUND_ONE")
    || (context.round === "FINAL" && context.event_status !== "FINAL")
  ) return json({ error: "The event is not in the required round." }, 409);

  let finalHeat: { id: string; status: string; roster_locked_at: string | null; roster_size: number } | null = null;
  if (context.round === "ROUND_ONE") {
    finalHeat = await env.DB.prepare(
      `SELECT h.id, h.status, h.roster_locked_at,
              (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) AS roster_size
         FROM heats h WHERE h.event_id = ? AND h.round = 'FINAL' LIMIT 1`,
    ).bind(eventId).first<{ id: string; status: string; roster_locked_at: string | null; roster_size: number }>();
    if (finalHeat !== null && (finalHeat.status !== "PLANNED" || finalHeat.roster_locked_at !== null)) {
      return json({ error: "The final roster is locked and cannot accept another winner." }, 409);
    }
    if ((finalHeat?.roster_size ?? 0) >= context.final_heat_capacity) {
      return json({ error: "The final heat has reached its configured capacity." }, 409);
    }
  }

  const now = new Date().toISOString();
  const resultRevision = context.result_revision + 1;
  const selectedPlaceholders = results.map(() => "?").join(", ");
  const activeResultGuard = `AND (
    SELECT COUNT(DISTINCT selected.race_entry_id)
      FROM heat_entries selected
      JOIN race_entries re ON re.id = selected.race_entry_id
      JOIN registrations r ON r.id = re.registration_id
     WHERE selected.event_id = h.event_id AND selected.heat_id = h.id
       AND selected.race_entry_id IN (${selectedPlaceholders}) AND r.status = 'ACTIVE'
  ) = ?`;
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at,
       actor_staff_profile_id, request_fingerprint)
     SELECT ?, ?, 'FINALIZE_HEAT_RESULT', ?, ?, ?, ?, ?
       FROM heats h JOIN events e ON e.id = h.event_id
       WHERE h.id = ? AND h.event_id = ? AND h.status = 'AWAITING_RESULT' AND h.revision = ?
         AND ((h.round = 'ROUND_ONE' AND e.status = 'ROUND_ONE')
          OR (h.round = 'FINAL' AND e.status = 'FINAL'))
         ${activeResultGuard}`,
  ).bind(
    commandId, eventId, heatId, now, now, actor.id, requestFingerprint,
    heatId, eventId, revision, ...results.map((result) => result.raceEntryId), results.length,
  )];
  const assignments = new Map(rosterResult.results.map((entry) => [entry.race_entry_id, entry.duck_assignment_id]));
  for (const result of results) {
    statements.push(env.DB.prepare(
      `INSERT INTO heat_results
        (id, event_id, heat_id, race_entry_id, duck_assignment_id, place,
         status, revision, finalized_at, recorded_by_staff_profile_id, source_command_id)
       VALUES (?, ?, ?, ?, ?, ?, 'FINALIZED', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), eventId, heatId, result.raceEntryId,
      assignments.get(result.raceEntryId), result.place, resultRevision, now, actor.id, commandId,
    ));
  }
  if (context.round === "ROUND_ONE") {
    const finalHeatId = finalHeat?.id ?? crypto.randomUUID();
    if (finalHeat === null) {
      statements.push(env.DB.prepare(
        `INSERT INTO heats
          (id, event_id, round, heat_number, status, target_size, source_command_id)
         VALUES (?, ?, 'FINAL', 1, 'PLANNED', ?, ?)`,
      ).bind(finalHeatId, eventId, context.final_heat_capacity, commandId));
    }
    statements.push(env.DB.prepare(
      `INSERT INTO heat_entries
        (id, event_id, heat_id, race_entry_id, round, slot_number,
         assignment_source, assigned_at, source_command_id)
       VALUES (?, ?, ?, ?, 'FINAL', ?, 'WINNER_PROMOTION', ?, ?)`,
    ).bind(
      crypto.randomUUID(), eventId, finalHeatId, results[0].raceEntryId,
      (finalHeat?.roster_size ?? 0) + 1, now, commandId,
    ));
  }
  statements.push(env.DB.prepare(
    `UPDATE heats SET status = 'FINALIZED', finalized_at = ?, revision = revision + 1,
            source_command_id = ?, updated_at = ?
      WHERE id = ? AND event_id = ? AND status = 'AWAITING_RESULT' AND revision = ?
        AND (
          SELECT COUNT(DISTINCT selected.race_entry_id)
            FROM heat_entries selected
            JOIN race_entries re ON re.id = selected.race_entry_id
            JOIN registrations r ON r.id = re.registration_id
           WHERE selected.event_id = heats.event_id AND selected.heat_id = heats.id
             AND selected.race_entry_id IN (${selectedPlaceholders}) AND r.status = 'ACTIVE'
        ) = ?`,
  ).bind(
    now, commandId, now, heatId, eventId, revision,
    ...results.map((result) => result.raceEntryId), results.length,
  ));
  statements.push(env.DB.prepare(
    `INSERT INTO audit_events
      (id, event_id, command_id, action, subject_type, subject_id,
       actor_type, occurred_at, details_json)
     VALUES (?, ?, ?, 'HEAT_RESULT_FINALIZED', 'HEAT', ?, 'STAFF', ?, ?)`,
  ).bind(
    crypto.randomUUID(), eventId, commandId, heatId, now,
    JSON.stringify({ staff_profile_id: actor.id, result_revision: resultRevision, results }),
  ));
  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: "Result finalization conflicted with another update. Retry with the same command identifier." }, 409);
  }
  return finalizedResultResponse(env, eventId, heatId, false);
};

interface FinalPromotionRow {
  heat_entry_id: string;
  final_heat_id: string;
  final_heat_status: string;
  roster_locked_at: string | null;
  slot_number: number;
}

const finalPromotion = (
  env: Env,
  eventId: string,
  raceEntryId: string,
): Promise<FinalPromotionRow | null> => env.DB.prepare(
  `SELECT he.id AS heat_entry_id, he.heat_id AS final_heat_id,
          h.status AS final_heat_status, h.roster_locked_at, he.slot_number
     FROM heat_entries he JOIN heats h ON h.id = he.heat_id
    WHERE he.event_id = ? AND he.race_entry_id = ? AND h.round = 'FINAL'
    LIMIT 1`,
).bind(eventId, raceEntryId).first<FinalPromotionRow>();

const supersedeResultStatements = (
  env: Env,
  eventId: string,
  heatId: string,
  actorId: string,
  commandId: string,
  reason: string,
  now: string,
): D1PreparedStatement[] => [
  env.DB.prepare(
    `INSERT INTO heat_result_history
      (id, event_id, heat_id, race_entry_id, duck_assignment_id, place,
       status, revision, finalized_at, recorded_by_staff_profile_id, source_command_id,
       invalidated_at, invalidated_by_staff_profile_id,
       invalidated_by_source_command_id, invalidation_reason, created_at)
     SELECT id, event_id, heat_id, race_entry_id, duck_assignment_id, place,
            'SUPERSEDED', revision, finalized_at, recorded_by_staff_profile_id, source_command_id,
            ?, ?, ?, ?, created_at
       FROM heat_results
      WHERE event_id = ? AND heat_id = ? AND status = 'FINALIZED'`,
  ).bind(now, actorId, commandId, reason, eventId, heatId),
  env.DB.prepare(
    "DELETE FROM heat_results WHERE event_id = ? AND heat_id = ? AND status = 'FINALIZED'",
  ).bind(eventId, heatId),
];

const downstreamFinalGuard = async (env: Env, eventId: string): Promise<boolean> => {
  const dependency = await env.DB.prepare(
    `SELECT 1 AS blocked FROM event_ducks ed
      WHERE ed.event_id = ? AND ed.released_at IS NOT NULL
      LIMIT 1`,
  ).bind(eventId).first<{ blocked: number }>();
  return dependency !== null;
};

const reopenResults = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  heatId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const revision = payload?.revision;
  const reason = reasonFrom(payload?.reason);
  if (typeof commandId !== "string" || !isCommandId(commandId) || !validRevision(revision) || reason === null) {
    return json({ error: "Command, heat revision, and a reason between 4 and 500 characters are required." }, 400);
  }
  const requestFingerprint = await fingerprint({ heatId, reason });
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    if (!commandMatches(previous, eventId, heatId, "REOPEN_HEAT_RESULT", requestFingerprint)) {
      return json({ error: "This command identifier was already used for another operation." }, 409);
    }
    const heat = await getHeatSummary(env, eventId, heatId);
    return json({ heat: heat === null ? null : heatSummary(heat), replayed: true });
  }

  const context = await resultContext(env, eventId, heatId);
  if (context === null) return json({ error: "Heat not found." }, 404);
  if (context.status !== "FINALIZED" || context.revision !== revision || context.published_result_count === 0) {
    return json({ error: "The finalized heat changed. Refresh and try again." }, 409);
  }
  const current = await publishedResults(env, eventId, heatId);
  let promotion: FinalPromotionRow | null = null;
  if (context.round === "ROUND_ONE") {
    promotion = await finalPromotion(env, eventId, current.results[0].race_entry_id);
    if (promotion === null || promotion.final_heat_status !== "PLANNED" || promotion.roster_locked_at !== null) {
      return json({ error: "This result feeds a final roster that is already locked or underway." }, 409);
    }
  } else {
    if (context.event_status !== "COMPLETED" || await downstreamFinalGuard(env, eventId)) {
      return json({ error: "Final results cannot be reopened after return processing has begun." }, 409);
    }
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at,
         actor_staff_profile_id, reason, request_fingerprint)
       SELECT ?, ?, 'REOPEN_HEAT_RESULT', ?, ?, ?, ?, ?, ?
         FROM heats h JOIN events e ON e.id = h.event_id
        WHERE h.id = ? AND h.event_id = ? AND h.status = 'FINALIZED' AND h.revision = ?
          AND ((h.round = 'ROUND_ONE' AND e.status IN ('ROUND_ONE', 'FINAL'))
            OR (h.round = 'FINAL' AND e.status = 'COMPLETED'
              AND NOT EXISTS (
                SELECT 1 FROM event_ducks ed
                 WHERE ed.event_id = e.id AND ed.released_at IS NOT NULL
              )))`,
    ).bind(commandId, eventId, heatId, now, now, actor.id, reason, requestFingerprint, heatId, eventId, revision),
    ...supersedeResultStatements(env, eventId, heatId, actor.id, commandId, reason, now),
  ];
  if (promotion !== null) {
    statements.push(env.DB.prepare(
      "DELETE FROM heat_entries WHERE id = ? AND heat_id = ?",
    ).bind(promotion.heat_entry_id, promotion.final_heat_id));
  }
  statements.push(env.DB.prepare(
    `UPDATE heats SET status = 'AWAITING_RESULT', finalized_at = NULL,
            revision = revision + 1, source_command_id = ?, updated_at = ?
      WHERE id = ? AND event_id = ? AND status = 'FINALIZED' AND revision = ?`,
  ).bind(commandId, now, heatId, eventId, revision));
  if (context.round === "ROUND_ONE") {
    statements.push(env.DB.prepare(
      "UPDATE events SET status = 'ROUND_ONE', updated_at = ? WHERE id = ? AND status = 'FINAL'",
    ).bind(now, eventId));
  } else {
    statements.push(env.DB.prepare(
      "UPDATE events SET status = 'FINAL', updated_at = ? WHERE id = ? AND status = 'COMPLETED'",
    ).bind(now, eventId));
  }
  statements.push(env.DB.prepare(
    `INSERT INTO audit_events
      (id, event_id, command_id, action, subject_type, subject_id,
       actor_type, occurred_at, details_json)
     VALUES (?, ?, ?, 'HEAT_RESULT_REOPENED', 'HEAT', ?, 'STAFF', ?, ?)`,
  ).bind(
    crypto.randomUUID(), eventId, commandId, heatId, now,
    JSON.stringify({
      staff_profile_id: actor.id,
      reason,
      previous_results: current.results.map((row) => ({ raceEntryId: row.race_entry_id, place: row.place })),
    }),
  ));
  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: "The result gained a dependency or changed. Refresh and try again." }, 409);
  }
  const updated = await getHeatSummary(env, eventId, heatId);
  return json({ heat: updated === null ? null : heatSummary(updated), replayed: false }, 201);
};

const correctResults = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  heatId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const revision = payload?.revision;
  const reason = reasonFrom(payload?.reason);
  const results = parseResults(payload?.results);
  if (
    typeof commandId !== "string" || !isCommandId(commandId) || !validRevision(revision)
    || reason === null || results === null
  ) return json({ error: "Command, heat revision, correction reason, and valid results are required." }, 400);
  const requestFingerprint = await fingerprint({ heatId, reason, results });
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    return commandMatches(previous, eventId, heatId, "CORRECT_HEAT_RESULT", requestFingerprint)
      ? finalizedResultResponse(env, eventId, heatId, true)
      : json({ error: "This command identifier was already used for another operation." }, 409);
  }

  const [context, roster, current] = await Promise.all([
    resultContext(env, eventId, heatId),
    resultRoster(env, eventId, heatId),
    publishedResults(env, eventId, heatId),
  ]);
  if (context === null) return json({ error: "Heat not found." }, 404);
  if (context.status !== "FINALIZED" || context.revision !== revision || current.results.length === 0) {
    return json({ error: "The finalized heat changed. Refresh and try again." }, 409);
  }
  const validation = validateResultSet(context.round, results, roster.results);
  if (validation !== null) return validation;
  const oldResults = current.results.map((row) => ({ raceEntryId: row.race_entry_id, place: row.place }));
  if (JSON.stringify(oldResults) === JSON.stringify(results)) {
    return json({ error: "The corrected result must differ from the published result." }, 422);
  }

  let promotion: FinalPromotionRow | null = null;
  if (context.round === "ROUND_ONE") {
    promotion = await finalPromotion(env, eventId, oldResults[0].raceEntryId);
    if (promotion === null || promotion.final_heat_status !== "PLANNED" || promotion.roster_locked_at !== null) {
      return json({ error: "This result feeds a final roster that is already locked or underway." }, 409);
    }
  } else if (context.event_status !== "COMPLETED" || await downstreamFinalGuard(env, eventId)) {
    return json({ error: "Final results cannot be corrected after return processing has begun." }, 409);
  }

  const now = new Date().toISOString();
  const resultRevision = context.result_revision + 1;
  const assignments = new Map(roster.results.map((entry) => [entry.race_entry_id, entry.duck_assignment_id]));
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at,
         actor_staff_profile_id, reason, request_fingerprint)
       SELECT ?, ?, 'CORRECT_HEAT_RESULT', ?, ?, ?, ?, ?, ?
         FROM heats h JOIN events e ON e.id = h.event_id
        WHERE h.id = ? AND h.event_id = ? AND h.status = 'FINALIZED' AND h.revision = ?
          AND ((h.round = 'ROUND_ONE' AND e.status IN ('ROUND_ONE', 'FINAL'))
            OR (h.round = 'FINAL' AND e.status = 'COMPLETED'
              AND NOT EXISTS (
                SELECT 1 FROM event_ducks ed
                 WHERE ed.event_id = e.id AND ed.released_at IS NOT NULL
              )))`,
    ).bind(commandId, eventId, heatId, now, now, actor.id, reason, requestFingerprint, heatId, eventId, revision),
    ...supersedeResultStatements(env, eventId, heatId, actor.id, commandId, reason, now),
  ];
  for (const result of results) {
    statements.push(env.DB.prepare(
      `INSERT INTO heat_results
        (id, event_id, heat_id, race_entry_id, duck_assignment_id, place,
         status, revision, finalized_at, recorded_by_staff_profile_id, source_command_id)
       VALUES (?, ?, ?, ?, ?, ?, 'FINALIZED', ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), eventId, heatId, result.raceEntryId,
      assignments.get(result.raceEntryId), result.place, resultRevision, now, actor.id, commandId,
    ));
  }
  if (promotion !== null) {
    statements.push(env.DB.prepare(
      `UPDATE heat_entries SET race_entry_id = ?, source_command_id = ?, assigned_at = ?
        WHERE id = ? AND heat_id = ? AND race_entry_id = ?`,
    ).bind(
      results[0].raceEntryId, commandId, now, promotion.heat_entry_id,
      promotion.final_heat_id, oldResults[0].raceEntryId,
    ));
  }
  statements.push(
    env.DB.prepare(
      `UPDATE heats SET revision = revision + 1, finalized_at = ?,
              source_command_id = ?, updated_at = ?
        WHERE id = ? AND event_id = ? AND status = 'FINALIZED' AND revision = ?`,
    ).bind(now, commandId, now, heatId, eventId, revision),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_id, command_id, action, subject_type, subject_id,
         actor_type, occurred_at, details_json)
       VALUES (?, ?, ?, 'HEAT_RESULT_CORRECTED', 'HEAT', ?, 'STAFF', ?, ?)`,
    ).bind(
      crypto.randomUUID(), eventId, commandId, heatId, now,
      JSON.stringify({
        staff_profile_id: actor.id,
        reason,
        previous_results: oldResults,
        corrected_results: results,
        result_revision: resultRevision,
      }),
    ),
  );
  try {
    await env.DB.batch(statements);
  } catch {
    return json({ error: "The result gained a dependency or changed. Refresh and try again." }, 409);
  }
  return finalizedResultResponse(env, eventId, heatId, false);
};

interface FinalistRow {
  race_entry_id: string;
  slot_number: number;
  first_name: string;
  last_name: string;
  visible_number: number;
  qualifying_heat_id: string;
  qualifying_heat_number: number;
  podium_place: number | null;
}

const finalistRows = (
  env: Env,
  eventId: string,
): Promise<D1Result<FinalistRow>> => env.DB.prepare(
  `SELECT final_entry.race_entry_id, final_entry.slot_number,
          r.first_name, r.last_name, d.visible_number,
          qualifier.id AS qualifying_heat_id, qualifier.heat_number AS qualifying_heat_number,
          podium.place AS podium_place
     FROM heats final_heat
     JOIN heat_entries final_entry ON final_entry.heat_id = final_heat.id
     JOIN race_entries re ON re.id = final_entry.race_entry_id
     JOIN registrations r ON r.id = re.registration_id
     JOIN duck_assignments da ON da.id = (
       SELECT da2.id FROM duck_assignments da2
        WHERE da2.event_id = final_entry.event_id AND da2.race_entry_id = final_entry.race_entry_id
        ORDER BY da2.valid_from DESC LIMIT 1
     )
     JOIN ducks d ON d.id = da.duck_id
     JOIN heat_results winner
       ON winner.event_id = final_entry.event_id
      AND winner.race_entry_id = final_entry.race_entry_id
      AND winner.status = 'FINALIZED' AND winner.place = 1
     JOIN heats qualifier ON qualifier.id = winner.heat_id AND qualifier.round = 'ROUND_ONE'
     LEFT JOIN heat_results podium
       ON podium.heat_id = final_heat.id
      AND podium.race_entry_id = final_entry.race_entry_id
      AND podium.status = 'FINALIZED'
    WHERE final_heat.event_id = ? AND final_heat.round = 'FINAL'
    ORDER BY final_entry.slot_number`,
).bind(eventId).all<FinalistRow>();

interface VerificationRow {
  round_one_heats: number;
  finalized_round_one_heats: number;
  published_winners: number;
  final_heat_count: number;
  finalist_count: number;
  missing_winners: number;
  invalid_finalists: number;
}

const verificationSummary = async (env: Env, eventId: string): Promise<Record<string, unknown> | Response> => {
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(eventId).first<{ id: string }>();
  if (event === null) return json({ error: "Event not found." }, 404);
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM heats WHERE event_id = ? AND round = 'ROUND_ONE') AS round_one_heats,
       (SELECT COUNT(*) FROM heats WHERE event_id = ? AND round = 'ROUND_ONE' AND status = 'FINALIZED') AS finalized_round_one_heats,
       (SELECT COUNT(*) FROM heat_results hr JOIN heats h ON h.id = hr.heat_id
         WHERE hr.event_id = ? AND h.round = 'ROUND_ONE' AND hr.status = 'FINALIZED' AND hr.place = 1) AS published_winners,
       (SELECT COUNT(*) FROM heats WHERE event_id = ? AND round = 'FINAL') AS final_heat_count,
       (SELECT COUNT(*) FROM heat_entries he JOIN heats h ON h.id = he.heat_id
         WHERE he.event_id = ? AND h.round = 'FINAL') AS finalist_count,
       (SELECT COUNT(*) FROM heat_results hr JOIN heats h ON h.id = hr.heat_id
         WHERE hr.event_id = ? AND h.round = 'ROUND_ONE' AND hr.status = 'FINALIZED' AND hr.place = 1
           AND NOT EXISTS (
             SELECT 1 FROM heat_entries finalist JOIN heats fh ON fh.id = finalist.heat_id
              WHERE finalist.event_id = hr.event_id AND finalist.race_entry_id = hr.race_entry_id
                AND fh.round = 'FINAL'
           )) AS missing_winners,
       (SELECT COUNT(*) FROM heat_entries finalist JOIN heats fh ON fh.id = finalist.heat_id
         WHERE finalist.event_id = ? AND fh.round = 'FINAL'
           AND NOT EXISTS (
             SELECT 1 FROM heat_results hr JOIN heats h ON h.id = hr.heat_id
              WHERE hr.event_id = finalist.event_id AND hr.race_entry_id = finalist.race_entry_id
                AND h.round = 'ROUND_ONE' AND hr.status = 'FINALIZED' AND hr.place = 1
           )) AS invalid_finalists`,
  ).bind(eventId, eventId, eventId, eventId, eventId, eventId, eventId).first<VerificationRow>();
  const summary = row ?? {
    round_one_heats: 0,
    finalized_round_one_heats: 0,
    published_winners: 0,
    final_heat_count: 0,
    finalist_count: 0,
    missing_winners: 0,
    invalid_finalists: 0,
  };
  return {
    verified: summary.round_one_heats > 0
      && summary.round_one_heats === summary.finalized_round_one_heats
      && summary.final_heat_count === 1
      && summary.published_winners === summary.finalist_count
      && summary.missing_winners === 0
      && summary.invalid_finalists === 0,
    roundOneHeats: summary.round_one_heats,
    finalizedRoundOneHeats: summary.finalized_round_one_heats,
    publishedWinners: summary.published_winners,
    finalHeatCount: summary.final_heat_count,
    finalists: summary.finalist_count,
    missingWinners: summary.missing_winners,
    invalidFinalists: summary.invalid_finalists,
  };
};

const listFinalists = async (env: Env, eventId: string): Promise<Response> => {
  const verification = await verificationSummary(env, eventId);
  if (verification instanceof Response) return verification;
  const finalists = await finalistRows(env, eventId);
  return json({
    verification,
    finalists: finalists.results.map((row) => ({
      raceEntryId: row.race_entry_id,
      slotNumber: row.slot_number,
      participant: { firstName: row.first_name, lastName: row.last_name },
      duck: { visibleNumber: row.visible_number },
      qualifiedFrom: { heatId: row.qualifying_heat_id, heatNumber: row.qualifying_heat_number },
      podiumPlace: row.podium_place,
    })),
  });
};

export const handleHeatOperations = async (
  request: Request,
  env: Env,
  actor: StaffActor,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const eventMatch = url.pathname.match(/^\/api\/v1\/staff\/events\/([^/]{1,128})(\/.*)$/);
  if (eventMatch === null) return null;
  const eventId = eventMatch[1];
  const suffix = eventMatch[2];
  const raceReadRoles = ["ANNOUNCER", "HEAT_RUNNER", "RESULT_TAKER", "RACE_DIRECTOR"] as const;

  if (suffix === "/heats" && request.method === "GET") {
    const denied = requireAnyRole(actor, raceReadRoles);
    return denied ?? listHeats(env, eventId);
  }
  if (suffix === "/finalists" && request.method === "GET") {
    const denied = requireAnyRole(actor, raceReadRoles);
    return denied ?? listFinalists(env, eventId);
  }
  if (suffix === "/finalists/verification" && request.method === "GET") {
    const denied = requireAnyRole(actor, raceReadRoles);
    if (denied !== null) return denied;
    const summary = await verificationSummary(env, eventId);
    return summary instanceof Response ? summary : json({ verification: summary });
  }

  const heatMatch = suffix.match(/^\/heats\/([^/]{1,128})(\/.*)?$/);
  if (heatMatch === null) return null;
  const heatId = heatMatch[1];
  const operation = heatMatch[2] ?? "";
  if (operation === "" && request.method === "GET") {
    const denied = requireAnyRole(actor, raceReadRoles);
    return denied ?? getHeatDetail(env, eventId, heatId);
  }
  if (operation === "/announcer-roster" && request.method === "GET") {
    const denied = requireAnyRole(actor, raceReadRoles);
    return denied ?? announcerRoster(env, eventId, heatId);
  }
  if (operation === "/finish-scan" && request.method === "GET") {
    const denied = requireAnyRole(actor, ["RESULT_TAKER", "RACE_DIRECTOR"]);
    return denied ?? finishScan(url, env, eventId, heatId);
  }
  if (operation === "/roster" && request.method === "PUT") {
    const denied = requireAnyRole(actor, ["RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return updateRoster(request, env, actor, eventId, heatId);
  }
  if (operation === "/results/finalize" && request.method === "POST") {
    const denied = requireAnyRole(actor, ["RESULT_TAKER", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return finalizeResults(request, env, actor, eventId, heatId);
  }
  if (operation === "/results/reopen" && request.method === "POST") {
    const denied = requireAnyRole(actor, ["RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return reopenResults(request, env, actor, eventId, heatId);
  }
  if (operation === "/results/correct" && request.method === "POST") {
    const denied = requireAnyRole(actor, ["RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return correctResults(request, env, actor, eventId, heatId);
  }
  if (operation === "/reset" && request.method === "POST") {
    const denied = requireAnyRole(actor, ["RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return resetHeat(request, env, actor, eventId, heatId);
  }
  const transition = operation.match(/^\/(lock|ready|call|start|finish)$/)?.[1] as TransitionName | undefined;
  if (transition !== undefined && request.method === "POST") {
    const roles = transition === "finish"
      ? ["RESULT_TAKER", "RACE_DIRECTOR"] as const
      : ["HEAT_RUNNER", "RACE_DIRECTOR"] as const;
    const denied = requireAnyRole(actor, roles);
    if (denied !== null) return denied;
    return transitionHeat(request, env, actor, eventId, heatId, transition);
  }
  return null;
};
