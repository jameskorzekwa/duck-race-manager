import {
  eligibleEntryCountSql,
  eligibleRacerExists,
  noOtherUnstartedRoundOneHeatSql,
  pendingUnplacedWalkUpExistsSql,
} from "./heat-operations.ts";
import {
  participantNotificationStatements,
  publishEmailNotification,
  publishPendingParticipantNotifications,
} from "./email-notifications.ts";
import type { Env } from "./types.ts";
import { heatHasNeverStartedSql } from "./walk-up-admission.ts";

// A Round One heat stops being a race when the racers in it leave. Withdrawal
// and disqualification never touch a roster — the duck is sealed in a numbered
// bag and the bags are never re-sorted — so the heat keeps every entry, every
// slot, and every duck, and only the count of racers who could still win moves.
//
// Two of those counts make the heat pointless to run, and both used to be a dead
// end that a staffer had to talk their way out of:
//
//   0 eligible  the heat could never publish a winner, so the lock and the start
//               refused it and every heat behind it and the final waited on a
//               heat that could not proceed.
//   1 eligible  the heat had exactly one possible winner, and a staffer still
//               had to line the bag up, run it, and scan the only duck that
//               could be scanned.
//
// This module settles both automatically, and deliberately settles nothing else.
// Two or more eligible racers is a contest and keeps the existing heat-running
// and winner-selection workflow byte for byte.
//
// It applies only to a heat that has never started. That is the whole point of
// the rule: "staff should not have to run an empty heat". Once the ducks are on
// the water the heat is a physical event that has already happened, the finish
// line owns it, and the existing surfaces for "nobody in this heat can win" —
// with reactivation as their remedy — are the right answer there. Reusing
// `heatHasNeverStartedSql` also means a heat that was started and then reset
// keeps its historical `START_HEAT` command and is never taken out of a
// director's hands afterwards.

/**
 * The one racer this heat could still send to the final, as one SQL predicate.
 *
 * It is stricter than "an `ACTIVE` racer exists". Publishing a winner writes a
 * `heat_results` row, which requires an open duck assignment, and promoting them
 * writes a `FINAL` heat entry, which `UNIQUE (event_id, round, race_entry_id)`
 * refuses for anybody already standing in the final. A heat whose sole survivor
 * fails either test cannot be resolved, so it is not claimed as resolvable
 * either — it stays exactly where it is and staff pair or run it as usual.
 */
export const soleEligibleFinalistSql = (heatAlias: string): string => `EXISTS (
    SELECT 1
      FROM heat_entries sole
      JOIN race_entries sole_entry ON sole_entry.id = sole.race_entry_id
      JOIN registrations sole_racer
        ON sole_racer.id = sole_entry.registration_id AND sole_racer.status = 'ACTIVE'
      JOIN duck_assignments sole_assignment
        ON sole_assignment.event_id = sole.event_id
       AND sole_assignment.race_entry_id = sole.race_entry_id
       AND sole_assignment.valid_to IS NULL
     WHERE sole.event_id = ${heatAlias}.event_id AND sole.heat_id = ${heatAlias}.id
       AND NOT EXISTS (
         SELECT 1 FROM heat_entries already_promoted
          WHERE already_promoted.event_id = sole.event_id
            AND already_promoted.round = 'FINAL'
            AND already_promoted.race_entry_id = sole.race_entry_id
       )
  )`;

/**
 * "This Round One heat is no longer a contest and may be settled without staff."
 *
 * Exported because three places need literally this predicate and must never be
 * able to disagree about it: the readiness projection that decides whether the
 * final is still blocked, the guarded command row of each resolution below, and
 * the candidate read that plans them. Only fixed internal identifiers are
 * interpolated; every value stays bound.
 *
 * The walk-up exception is the same one the manual start carries. A walk-up
 * admitted during `ROUND_ONE` is created before their duck is scanned, and the
 * last never-started heat is where they have to be placed; settling that heat
 * out from under the desk would strand them with nowhere to race.
 */
export const autoResolvableRoundOneHeatSql = (heatAlias: string): string => `(
    ${heatAlias}.round = 'ROUND_ONE'
    AND (${heatHasNeverStartedSql(heatAlias)})
    AND EXISTS (
      SELECT 1 FROM events auto_event
       WHERE auto_event.id = ${heatAlias}.event_id AND auto_event.status = 'ROUND_ONE'
    )
    AND NOT (
      ${noOtherUnstartedRoundOneHeatSql(heatAlias)}
      AND ${pendingUnplacedWalkUpExistsSql(`${heatAlias}.event_id`)}
    )
    AND (
      ${eligibleEntryCountSql(`${heatAlias}.event_id`, `${heatAlias}.id`)} = 0
      OR (
        ${eligibleEntryCountSql(`${heatAlias}.event_id`, `${heatAlias}.id`)} = 1
        AND ${soleEligibleFinalistSql(heatAlias)}
      )
    )
  )`;

/** What one settled heat became, for the caller's audit-free reporting. */
export interface RoundOneAutoResolution {
  heatId: string;
  heatNumber: number;
  outcome: "SKIPPED" | "UNCONTESTED_WINNER";
  /** The promoted finalist, for an uncontested heat only. */
  raceEntryId: string | null;
}

interface CandidateRow {
  id: string;
  heat_number: number;
  revision: number;
  eligible_count: number;
  race_entry_id: string | null;
  registration_id: string | null;
  duck_assignment_id: string | null;
  result_revision: number;
  final_heat_id: string | null;
  final_heat_capacity: number;
}

const soleEligibleRacerColumn = (column: string): string => `(
      SELECT ${column}
        FROM heat_entries sole
        JOIN race_entries sole_entry ON sole_entry.id = sole.race_entry_id
        JOIN registrations sole_racer
          ON sole_racer.id = sole_entry.registration_id AND sole_racer.status = 'ACTIVE'
        LEFT JOIN duck_assignments sole_assignment
          ON sole_assignment.event_id = sole.event_id
         AND sole_assignment.race_entry_id = sole.race_entry_id
         AND sole_assignment.valid_to IS NULL
       WHERE sole.event_id = h.event_id AND sole.heat_id = h.id
       LIMIT 1
    )`;

const candidateSql = `SELECT h.id, h.heat_number, h.revision,
       ${eligibleEntryCountSql("h.event_id", "h.id")} AS eligible_count,
       ${soleEligibleRacerColumn("sole.race_entry_id")} AS race_entry_id,
       ${soleEligibleRacerColumn("sole_entry.registration_id")} AS registration_id,
       ${soleEligibleRacerColumn("sole_assignment.id")} AS duck_assignment_id,
       MAX(
         COALESCE((SELECT MAX(published.revision) FROM heat_results published
                    WHERE published.heat_id = h.id), 0),
         COALESCE((SELECT MAX(superseded.revision) FROM heat_result_history superseded
                    WHERE superseded.heat_id = h.id), 0)
       ) + 1 AS result_revision,
       (SELECT existing_final.id FROM heats existing_final
         WHERE existing_final.event_id = h.event_id AND existing_final.round = 'FINAL'
         LIMIT 1) AS final_heat_id,
       e.final_heat_capacity
  FROM heats h JOIN events e ON e.id = h.event_id
 WHERE h.event_id = ? AND ${autoResolvableRoundOneHeatSql("h")}
 ORDER BY h.heat_number`;

const COMMAND_TYPES = {
  SKIPPED: "SKIP_ROUND_ONE_HEAT",
  UNCONTESTED_WINNER: "RESOLVE_UNCONTESTED_HEAT",
} as const;

// Every write below is gated on the command row landing, and the audit insert
// deliberately is not: it is a plain `VALUES` insert whose `command_id` foreign
// key points at that row, so a batch whose guarded command was refused aborts
// and rolls back instead of half-settling a heat. That is what makes each
// resolution atomic, and it is why the caller only ever reads the command row
// back to decide what happened.
const commandCommittedSql = `EXISTS (
        SELECT 1 FROM race_commands rc
         WHERE rc.id = ? AND rc.event_id = ? AND rc.command_type = ? AND rc.result_id = ?
      )`;

const skipStatements = (
  env: Env,
  eventId: string,
  candidate: CandidateRow,
  actorId: string,
  commandId: string,
  now: string,
): D1PreparedStatement[] => [
  env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at,
       actor_staff_profile_id, request_fingerprint)
     SELECT ?, ?, '${COMMAND_TYPES.SKIPPED}', ?, ?, ?, ?, ?
       FROM heats h
      WHERE h.id = ? AND h.event_id = ? AND h.revision = ?
        AND ${autoResolvableRoundOneHeatSql("h")}
        AND NOT ${eligibleRacerExists("h.id")}`,
  ).bind(
    commandId,
    eventId,
    candidate.id,
    now,
    now,
    actorId,
    JSON.stringify({ operation: COMMAND_TYPES.SKIPPED, heatId: candidate.id, revision: candidate.revision }),
    candidate.id,
    eventId,
    candidate.revision,
  ),
  env.DB.prepare(
    `UPDATE heats
        SET status = 'CANCELLED', revision = revision + 1,
            source_command_id = ?, updated_at = ?
      WHERE id = ? AND event_id = ? AND revision = ?
        AND ${commandCommittedSql}`,
  ).bind(
    commandId, now, candidate.id, eventId, candidate.revision,
    commandId, eventId, COMMAND_TYPES.SKIPPED, candidate.id,
  ),
  env.DB.prepare(
    `INSERT INTO audit_events
      (id, event_id, command_id, action, subject_type, subject_id,
       actor_type, occurred_at, details_json)
     VALUES (?, ?, ?, 'ROUND_ONE_HEAT_SKIPPED', 'HEAT', ?, 'STAFF', ?, ?)`,
  ).bind(
    crypto.randomUUID(), eventId, commandId, candidate.id, now,
    JSON.stringify({
      staff_profile_id: actorId,
      heat_number: candidate.heat_number,
      reason: "NO_ELIGIBLE_RACER",
    }),
  ),
];

const uncontestedStatements = (
  env: Env,
  eventId: string,
  candidate: CandidateRow,
  raceEntryId: string,
  duckAssignmentId: string,
  finalHeatId: string,
  createFinalHeat: boolean,
  actorId: string,
  commandId: string,
  now: string,
): D1PreparedStatement[] => {
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at,
         actor_staff_profile_id, request_fingerprint)
       SELECT ?, ?, '${COMMAND_TYPES.UNCONTESTED_WINNER}', ?, ?, ?, ?, ?
         FROM heats h
        WHERE h.id = ? AND h.event_id = ? AND h.revision = ?
          AND ${autoResolvableRoundOneHeatSql("h")}
          AND ${eligibleEntryCountSql("h.event_id", "h.id")} = 1
          AND EXISTS (
            SELECT 1
              FROM heat_entries winner_entry
              JOIN race_entries winner_race_entry ON winner_race_entry.id = winner_entry.race_entry_id
              JOIN registrations winner_racer
                ON winner_racer.id = winner_race_entry.registration_id
               AND winner_racer.status = 'ACTIVE'
              JOIN duck_assignments winner_assignment
                ON winner_assignment.id = ?
               AND winner_assignment.event_id = winner_entry.event_id
               AND winner_assignment.race_entry_id = winner_entry.race_entry_id
               AND winner_assignment.valid_to IS NULL
             WHERE winner_entry.event_id = h.event_id AND winner_entry.heat_id = h.id
               AND winner_entry.race_entry_id = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM heats blocking_final
             WHERE blocking_final.event_id = h.event_id AND blocking_final.round = 'FINAL'
               AND (blocking_final.status != 'PLANNED' OR blocking_final.roster_locked_at IS NOT NULL)
          )
          AND (
            SELECT COUNT(*) FROM heat_entries final_roster
             WHERE final_roster.event_id = h.event_id AND final_roster.round = 'FINAL'
          ) < (SELECT capacity_event.final_heat_capacity FROM events capacity_event
                WHERE capacity_event.id = h.event_id)`,
    ).bind(
      commandId,
      eventId,
      candidate.id,
      now,
      now,
      actorId,
      JSON.stringify({
        operation: COMMAND_TYPES.UNCONTESTED_WINNER,
        heatId: candidate.id,
        raceEntryId,
        revision: candidate.revision,
      }),
      candidate.id,
      eventId,
      candidate.revision,
      duckAssignmentId,
      raceEntryId,
    ),
    // The published winner. Its revision is derived in SQL from whatever this
    // heat has published or superseded before, so an auto-resolution after a
    // director reopened a result cannot rewind the result revision.
    env.DB.prepare(
      `INSERT INTO heat_results
        (id, event_id, heat_id, race_entry_id, duck_assignment_id, place,
         status, revision, finalized_at, recorded_by_staff_profile_id, source_command_id)
       SELECT ?, ?, ?, ?, ?, 1, 'FINALIZED',
              MAX(
                COALESCE((SELECT MAX(published.revision) FROM heat_results published
                           WHERE published.heat_id = ?), 0),
                COALESCE((SELECT MAX(superseded.revision) FROM heat_result_history superseded
                           WHERE superseded.heat_id = ?), 0)
              ) + 1,
              ?, ?, ?
         FROM race_commands rc
        WHERE rc.id = ? AND rc.event_id = ?
          AND rc.command_type = '${COMMAND_TYPES.UNCONTESTED_WINNER}' AND rc.result_id = ?`,
    ).bind(
      crypto.randomUUID(), eventId, candidate.id, raceEntryId, duckAssignmentId,
      candidate.id, candidate.id, now, actorId, commandId,
      commandId, eventId, candidate.id,
    ),
  ];
  if (createFinalHeat) {
    statements.push(env.DB.prepare(
      `INSERT INTO heats (id, event_id, round, heat_number, status, target_size, source_command_id)
       SELECT ?, ?, 'FINAL', 1, 'PLANNED', ?, ?
         FROM race_commands rc
        WHERE rc.id = ? AND rc.event_id = ?
          AND rc.command_type = '${COMMAND_TYPES.UNCONTESTED_WINNER}' AND rc.result_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM heats existing_final
             WHERE existing_final.event_id = ? AND existing_final.round = 'FINAL'
          )`,
    ).bind(
      finalHeatId, eventId, candidate.final_heat_capacity, commandId,
      commandId, eventId, candidate.id, eventId,
    ));
  }
  statements.push(
    // The slot is counted inside the batch rather than carried from the read, so
    // two heats settled in the same reconciliation cannot claim the same slot
    // number and trip `UNIQUE (heat_id, slot_number)`.
    env.DB.prepare(
      `INSERT INTO heat_entries
        (id, event_id, heat_id, race_entry_id, round, slot_number,
         assignment_source, assigned_at, source_command_id)
       SELECT ?, ?, ?, ?, 'FINAL',
              (SELECT COUNT(*) + 1 FROM heat_entries final_roster
                WHERE final_roster.event_id = ? AND final_roster.round = 'FINAL'),
              'WINNER_PROMOTION', ?, ?
         FROM race_commands rc
        WHERE rc.id = ? AND rc.event_id = ?
          AND rc.command_type = '${COMMAND_TYPES.UNCONTESTED_WINNER}' AND rc.result_id = ?`,
    ).bind(
      crypto.randomUUID(), eventId, finalHeatId, raceEntryId, eventId, now, commandId,
      commandId, eventId, candidate.id,
    ),
    env.DB.prepare(
      `UPDATE heats
          SET status = 'FINALIZED', finalized_at = ?, revision = revision + 1,
              source_command_id = ?, updated_at = ?
        WHERE id = ? AND event_id = ? AND revision = ?
          AND ${commandCommittedSql}`,
    ).bind(
      now, commandId, now, candidate.id, eventId, candidate.revision,
      commandId, eventId, COMMAND_TYPES.UNCONTESTED_WINNER, candidate.id,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events
        (id, event_id, command_id, action, subject_type, subject_id,
         actor_type, occurred_at, details_json)
       VALUES (?, ?, ?, 'ROUND_ONE_HEAT_RESOLVED_UNCONTESTED', 'HEAT', ?, 'STAFF', ?, ?)`,
    ).bind(
      crypto.randomUUID(), eventId, commandId, candidate.id, now,
      JSON.stringify({
        staff_profile_id: actorId,
        heat_number: candidate.heat_number,
        race_entry_id: raceEntryId,
        place: 1,
      }),
    ),
  );
  return statements;
};

/**
 * Settle every Round One heat that can no longer be a contest, and report what
 * was settled.
 *
 * It is safe to call as often as anything likes. Each heat is its own guarded
 * batch pinned to the heat revision the candidate read saw, so a heat that
 * moved underneath — started, reset, reactivated into a contest, or already
 * settled by a concurrent caller — writes nothing at all rather than writing
 * half of a resolution. Nothing here can throw into its caller: this runs
 * beside a committed mutation and must never replace that mutation's response.
 */
export const reconcileRoundOneHeats = async (
  env: Env,
  eventId: string,
  actorId: string,
): Promise<RoundOneAutoResolution[]> => {
  const candidates = await env.DB.prepare(candidateSql).bind(eventId)
    .all<CandidateRow>().catch(() => null);
  if (candidates === null) return [];
  const resolutions: RoundOneAutoResolution[] = [];
  const notificationIds: string[] = [];
  for (const candidate of candidates.results) {
    const now = new Date().toISOString();
    // A server-generated RFC 4122 v4 identifier, exactly like every other
    // significant mutation. Replay protection does not come from reusing it —
    // no client holds it — but from the guarded command row, which stops
    // matching the moment the heat has been settled once.
    const commandId = crypto.randomUUID();
    const uncontested = candidate.eligible_count === 1
      && typeof candidate.race_entry_id === "string"
      && typeof candidate.duck_assignment_id === "string";
    if (candidate.eligible_count !== 0 && !uncontested) continue;
    let existingFinalHeatId = candidate.final_heat_id;
    if (uncontested) {
      const currentFinal = await env.DB.prepare(
        "SELECT id FROM heats WHERE event_id = ? AND round = 'FINAL' LIMIT 1",
      ).bind(eventId).first<{ id: string }>().catch(() => null);
      existingFinalHeatId = currentFinal === null ? null : currentFinal.id;
    }
    const finalHeatId = existingFinalHeatId ?? crypto.randomUUID();
    const statements = uncontested
      ? uncontestedStatements(
        env,
        eventId,
        candidate,
        candidate.race_entry_id as string,
        candidate.duck_assignment_id as string,
        finalHeatId,
        existingFinalHeatId === null,
        actorId,
        commandId,
        now,
      )
      : skipStatements(env, eventId, candidate, actorId, commandId, now);
    const notifications: ReturnType<typeof participantNotificationStatements>[] = [];
    if (uncontested && typeof candidate.registration_id === "string") {
      notifications.push(
        participantNotificationStatements(env, {
          eventId,
          registrationId: candidate.registration_id,
          heatId: candidate.id,
          type: "ROUND_RESULT",
          lifecycleKey: `result:${candidate.id}:${candidate.result_revision}`,
          commandId,
          commandType: COMMAND_TYPES.UNCONTESTED_WINNER,
          now,
          resultRevision: candidate.result_revision,
          resultPlace: 1,
        }),
        participantNotificationStatements(env, {
          eventId,
          registrationId: candidate.registration_id,
          heatId: finalHeatId,
          type: "FINAL_ASSIGNED",
          lifecycleKey: `assignment:${finalHeatId}`,
          commandId,
          commandType: COMMAND_TYPES.UNCONTESTED_WINNER,
          now,
        }),
      );
    }
    const nextHeat = await env.DB.prepare(
      `SELECT id, run_sequence FROM heats
        WHERE event_id = ? AND round = 'ROUND_ONE' AND id <> ?
          AND status IN ('LOADING', 'READY', 'CALLING')
        ORDER BY heat_number LIMIT 1`,
    ).bind(eventId, candidate.id).first<{ id: string; run_sequence: number }>().catch(() => null);
    if (nextHeat !== null) {
      const recipients = await env.DB.prepare(
        `SELECT r.id AS registration_id
           FROM heat_entries he
           JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = he.event_id
           JOIN registrations r ON r.id = re.registration_id AND r.event_id = he.event_id
          WHERE he.event_id = ? AND he.heat_id = ? AND r.status = 'ACTIVE'
          ORDER BY he.slot_number`,
      ).bind(eventId, nextHeat.id).all<{ registration_id: string }>().catch(() => null);
      for (const recipient of recipients?.results ?? []) {
        notifications.push(participantNotificationStatements(env, {
          eventId,
          registrationId: recipient.registration_id,
          heatId: nextHeat.id,
          type: "HEAT_UPCOMING",
          lifecycleKey: `run:${nextHeat.run_sequence}`,
          commandId,
          commandType: uncontested ? COMMAND_TYPES.UNCONTESTED_WINNER : COMMAND_TYPES.SKIPPED,
          now,
          requireAuthoritativeUpcoming: true,
        }));
      }
    }
    statements.push(...notifications.flatMap((notification) => notification.statements));
    try {
      await env.DB.batch(statements);
    } catch {
      // Deliberately swallowed, exactly as the scanned-podium command does. The
      // batch is one transaction, so a refused guard and a raised constraint
      // both mean "nothing was written", and the command row below is the only
      // honest account of which it was.
    }
    const committed = await env.DB.prepare(
      "SELECT id FROM race_commands WHERE id = ? AND event_id = ? LIMIT 1",
    ).bind(commandId, eventId).first<{ id: string }>().catch(() => null);
    if (committed === null) continue;
    notificationIds.push(...notifications.flatMap((notification) => notification.ids));
    resolutions.push({
      heatId: candidate.id,
      heatNumber: candidate.heat_number,
      outcome: uncontested ? "UNCONTESTED_WINNER" : "SKIPPED",
      raceEntryId: uncontested ? candidate.race_entry_id : null,
    });
  }
  await Promise.all(notificationIds.map((notificationId) => publishEmailNotification(env, notificationId)));
  await publishPendingParticipantNotifications(env);
  return resolutions;
};
