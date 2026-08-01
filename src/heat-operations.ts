import type { StaffActor } from "./auth.ts";
import { hasAnyRole, requireAnyRole } from "./authorization.ts";
import { publicDisplayName } from "./race-board.ts";
import { isCommandId } from "./registration.ts";
import { publishEmailNotification } from "./email-notifications.ts";
import type { Env } from "./types.ts";
import { heatHasNeverStartedSql } from "./walk-up-admission.ts";

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
  result_correction_allowed: number;
  result_reopen_allowed: number;
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
  resultCorrectionAllowed: row.result_correction_allowed === 1,
  resultReopenAllowed: row.result_reopen_allowed === 1,
  revision: row.revision,
  rosterLocked: row.roster_locked_at !== null,
  rosterLockedAt: row.roster_locked_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  finalizedAt: row.finalized_at,
});

// A published final result may be revised while the race is still the race:
// `FINAL` is the state a director is actually in the moment they disqualify a
// winner, and `COMPLETED` is where they are if they notice afterwards.
//
// Requiring `COMPLETED` alone made the documented remedy circular. The event
// could not be completed while its podium disagreed with the current eligible
// count, and the correction that would fix the podium refused to run until the
// event was completed. Admitting `FINAL` breaks that loop with the state
// transition the director already has, and it cannot corrupt anything the
// `COMPLETED` path protects: a `FINAL`-round correction computes no finalist
// promotion at all (only a `ROUND_ONE` winner feeds a final roster), and neither
// correction nor reopen writes the event's status forward, so an event that is
// already `COMPLETED` stays exactly where it was.
export const FINAL_RESULT_REVISABLE_EVENT_STATUSES = ["FINAL", "COMPLETED"] as const;

// The same set as one SQL list, derived from the array above rather than
// retyped. It was previously written out four separate times — once in JS and
// three times as a literal — which is exactly the preflight/guarded-batch drift
// the shared podium-depth expression was extracted to stop. Interpolating it is
// permitted because it is a fixed internal enum, never external input.
export const FINAL_RESULT_REVISABLE_EVENT_STATUS_SQL = `(${
  FINAL_RESULT_REVISABLE_EVENT_STATUSES.map((status) => `'${status}'`).join(", ")
})`;

/** The deepest podium a final can ever publish, before eligibility shrinks it. */
export const FINAL_PODIUM_DEPTH = 3;

// A heat's podium is only as deep as the racers who can take a place, so every
// surface that counts places counts eligible entries exactly as
// `validateResultSet` does. Counting every entry would demand a place a
// withdrawn finalist is forbidden to hold and leave the event permanently
// incompletable. Both column arguments are fixed internal SQL identifiers.
export const eligibleEntryCountSql = (eventColumn: string, heatColumn: string): string => `(
              SELECT COUNT(*) FROM heat_entries he
                JOIN race_entries re ON re.id = he.race_entry_id
                JOIN registrations r ON r.id = re.registration_id
               WHERE he.event_id = ${eventColumn} AND he.heat_id = ${heatColumn}
                 AND r.status = 'ACTIVE'
            )`;

// How many places this final still requires, as one SQL scalar. The scan flow
// records a provisional place at a time, so the depth is re-read inside the
// guarded command row of every single scan rather than trusted from the read
// that painted the buttons: a finalist may withdraw between a staffer seeing
// "3rd place" offered and pressing it, and that withdrawal shrinks the podium
// from three places to two while the button is still on screen.
const requiredPodiumPlacesSql = (eventColumn: string, heatColumn: string): string =>
  `MIN(${FINAL_PODIUM_DEPTH}, ${eligibleEntryCountSql(eventColumn, heatColumn)})`;

// The narrow, targeted meaning of "a duck has left this event": a duck
// assignment named by a `heat_results` row this operation would supersede now
// belongs to an `event_ducks` reservation that has been released.
//
// This deliberately replaces an event-wide `EXISTS (any released event_duck)`.
// That test refused every final correction and reopen for the rest of the event
// the moment *any* duck was released anywhere — including a spare un-reserved at
// the registration desk hours before racing, which is routine. Combined with the
// completion check, that stranded the event: completion demanded a correction
// the correction endpoint refused, and the only exit was undoing a
// disqualification a director must be able to keep. Scoping the stop to the rows
// this command actually rewrites is what the guard's own comment always claimed
// it meant, and it leaves reactivation reachable.
const supersededResultReleasedDuckSql = (eventColumn: string, heatColumn: string): string => `EXISTS (
                 SELECT 1
                   FROM heat_results superseded
                   JOIN duck_assignments superseded_assignment
                     ON superseded_assignment.id = superseded.duck_assignment_id
                   JOIN event_ducks superseded_duck
                     ON superseded_duck.id = superseded_assignment.event_duck_id
                  WHERE superseded.event_id = ${eventColumn}
                    AND superseded.heat_id = ${heatColumn}
                    AND superseded.status = 'FINALIZED'
                    AND superseded_duck.released_at IS NOT NULL
               )`;

// The other half of the same rule for a correction, which also *writes* rows: a
// duck assignment the new podium would name must still belong to a duck in this
// event. `placeholders` comes from `parseResults`, which is bounded to three
// deduplicated entries, so the list is a validated array and never external SQL.
const selectedResultReleasedDuckSql = (placeholders: string): string => `EXISTS (
                 SELECT 1
                   FROM duck_assignments written_assignment
                   JOIN event_ducks written_duck
                     ON written_duck.id = written_assignment.event_duck_id
                  WHERE written_assignment.id IN (${placeholders})
                    AND written_duck.released_at IS NOT NULL
               )`;

const heatSummarySql = `SELECT h.id, h.event_id, h.round, h.heat_number, h.status,
       h.target_size, h.revision, h.roster_locked_at, h.started_at,
       h.finished_at, h.finalized_at,
       (SELECT COUNT(*) FROM heat_entries he WHERE he.heat_id = h.id) AS roster_size,
       (SELECT COUNT(*) FROM heat_results hr
          WHERE hr.heat_id = h.id AND hr.status = 'FINALIZED') AS published_result_count,
       CASE WHEN h.status = 'FINALIZED' AND (
         (h.round = 'ROUND_ONE' AND EXISTS (
           SELECT 1
             FROM heat_results winner
             JOIN heat_entries promoted
               ON promoted.event_id = winner.event_id
              AND promoted.race_entry_id = winner.race_entry_id
             JOIN heats final_heat
               ON final_heat.id = promoted.heat_id
              AND final_heat.round = 'FINAL'
              AND final_heat.status IN ('PLANNED', 'LOADING')
            WHERE winner.heat_id = h.id
              AND winner.status = 'FINALIZED' AND winner.place = 1
         ))
         OR (h.round = 'FINAL' AND EXISTS (
           SELECT 1 FROM events e
            WHERE e.id = h.event_id
              AND e.status IN ${FINAL_RESULT_REVISABLE_EVENT_STATUS_SQL}
              AND NOT ${supersededResultReleasedDuckSql("h.event_id", "h.id")}
         ))
       ) THEN 1 ELSE 0 END AS result_correction_allowed,
       CASE WHEN h.status = 'FINALIZED' AND (
         (h.round = 'ROUND_ONE' AND EXISTS (
           SELECT 1
             FROM heat_results winner
             JOIN heat_entries promoted
               ON promoted.event_id = winner.event_id
              AND promoted.race_entry_id = winner.race_entry_id
             JOIN heats final_heat
               ON final_heat.id = promoted.heat_id
              AND final_heat.round = 'FINAL'
              AND final_heat.status = 'PLANNED'
              AND final_heat.roster_locked_at IS NULL
            WHERE winner.heat_id = h.id
              AND winner.status = 'FINALIZED' AND winner.place = 1
         ))
         OR (h.round = 'FINAL' AND EXISTS (
           SELECT 1 FROM events e
            WHERE e.id = h.event_id
              AND e.status IN ${FINAL_RESULT_REVISABLE_EVENT_STATUS_SQL}
              AND NOT ${supersededResultReleasedDuckSql("h.event_id", "h.id")}
         ))
       ) THEN 1 ELSE 0 END AS result_reopen_allowed
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
  registration_status: string;
  visible_number: number;
  source_command_id: string;
}

// A published result keeps naming the racer it named when it was published, even
// if that racer has since been disqualified. Staff need to see both facts at
// once to decide whether to reopen or correct the result, so the current
// registration status ships beside the published place rather than the row being
// filtered away. The public board projects results separately and omits them.
const publishedResults = (
  env: Env,
  eventId: string,
  heatId: string,
): Promise<D1Result<PublishedResultRow>> => env.DB.prepare(
  `SELECT hr.id, hr.race_entry_id, hr.place, hr.revision, hr.finalized_at,
          hr.source_command_id, r.first_name, r.last_name,
          r.status AS registration_status, d.visible_number
     FROM heat_results hr
     JOIN race_entries re ON re.id = hr.race_entry_id
     JOIN registrations r ON r.id = re.registration_id
     JOIN duck_assignments da ON da.id = hr.duck_assignment_id
     JOIN ducks d ON d.id = da.duck_id
    WHERE hr.event_id = ? AND hr.heat_id = ? AND hr.status = 'FINALIZED'
    ORDER BY hr.place`,
).bind(eventId, heatId).all<PublishedResultRow>();

// Staff rosters show every racer in the bag, including the ones who left, and
// mark them. `eligible` is the single boolean a station renders from: it is
// exactly "this racer can still be recorded as a winner", and it is the same
// `ACTIVE` test the result paths guard on, stated once here rather than
// re-derived from `registrationStatus` by each surface.
//
// "Guard on" means in the SQL, not only in a preflight: `activeSelectionGuardSql`
// counts it again inside the `FINALIZE_HEAT_RESULT` and `CORRECT_HEAT_RESULT`
// command rows, so this boolean is a faithful preview of what the batch will
// accept rather than an optimistic one.
const rosterResponse = (row: RosterRow): Record<string, unknown> => ({
  heatEntryId: row.heat_entry_id,
  raceEntryId: row.race_entry_id,
  slotNumber: row.slot_number,
  assignmentSource: row.assignment_source,
  eligible: row.registration_status === "ACTIVE",
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
  eligible: row.registration_status === "ACTIVE",
  participant: {
    firstName: row.first_name,
    lastName: row.last_name,
    registrationStatus: row.registration_status,
  },
  duck: { visibleNumber: row.visible_number },
});

const getHeatDetail = async (env: Env, eventId: string, heatId: string): Promise<Response> => {
  const heat = await getHeatSummary(env, eventId, heatId);
  if (heat === null) return json({ error: "Heat not found." }, 404);
  const [roster, results, podium] = await Promise.all([
    env.DB.prepare(rosterSql).bind(eventId, heatId).all<RosterRow>(),
    publishedResults(env, eventId, heatId),
    // The final builds its podium one scan at a time, so the places taken so far
    // are part of the heat a station is looking at, not a separate thing it has
    // to go and ask about. Round one has no provisional state to report, and
    // neither does a final that already published one.
    heat.round === "FINAL" && heat.status === "AWAITING_RESULT"
      ? finalPodiumState(env, eventId, heatId, null)
      : Promise.resolve(null),
  ]);
  return json({
    heat: heatSummary(heat),
    roster: roster.results.map(rosterResponse),
    results: results.results.map(resultResponseRow),
    podium,
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
//
// A withdrawn or disqualified racer is deliberately still listed, with the
// status beside them. Their duck is sealed into this heat's bag and physically
// goes into the water, so the roster has to match what the staff are holding;
// hiding the row would leave a duck in the bag nobody could account for. The
// status is exactly what tells the announcer not to call that name. Only public
// surfaces omit them.
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
      registrationStatus: row.registration_status,
      eligible: row.registration_status === "ACTIVE",
    })),
  });
};

/** One provisional podium place a staffer has already scanned into a final. */
export interface FinalPodiumPlacement {
  place: number;
  raceEntryId: string;
  visibleNumber: number;
  participantDisplayName: string;
}

/**
 * Everything a scan station needs to offer the right places for one final.
 *
 * `requiredPlaces` is the podium depth the result will be validated against,
 * `placements` are the places already taken, and `availablePlaces` is what is
 * left. The three are produced together from one read so a station can never
 * offer a place that is taken or a place the podium does not have.
 */
export interface FinalPodiumState {
  requiredPlaces: number;
  placements: FinalPodiumPlacement[];
  availablePlaces: number[];
  /** The place the scanned duck itself holds, when it already holds one. */
  selectedPlace: number | null;
  /**
   * Every place this final requires is already standing on the podium.
   *
   * Normally the scan that fills the last place publishes it, so nobody ever
   * sees this true. It exists for the one ordering that leaves a complete podium
   * unpublished: a finalist withdrawing *after* enough places were recorded
   * shrinks the podium to a depth the recorded places already satisfy, and no
   * further scan is coming — the only ducks left belong to racers the result
   * paths refuse. Without something to publish what is already there, the final
   * could not be finished from the finish line at all.
   */
  complete: boolean;
}

export interface WinnerByTagCandidate {
  eventId: string;
  heatId: string;
  raceEntryId: string;
  revision: number;
  heatNumber: number;
  round: Round;
  participantDisplayName: string;
  /** Present only for a final, where a scan chooses a place instead of winning. */
  podium: FinalPodiumState | null;
}

/**
 * The one stable machine-readable reason the finish line uses for "this duck
 * raced, but its racer is withdrawn or disqualified, so it cannot be the
 * winner".
 *
 * A duck that is already in a heat bag stays in that bag: nobody empties a bag
 * on the bank to fish one duck out, and the heat entries must never be
 * reordered because the ducks in a bag are indistinguishable without scanning
 * every one of them. So the withdrawn duck keeps racing physically and can
 * simply cross the line first. That is an expected race-day outcome and not a
 * failure, so every finish-line surface that can meet it reports this exact
 * reason with `422` and tells the staffer to scan the next duck to finish.
 */
export const FINISH_DUCK_INELIGIBLE_REASON = "DUCK_NOT_ELIGIBLE";

/**
 * The only two registration statuses that mean "this racer left the race", and
 * therefore the only two this reason may ever name out loud.
 *
 * Every other non-`ACTIVE` status is a different fact about the same racer.
 * `SUBMITTED`, in particular, means "registered and waiting for a duck" — a
 * racer whose duck was deleted mid-race sits there until they are paired again.
 * Telling a staffer at the finish line that a duck cannot win because its racer
 * is "Submitted" is a sentence they cannot act on, and it is not what happened.
 * So the status word is produced only for the two statuses it is true for, and
 * anything else falls back to a claim that is true for every one of them.
 */
const INELIGIBLE_REGISTRATION_STATUS_LABELS: Record<string, string> = {
  WITHDRAWN: "Withdrawn",
  DISQUALIFIED: "Disqualified",
};

// One fixed internal enum builds both the SQL predicate and the spoken word, so
// the rows a station is told about and the reason it is given can never drift.
const INELIGIBLE_REGISTRATION_STATUS_SQL = `r.status IN (${
  Object.keys(INELIGIBLE_REGISTRATION_STATUS_LABELS).map((status) => `'${status}'`).join(", ")
})`;

const registrationStatusLabel = (status: string): string | null =>
  Object.prototype.hasOwnProperty.call(INELIGIBLE_REGISTRATION_STATUS_LABELS, status)
    ? INELIGIBLE_REGISTRATION_STATUS_LABELS[status] as string
    : null;

export interface IneligibleFinishDuck {
  raceEntryId: string;
  participantDisplayName: string;
  visibleNumber: number;
  registrationStatus: string;
}

// The projection deliberately stays inside what the finish-line scan already
// returns for an eligible duck: the policy-filtered public display name and the
// visible duck number. No contact detail, lookup code, or tag token is added.
//
// The sentence names the real status word only when there is one to name. Any
// other status that reaches here still cannot be recorded as a winner — every
// result path requires `ACTIVE` — so the refusal and the next instruction are
// identical; only the claim about why is dropped rather than invented.
const ineligibleFinishResponse = (duck: IneligibleFinishDuck): Response => {
  const label = registrationStatusLabel(duck.registrationStatus);
  return json({
    error: `Duck #${duck.visibleNumber} · ${duck.participantDisplayName} `
    + `${label === null ? "is not an active racer" : `is ${label}`} and cannot be recorded as the winner. `
    + "Leave this duck where it is and scan the next duck to pass the finish line.",
    reason: FINISH_DUCK_INELIGIBLE_REASON,
    ineligible: {
      raceEntryId: duck.raceEntryId,
      participantDisplayName: duck.participantDisplayName,
      visibleNumber: duck.visibleNumber,
      registrationStatus: duck.registrationStatus,
    },
  }, 422);
};

export interface WinnerByTagIneligible extends IneligibleFinishDuck {
  eventId: string;
  heatId: string;
  heatNumber: number;
  round: Round;
  reason: typeof FINISH_DUCK_INELIGIBLE_REASON;
}

// The one round/event-status pairing every scanned result path shares. A tag is
// only ever a live result candidate for a heat whose round is the round the
// event is actually in, so round one cannot be published during the final and a
// podium place cannot be recorded during round one.
const SCANNED_RESULT_ROUND_SQL = `((h.round = 'ROUND_ONE' AND e.status = 'ROUND_ONE')
         OR (h.round = 'FINAL' AND e.status = 'FINAL'))`;

// The mirror image of `winnerByTagCandidate`: the same tag, the same sole
// awaiting heat, the same current assignment and roster place — but a
// racer who left the race. It exists so the scan station can say "Withdrawn,
// scan the next duck" instead of falling through to a bare "not the current
// winner candidate" refusal. It is a read; nothing about the heat, its entries,
// or their slot numbers is touched.
//
// It matches only `WITHDRAWN` and `DISQUALIFIED`, deliberately narrower than
// the `ACTIVE`-only guard it mirrors. The two are not complements and must not
// be: `winnerByTagCandidate` answers "may this duck be recorded as the winner",
// which only `ACTIVE` may, while this one answers the strictly smaller question
// "did this racer leave the race", which is the only claim the reason sentence
// makes. A racer who is merely `SUBMITTED` — registered, waiting for a duck
// after theirs was deleted mid-race — is refused by the candidate guard but was
// never withdrawn, so they fall through to the generic refusal instead of being
// announced to the finish line under a status word that is not theirs.
export const winnerByTagIneligible = async (
  env: Env,
  token: string,
): Promise<WinnerByTagIneligible | null> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT e.id AS event_id, h.id AS heat_id, he.race_entry_id,
            h.heat_number, h.round, e.public_name_policy, d.visible_number,
            r.status AS registration_status, r.first_name, r.last_name
       FROM duck_tags dt
       JOIN duck_assignments da
         ON da.duck_id = dt.duck_id AND da.valid_to IS NULL
       JOIN ducks d ON d.id = da.duck_id
       JOIN heat_entries he
         ON he.event_id = da.event_id AND he.race_entry_id = da.race_entry_id
       JOIN heats h
         ON h.id = he.heat_id AND h.event_id = he.event_id
        AND h.status = 'AWAITING_RESULT'
       JOIN events e ON e.id = h.event_id
       JOIN race_entries re ON re.id = he.race_entry_id
       JOIN registrations r
         ON r.id = re.registration_id AND ${INELIGIBLE_REGISTRATION_STATUS_SQL}
      WHERE dt.token = ? AND dt.status = 'ACTIVE'
        AND ${SCANNED_RESULT_ROUND_SQL}
        AND (SELECT COUNT(*) FROM heats awaiting
              WHERE awaiting.event_id = e.id
                AND awaiting.status = 'AWAITING_RESULT') = 1
      LIMIT 1`,
  ).bind(token).first<{
    event_id: string;
    heat_id: string;
    race_entry_id: string;
    heat_number: number;
    round: Round;
    public_name_policy: string;
    visible_number: number;
    registration_status: string;
    first_name: string;
    last_name: string;
  }>();
  if (
    row === null
    || typeof row.event_id !== "string"
    || typeof row.heat_id !== "string"
    || typeof row.race_entry_id !== "string"
    || !Number.isSafeInteger(row.heat_number)
    || !Number.isSafeInteger(row.visible_number)
    || (row.round !== "ROUND_ONE" && row.round !== "FINAL")
    || typeof row.registration_status !== "string"
    || typeof row.first_name !== "string"
    || typeof row.last_name !== "string"
  ) return null;
  return {
    eventId: row.event_id,
    heatId: row.heat_id,
    raceEntryId: row.race_entry_id,
    heatNumber: row.heat_number,
    round: row.round,
    reason: FINISH_DUCK_INELIGIBLE_REASON,
    registrationStatus: row.registration_status,
    visibleNumber: row.visible_number,
    participantDisplayName: publicDisplayName(row.public_name_policy, row.first_name, row.last_name),
  };
};

interface FinalPodiumSelectionRow {
  place: number;
  race_entry_id: string;
  visible_number: number;
  public_name_policy: string;
  first_name: string;
  last_name: string;
  registration_status: string;
}

/**
 * The provisional podium a final has collected so far, and the places it still
 * needs.
 *
 * A recorded place is honoured only while the racer holding it is still
 * `ACTIVE`. A finalist can withdraw or be disqualified after their duck was
 * scanned, and the guarded batch that publishes the podium would refuse to write
 * them, so a station that kept showing second place as taken would be asking the
 * staffer to complete a podium that can never be published. Dropping the place
 * back into `availablePlaces` is what lets them rescan the duck that actually
 * took it. The stale row is left alone; the recording batch replaces it.
 *
 * Places deeper than `requiredPlaces` are ignored for the same reason. A
 * withdrawal shrinks the podium, so a third place scanned while three finalists
 * were eligible stops being a place this final has at all.
 */
export const finalPodiumState = async (
  env: Env,
  eventId: string,
  heatId: string,
  scannedRaceEntryId: string | null,
): Promise<FinalPodiumState> => {
  const [depth, selections] = await Promise.all([
    env.DB.prepare(
      `SELECT ${requiredPodiumPlacesSql("h.event_id", "h.id")} AS required_places
         FROM heats h WHERE h.event_id = ? AND h.id = ? LIMIT 1`,
    ).bind(eventId, heatId).first<{ required_places: number }>(),
    env.DB.prepare(
      `SELECT fps.place, fps.race_entry_id, d.visible_number, e.public_name_policy,
              r.first_name, r.last_name, r.status AS registration_status
         FROM final_podium_selections fps
         JOIN events e ON e.id = fps.event_id
         JOIN race_entries re ON re.id = fps.race_entry_id
         JOIN registrations r ON r.id = re.registration_id
         JOIN duck_assignments da ON da.id = fps.duck_assignment_id
         JOIN ducks d ON d.id = da.duck_id
        WHERE fps.event_id = ? AND fps.heat_id = ?
        ORDER BY fps.place`,
    ).bind(eventId, heatId).all<FinalPodiumSelectionRow>(),
  ]);
  const requiredPlaces = Number.isSafeInteger(depth?.required_places)
    ? Math.max(0, Math.min(FINAL_PODIUM_DEPTH, depth?.required_places as number))
    : 0;
  const placements = selections.results
    .filter((row) => row.registration_status === "ACTIVE" && row.place <= requiredPlaces)
    .map((row) => ({
      place: row.place,
      raceEntryId: row.race_entry_id,
      visibleNumber: row.visible_number,
      participantDisplayName: publicDisplayName(row.public_name_policy, row.first_name, row.last_name),
    }));
  const taken = new Set(placements.map((placement) => placement.place));
  const selectedPlace = placements
    .find((placement) => placement.raceEntryId === scannedRaceEntryId)?.place ?? null;
  return {
    requiredPlaces,
    placements,
    // A duck that already holds a place is offered nothing: it took the place it
    // took, and moving it means clearing that place first.
    availablePlaces: selectedPlace !== null
      ? []
      : Array.from({ length: requiredPlaces }, (_, index) => index + 1)
        .filter((place) => !taken.has(place)),
    selectedPlace,
    complete: requiredPlaces > 0 && placements.length >= requiredPlaces,
  };
};

// A tag offers a result action only when it resolves through the current duck
// assignment to the sole result waiting in the active round. This is also used
// immediately before the mutation; the guarded finalization SQL repeats every
// material race-state condition for concurrency safety.
//
// Round one and the final are the same query because they are the same
// question — "is this duck the tag scan a station is waiting for?" — and only
// the answer differs. Round one has exactly one place, so the action publishes
// the winner outright; the final has up to three, so the action offers the
// places that are still open and publishes only once the last one is chosen.
export const winnerByTagCandidate = async (
  env: Env,
  token: string,
): Promise<WinnerByTagCandidate | null> => {
  if (!/^[A-Za-z0-9_-]{22,128}$/.test(token)) return null;
  const row = await env.DB.prepare(
    `SELECT e.id AS event_id, h.id AS heat_id, he.race_entry_id,
            h.revision, h.heat_number, h.round, e.public_name_policy,
            r.first_name, r.last_name
       FROM duck_tags dt
       JOIN duck_assignments da
         ON da.duck_id = dt.duck_id AND da.valid_to IS NULL
       JOIN heat_entries he
         ON he.event_id = da.event_id AND he.race_entry_id = da.race_entry_id
       JOIN heats h
         ON h.id = he.heat_id AND h.event_id = he.event_id
        AND h.status = 'AWAITING_RESULT'
       JOIN events e ON e.id = h.event_id
       JOIN race_entries re ON re.id = he.race_entry_id
       JOIN registrations r ON r.id = re.registration_id AND r.status = 'ACTIVE'
      WHERE dt.token = ? AND dt.status = 'ACTIVE'
        AND ${SCANNED_RESULT_ROUND_SQL}
        AND (SELECT COUNT(*) FROM heats awaiting
              WHERE awaiting.event_id = e.id
                AND awaiting.status = 'AWAITING_RESULT') = 1
      LIMIT 1`,
  ).bind(token).first<{
    event_id: string;
    heat_id: string;
    race_entry_id: string;
    revision: number;
    heat_number: number;
    round: Round;
    public_name_policy: string;
    first_name: string;
    last_name: string;
  }>();
  if (
    row === null
    || typeof row.event_id !== "string"
    || typeof row.heat_id !== "string"
    || typeof row.race_entry_id !== "string"
    || !validRevision(row.revision)
    || !Number.isSafeInteger(row.heat_number)
    || (row.round !== "ROUND_ONE" && row.round !== "FINAL")
    || typeof row.first_name !== "string"
    || typeof row.last_name !== "string"
  ) return null;
  return {
    eventId: row.event_id,
    heatId: row.heat_id,
    raceEntryId: row.race_entry_id,
    revision: row.revision,
    heatNumber: row.heat_number,
    round: row.round,
    participantDisplayName: publicDisplayName(row.public_name_policy, row.first_name, row.last_name),
    podium: row.round === "FINAL"
      ? await finalPodiumState(env, row.event_id, row.heat_id, row.race_entry_id)
      : null,
  };
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
    // Expected, not exceptional. A withdrawn or disqualified racer's duck was
    // already bagged for this heat, so it is still in the water and can still
    // reach the line first. Say which duck it is and what its status is, and
    // send the staffer straight back to scanning. Nothing is written and no
    // heat entry moves.
    if (selection.registration_status !== "ACTIVE") {
      return ineligibleFinishResponse({
        raceEntryId: selection.race_entry_id,
        participantDisplayName: publicDisplayName(
          selection.public_name_policy,
          selection.first_name,
          selection.last_name,
        ),
        visibleNumber: selection.visible_number,
        registrationStatus: selection.registration_status,
      });
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

// A staff walk-up admitted during ROUND_ONE is created before their duck is
// scanned. Earlier heats may continue while the desk completes that flow, but
// the final never-started heat is the cutoff: starting it must lose to a
// committed admission that still needs placement. Withdrawal clears the
// blocker because the registration is no longer SUBMITTED.
const pendingUnplacedWalkUpExistsSql = (eventExpression: string): string => `EXISTS (
  SELECT 1
    FROM registrations pending_registration
    JOIN race_entries pending_entry
      ON pending_entry.registration_id = pending_registration.id
   WHERE pending_registration.event_id = ${eventExpression}
     AND pending_registration.created_via = 'STAFF'
     AND pending_registration.status = 'SUBMITTED'
     AND NOT EXISTS (
       SELECT 1 FROM heat_entries pending_heat_entry
        WHERE pending_heat_entry.event_id = pending_registration.event_id
          AND pending_heat_entry.race_entry_id = pending_entry.id
          AND pending_heat_entry.round = 'ROUND_ONE'
     )
     AND EXISTS (
       SELECT 1 FROM race_commands pending_command
        WHERE pending_command.event_id = pending_registration.event_id
          AND pending_command.command_type = 'CREATE_STAFF_REGISTRATION'
          AND pending_command.result_id = pending_registration.id
     )
)`;

const noOtherUnstartedRoundOneHeatSql = (heatAlias: string): string => `NOT EXISTS (
  SELECT 1 FROM heats other_unstarted
   WHERE other_unstarted.event_id = ${heatAlias}.event_id
     AND other_unstarted.round = 'ROUND_ONE'
     AND other_unstarted.id != ${heatAlias}.id
     AND ${heatHasNeverStartedSql("other_unstarted")}
)`;

const finalUnstartedHeatHasNoPendingWalkUpGuard = (heatAlias: string): string => `AND NOT (
  ${heatAlias}.round = 'ROUND_ONE'
  AND ${noOtherUnstartedRoundOneHeatSql(heatAlias)}
  AND ${pendingUnplacedWalkUpExistsSql(`${heatAlias}.event_id`)}
)`;

// The single SQL statement of "this heat still has somebody who could win it".
//
// It is exported because `event-operations.ts` needs literally this predicate in
// three more places — the readiness blocker, the guarded round-one/final start
// command, and the automatic roster lock — and the preflight, the transition,
// and the lock must never be able to disagree about it. The only interpolation
// is a fixed internal column name; every value stays bound.
export const eligibleRacerExists = (heatColumn: string): string => `EXISTS (
    SELECT 1 FROM heat_entries he
      JOIN race_entries re ON re.id = he.race_entry_id
      JOIN registrations r ON r.id = re.registration_id
     WHERE he.heat_id = ${heatColumn} AND r.status = 'ACTIVE'
  )`;

// A heat that holds no `ACTIVE` racer at all. Every other roster shape is
// normal: withdrawal and disqualification leave the heat entry, the slot number,
// and the duck assignment exactly where they are, because the duck is sealed in
// a numbered bag and the bags are never re-sorted. Those racers ride along and
// simply cannot be recorded as the winner.
//
// What is not normal is a heat where *nobody* can win. Round one needs one
// first place and the final needs a podium, and both are guarded on `ACTIVE`
// registrations, so such a heat would run and then be impossible to publish,
// stranding the round and every heat behind it. That is the one roster fact
// worth refusing, and it replaces the retired "every roster participant must be
// ACTIVE" rule at both gates that can still prevent it: the lock and the start.
//
// The remedy is reactivation, which stays available to a race director at any
// point, so the refusal is never a dead end.
const noEligibleRacerSql = `SELECT 1 AS ineligible
     FROM heats h
    WHERE h.event_id = ? AND h.id = ?
      AND NOT ${eligibleRacerExists("h.id")}
    LIMIT 1`;

const NO_ELIGIBLE_RACER_ERROR = "Every racer in this heat is withdrawn or disqualified, so the heat cannot produce a winner."
  + " Reactivate at least one of them, then try again. The roster, the slots, and the ducks in the bag stay exactly as they are.";

const eligibleRacerGuard = (heatColumn: string): string => `AND ${eligibleRacerExists(heatColumn)}`;

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
  // A withdrawn or disqualified racer on the roster is expected and blocks
  // nothing; a heat with no eligible racer left at all cannot produce a result,
  // so it is refused before it is locked and again before it is started. Both
  // preflights are repeated as SQL inside the batch below.
  if (transition === "lock" || transition === "start") {
    const ineligibleHeat = await env.DB.prepare(noEligibleRacerSql)
      .bind(eventId, heatId).first<{ ineligible: number }>();
    if (ineligibleHeat !== null) return json({ error: NO_ELIGIBLE_RACER_ERROR }, 409);
  }
  if (transition === "start") {
    if (heat.round === "ROUND_ONE") {
      const pendingWalkUp = await env.DB.prepare(
        `SELECT 1 AS pending
           FROM heats h
          WHERE h.id = ? AND h.event_id = ? AND h.round = 'ROUND_ONE'
            AND ${noOtherUnstartedRoundOneHeatSql("h")}
            AND ${pendingUnplacedWalkUpExistsSql("h.event_id")}
          LIMIT 1`,
      ).bind(heatId, eventId).first<{ pending: number }>();
      if (pendingWalkUp !== null) {
        return json({
          error: "A walk-up participant is still waiting for a duck and heat place. Pair or withdraw them before starting the final unstarted Round One heat.",
        }, 409);
      }
    }
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

  const upcomingRecipients = transition === "call"
    ? (await env.DB.prepare(
      `SELECT r.id AS registration_id
         FROM heat_entries he
         JOIN race_entries re ON re.id = he.race_entry_id AND re.event_id = he.event_id
         JOIN registrations r ON r.id = re.registration_id AND r.event_id = he.event_id
        WHERE he.event_id = ? AND he.heat_id = ?
          AND r.status = 'ACTIVE'
        ORDER BY he.slot_number`,
    ).bind(eventId, heatId).all<{ registration_id: string }>()).results
      .filter((recipient) => typeof recipient.registration_id === "string")
    : [];

  const now = new Date().toISOString();
  const commandLockGuard = transition === "lock"
    ? `AND h.roster_locked_at IS NULL
       AND EXISTS (SELECT 1 FROM heat_entries he WHERE he.heat_id = h.id)
       ${eligibleRacerGuard("h.id")}`
    : "";
  const updateLockGuard = transition === "lock"
    ? `AND roster_locked_at IS NULL
       AND EXISTS (SELECT 1 FROM heat_entries he WHERE he.heat_id = heats.id)
       ${eligibleRacerGuard("heats.id")}`
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
       ${fullyPairedGuard("h.id")}
       ${eligibleRacerGuard("h.id")}
       ${finalUnstartedHeatHasNoPendingWalkUpGuard("h")}`
    : "";
  const updateStartGuard = transition === "start"
    ? `AND NOT EXISTS (
         SELECT 1 FROM heats other
          WHERE other.event_id = heats.event_id AND other.id != heats.id
            AND other.status IN ('RUNNING', 'AWAITING_RESULT')
       )
       ${fullyPairedGuard("heats.id")}
       ${eligibleRacerGuard("heats.id")}
       ${finalUnstartedHeatHasNoPendingWalkUpGuard("heats")}`
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

  const notificationIds = upcomingRecipients.map(() => crypto.randomUUID());
  const statements: D1PreparedStatement[] = [
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
  ];
  for (const [index, recipient] of upcomingRecipients.entries()) {
    statements.push(env.DB.prepare(
      `INSERT INTO email_notifications
        (id, event_id, registration_id, heat_id, duck_assignment_id,
         notification_type, status,
         template_version, created_by_command_id, scheduled_at, updated_at)
       SELECT ?, r.event_id, r.id, h.id, da.id,
              'HEAT_UPCOMING', 'PENDING', 1, ?, ?, ?
         FROM registrations r
         JOIN race_entries re ON re.registration_id = r.id AND re.event_id = r.event_id
         JOIN heat_entries he ON he.race_entry_id = re.id AND he.event_id = r.event_id
         JOIN heats h ON h.id = he.heat_id AND h.event_id = r.event_id
         JOIN events e ON e.id = h.event_id
         JOIN duck_assignments da
           ON da.race_entry_id = re.id AND da.event_id = r.event_id AND da.valid_to IS NULL
        WHERE r.id = ? AND h.id = ? AND h.status = 'CALLING'
          AND ((h.round = 'ROUND_ONE' AND e.status = 'ROUND_ONE')
            OR (h.round = 'FINAL' AND e.status = 'FINAL'))
          AND r.status = 'ACTIVE' AND r.email IS NOT NULL
          AND r.email_notifications_enabled = 1
       ON CONFLICT DO NOTHING`,
    ).bind(notificationIds[index], commandId, now, now, recipient.registration_id, heatId));
  }
  statements.push(
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, ?, 'HEAT', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, definition.audit, heatId, now,
        JSON.stringify({ staff_profile_id: actor.id, from: definition.expected, to: definition.next }),
      ),
  );
  try {
    await env.DB.batch(statements);
  } catch {
    const message = transition === "start"
      ? "Another heat is running or awaiting its official result, a walk-up still needs pairing, a racer lost their duck, every racer left the race, or this heat changed. Refresh both stations before trying again."
      : "The heat transition conflicted with another update. Refresh and try again.";
    return json({ error: message }, 409);
  }
  await Promise.all(notificationIds.map((notificationId) => publishEmailNotification(env, notificationId)));
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
      // A reset says the heat did not finish the way it was recorded, so any
      // podium places its scans had collected describe a finish that is being
      // thrown away. Leaving them would let the next running of this final
      // inherit places nobody scanned for it.
      clearPodiumSelectionsStatement(env, eventId, heatId, commandId),
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
  // The podium is as deep as the racers who can actually take a place. A
  // withdrawn or disqualified finalist keeps their slot and their duck in the
  // bag but can never be recorded, so counting them would demand a place nobody
  // is allowed to fill and make the final impossible to publish. This is the one
  // place where a non-`ACTIVE` roster entry changes a number, and it changes only
  // how many places exist — never who may hold one, which stays `ACTIVE`-only
  // below and in the guarded SQL: `activeSelectionGuardSql` is repeated verbatim
  // inside both the `FINALIZE_HEAT_RESULT` and the `CORRECT_HEAT_RESULT` command
  // rows, so a racer who stops being `ACTIVE` after this preflight read the
  // roster still cannot be written into `heat_results`.
  //
  // This stays an exact count and deliberately does not copy the `<` that the
  // completion check uses. The two measure different things. This one validates
  // a set about to be written, where the eligible count *is* the count at write
  // time and there is no earlier publication to preserve; completion judges a
  // set written in the past against a requirement that has moved since.
  // Exact-on-write plus at-least-on-read is precisely what makes the two
  // impossible to contradict: anything accepted here is immediately
  // `>= MIN(3, eligible)`, so a heat that just published can always be
  // completed, and anything completion still refuses leaves at least one more
  // eligible finalist than published places, which is exactly a correction this
  // function will accept. Loosening this to `<` instead would let a director
  // publish a two-place podium for three eligible finalists.
  const eligibleRosterCount = roster.filter((entry) => entry.registration_status === "ACTIVE").length;
  const finalPlaceCount = Math.min(3, eligibleRosterCount);
  if (eligibleRosterCount === 0) {
    return json({
      error: "Every racer in this heat is withdrawn or disqualified, so no result can be recorded."
        + " Reactivate the racer who should hold the place, then publish the result.",
      reason: FINISH_DUCK_INELIGIBLE_REASON,
      ineligibleRaceEntryIds: results.map((result) => result.raceEntryId),
    }, 422);
  }
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
  // A racer can be withdrawn between selecting their duck and pressing submit.
  // That is the same expected outcome the scan reports, so it carries the same
  // stable reason and names exactly which selections to drop, letting the
  // station clear them and keep taking scans instead of dead-ending.
  const ineligibleRaceEntryIds = results
    .filter((result) => byRaceEntry.get(result.raceEntryId)?.registration_status !== "ACTIVE")
    .map((result) => result.raceEntryId);
  if (ineligibleRaceEntryIds.length > 0) {
    return json({
      error: "One of these ducks belongs to a withdrawn or disqualified racer and cannot be recorded."
        + " Remove it and scan the next duck to pass the finish line.",
      reason: FINISH_DUCK_INELIGIBLE_REASON,
      ineligibleRaceEntryIds,
    }, 422);
  }
  if (results.some((result) => byRaceEntry.get(result.raceEntryId)?.duck_assignment_id === null)) {
    return json({ error: "Every selected result participant must still have a current duck assignment." }, 422);
  }
  return null;
};

// Every racer a result set names must still be `ACTIVE` and must still hold the
// exact duck assignment the caller resolved, counted inside the batch that
// writes the result. `validateResultSet` checks the same thing in the preflight,
// but a preflight cannot hold a lock: withdrawal and disqualification are legal
// at any heat state, so a second director can disqualify a finalist in the round
// trips between the roster read and `env.DB.batch(...)`. That write touches only
// `race_commands`, `registrations`, and `audit_events`, so it bumps no heat
// revision and the `h.revision = ?` guard cannot see it; withdrawal never closes
// the duck assignment, so no foreign key sees it either. This count is what
// sees it.
//
// It is appended to a command insert that aliases `heats` as `h`, and it binds
// the selected race-entry ids, then the resolved assignment ids, then the
// expected number of rows. Both placeholder lists come from `parseResults`,
// which is bounded to three deduplicated entries, so they are validated arrays.
const activeSelectionGuardSql = (
  selectedPlaceholders: string,
  assignmentPlaceholders: string,
): string => `AND (
    SELECT COUNT(DISTINCT selected.race_entry_id)
      FROM heat_entries selected
      JOIN race_entries re ON re.id = selected.race_entry_id
      JOIN registrations r ON r.id = re.registration_id
      JOIN duck_assignments current_assignment
        ON current_assignment.event_id = selected.event_id
       AND current_assignment.race_entry_id = selected.race_entry_id
       AND current_assignment.valid_to IS NULL
     WHERE selected.event_id = h.event_id AND selected.heat_id = h.id
        AND selected.race_entry_id IN (${selectedPlaceholders}) AND r.status = 'ACTIVE'
        AND current_assignment.id IN (${assignmentPlaceholders})
  ) = ?`;

// Provisional podium places are scratch state, so every command that ends a
// final's wait for a result drops them: publishing turns them into the podium,
// and resetting the heat throws away the finish they described. The delete is
// tied to the command that authorized it so a batch whose guarded command row
// was refused cannot still erase a station's scans.
const clearPodiumSelectionsStatement = (
  env: Env,
  eventId: string,
  heatId: string,
  commandId: string,
): D1PreparedStatement => env.DB.prepare(
  `DELETE FROM final_podium_selections
    WHERE event_id = ? AND heat_id = ?
      AND EXISTS (
        SELECT 1 FROM race_commands rc
         WHERE rc.id = ? AND rc.event_id = ? AND rc.result_id = ?
      )`,
).bind(eventId, heatId, commandId, eventId, heatId);

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

const finalizeResultSet = async (
  env: Env,
  actor: StaffActor,
  eventId: string,
  heatId: string,
  commandId: string,
  revision: number,
  results: ResultInput[],
  tagToken: string | null,
): Promise<Response> => {
  const requestFingerprint = await fingerprint(tagToken === null
    ? { heatId, results }
    : { heatId, results, tagToken });
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
  // Deliberately still round one only. The final has always accepted a typed
  // duck number at the finish-line station, and scanning a place is an added
  // way to record the podium rather than a replacement for that station, so
  // tightening this here would take away a working race-day path that nothing
  // about the new flow makes unsafe.
  if (context.round === "ROUND_ONE" && tagToken === null && !hasAnyRole(actor, ["RACE_DIRECTOR"])) {
    return json({ error: "Scan the winning duck's permanent tag to publish a round-one winner." }, 403);
  }
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
  const assignments = new Map(rosterResult.results.map((entry) => [entry.race_entry_id, entry.duck_assignment_id]));
  const selectedAssignmentIds = results.map((result) => assignments.get(result.raceEntryId) as string);
  const selectedPlaceholders = results.map(() => "?").join(", ");
  const assignmentPlaceholders = selectedAssignmentIds.map(() => "?").join(", ");
  const activeResultGuard = activeSelectionGuardSql(selectedPlaceholders, assignmentPlaceholders);
  const tagResultGuard = tagToken === null ? "" : `AND h.round = 'ROUND_ONE'
    AND (SELECT COUNT(*) FROM heats awaiting
          WHERE awaiting.event_id = h.event_id
            AND awaiting.status = 'AWAITING_RESULT') = 1
    AND EXISTS (
      SELECT 1
        FROM heat_entries tag_selected
        JOIN duck_assignments tag_assignment
          ON tag_assignment.event_id = tag_selected.event_id
         AND tag_assignment.race_entry_id = tag_selected.race_entry_id
         AND tag_assignment.valid_to IS NULL
        JOIN duck_tags tag
          ON tag.duck_id = tag_assignment.duck_id
         AND tag.status = 'ACTIVE' AND tag.token = ?
       WHERE tag_selected.event_id = h.event_id
         AND tag_selected.heat_id = h.id
         AND tag_selected.race_entry_id = ?
    )`;
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at,
       actor_staff_profile_id, request_fingerprint)
     SELECT ?, ?, 'FINALIZE_HEAT_RESULT', ?, ?, ?, ?, ?
       FROM heats h JOIN events e ON e.id = h.event_id
       WHERE h.id = ? AND h.event_id = ? AND h.status = 'AWAITING_RESULT' AND h.revision = ?
          AND ((h.round = 'ROUND_ONE' AND e.status = 'ROUND_ONE')
           OR (h.round = 'FINAL' AND e.status = 'FINAL'))
          ${activeResultGuard}
          ${tagResultGuard}`,
  ).bind(
    commandId, eventId, heatId, now, now, actor.id, requestFingerprint,
    heatId, eventId, revision,
    ...results.map((result) => result.raceEntryId),
    ...selectedAssignmentIds,
    results.length,
    ...(tagToken === null ? [] : [tagToken, results[0].raceEntryId]),
  )];
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
  if (context.round === "FINAL") {
    // The podium is published, so the provisional places the scans collected
    // have become the result and must not outlive it. This runs for the
    // director's recovery form as well as for the scan that completes the
    // podium, because a director publishing a different podium by hand is
    // exactly the case where a leftover scanned place would contradict it.
    statements.push(clearPodiumSelectionsStatement(env, eventId, heatId, commandId));
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
  return finalizeResultSet(env, actor, eventId, heatId, commandId, revision, results, null);
};

/**
 * The places a scan is allowed to name, as spoken race-day words.
 *
 * A final's podium is short and fixed, so the labels are a fixed internal table
 * rather than a general ordinal function nobody else needs.
 */
const PODIUM_PLACE_LABELS: Record<number, string> = { 1: "1st", 2: "2nd", 3: "3rd" };

const podiumPlaceLabel = (place: number): string => PODIUM_PLACE_LABELS[place] ?? `${place}th`;

// The tag, the racer, and the roster place a scanned podium command must still
// resolve through, re-checked inside the batch that writes. It repeats every
// condition `winnerByTagCandidate` answered, because that read cannot hold a
// lock and a second station can record a place in the trips between.
const scannedPodiumGuardSql = `AND h.round = 'FINAL' AND e.status = 'FINAL'
    AND (SELECT COUNT(*) FROM heats awaiting
          WHERE awaiting.event_id = h.event_id
            AND awaiting.status = 'AWAITING_RESULT') = 1
    AND EXISTS (
      SELECT 1
        FROM heat_entries tag_selected
        JOIN race_entries tag_entry ON tag_entry.id = tag_selected.race_entry_id
        JOIN registrations tag_racer
          ON tag_racer.id = tag_entry.registration_id AND tag_racer.status = 'ACTIVE'
        JOIN duck_assignments tag_assignment
          ON tag_assignment.event_id = tag_selected.event_id
         AND tag_assignment.race_entry_id = tag_selected.race_entry_id
         AND tag_assignment.valid_to IS NULL
        JOIN duck_tags tag
          ON tag.duck_id = tag_assignment.duck_id
         AND tag.status = 'ACTIVE' AND tag.token = ?
       WHERE tag_selected.event_id = h.event_id
         AND tag_selected.heat_id = h.id
         AND tag_selected.race_entry_id = ?
    )`;

// The place is free and this duck is not already standing somewhere on the
// podium.
//
// Both halves mean exactly what `finalPodiumState` shows the station, because a
// guard that disagrees with the buttons it guards produces a control that can
// only ever fail. A row holds nothing if its racer has since left the race — the
// batch that would publish it refuses to write them — and a row holds nothing if
// its place is deeper than the podium still has, which is what a withdrawal
// elsewhere in the roster does to a place that was already recorded.
//
// The second half is the one that bites. Reading it as a bare "this duck has a
// row" left a still-`ACTIVE` finalist whose recorded place fell outside the
// shrunken depth invisible to every projection and permanently blocked here and
// by `UNIQUE (heat_id, race_entry_id)`: the page offered that duck the open
// places, and every one of them was refused forever. The stale row itself is
// deleted by the recording batch below.
const scannedPodiumPlaceOpenSql = `AND NOT EXISTS (
      SELECT 1 FROM final_podium_selections held
        JOIN race_entries held_entry ON held_entry.id = held.race_entry_id
        JOIN registrations held_racer
          ON held_racer.id = held_entry.registration_id AND held_racer.status = 'ACTIVE'
       WHERE held.heat_id = h.id AND held.place = ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM final_podium_selections mine
       WHERE mine.heat_id = h.id AND mine.race_entry_id = ?
         AND mine.place <= ${requiredPodiumPlacesSql("h.event_id", "h.id")}
    )`;

const commandExistsSql = `EXISTS (
        SELECT 1 FROM race_commands rc
         WHERE rc.id = ? AND rc.event_id = ? AND rc.result_id = ?
      )`;

/**
 * What every scan of a final's duck returns, whether it recorded a place or
 * published the podium.
 *
 * One shape for both outcomes is deliberate. The scanning staffer does not know
 * or care which duck completes the podium — they scan the ducks that finished —
 * so the station renders the same thing each time and simply sees a finalized
 * heat and a full result set on the last one.
 */
const podiumScanResponse = async (
  env: Env,
  eventId: string,
  heatId: string,
  replayed: boolean,
): Promise<Response> => {
  const [heat, results] = await Promise.all([
    getHeatSummary(env, eventId, heatId),
    publishedResults(env, eventId, heatId),
  ]);
  // Read second, and only while there is a provisional podium to report. A
  // published final has no places left to take, and answering "3 places
  // required, all three still open" about a result that is already official is
  // a sentence no caller should have to know to disbelieve.
  const podium = heat !== null && heat.round === "FINAL" && heat.status === "AWAITING_RESULT"
    ? await finalPodiumState(env, eventId, heatId, null)
    : null;
  return json({
    heat: heat === null ? null : heatSummary(heat),
    results: results.results.map(resultResponseRow),
    podium,
    replayed,
  }, replayed ? 200 : 201);
};

/**
 * Record the place one scanned duck took in the final, and publish the whole
 * podium when that place was the last one it needed.
 *
 * Recording and publishing are one command rather than two because the staffer
 * performs one action: they scan the duck and say where it finished. Splitting
 * them would leave a complete podium sitting unpublished behind a separate
 * button somebody has to remember to press, on the one result in the race that
 * everybody is waiting for.
 *
 * Both outcomes therefore share one request fingerprint — the heat, the duck,
 * the place, and the tag — so a retry of the scan that completed the podium
 * replays as the published result instead of being read as a new command. The
 * command *type* still tells the truth about what happened, which is what the
 * audit trail and every later result correction read.
 */
const recordFinalPodiumPlace = async (
  env: Env,
  actor: StaffActor,
  token: string,
  eventId: string,
  heatId: string,
  raceEntryId: string,
  revision: number,
  place: number,
  commandId: string,
): Promise<Response> => {
  const requestFingerprint = await fingerprint({ heatId, raceEntryId, place, tagToken: token });
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    const replayable = previous.event_id === eventId
      && previous.result_id === heatId
      && (previous.command_type === "RECORD_FINAL_PODIUM_PLACE"
        || previous.command_type === "FINALIZE_HEAT_RESULT")
      && previous.request_fingerprint === requestFingerprint;
    return replayable
      ? podiumScanResponse(env, eventId, heatId, true)
      : json({ error: "This command identifier was already used for another operation." }, 409);
  }

  const candidate = await winnerByTagCandidate(env, token);
  if (candidate === null) {
    const ineligible = await winnerByTagIneligible(env, token);
    if (
      ineligible !== null
      && ineligible.eventId === eventId
      && ineligible.heatId === heatId
      && ineligible.raceEntryId === raceEntryId
    ) return ineligibleFinishResponse(ineligible);
  }
  if (
    candidate === null
    || candidate.round !== "FINAL"
    || candidate.podium === null
    || candidate.eventId !== eventId
    || candidate.heatId !== heatId
    || candidate.raceEntryId !== raceEntryId
    || candidate.revision !== revision
  ) return json({ error: "This duck is not a current podium candidate for that heat revision." }, 409);

  const podium = candidate.podium;
  // Named refusals, because each one has a different next action: clear the
  // place this duck already holds, scan a different duck for a place somebody
  // else took, or accept that the podium got shorter while the buttons were on
  // screen.
  if (podium.selectedPlace !== null) {
    return json({
      error: `This duck already holds ${podiumPlaceLabel(podium.selectedPlace)} place in the final.`
        + " Clear that place first if it finished somewhere else.",
    }, 409);
  }
  if (place > podium.requiredPlaces) {
    return json({
      error: `This final has ${podium.requiredPlaces} podium place`
        + `${podium.requiredPlaces === 1 ? "" : "s"} because of who is still racing,`
        + ` so there is no ${podiumPlaceLabel(place)} place to record.`,
    }, 409);
  }
  if (!podium.availablePlaces.includes(place)) {
    return json({
      error: `${podiumPlaceLabel(place)} place in the final is already taken by another duck.`
        + " Choose one of the places that are still open.",
    }, 409);
  }

  const carried = podium.placements;
  const completesPodium = carried.length + 1 === podium.requiredPlaces;
  const results = [...carried.map((placement) => ({
    raceEntryId: placement.raceEntryId,
    place: placement.place,
  })), { raceEntryId, place }].sort((left, right) => left.place - right.place);

  const [context, rosterResult] = await Promise.all([
    resultContext(env, eventId, heatId),
    resultRoster(env, eventId, heatId),
  ]);
  if (context === null) return json({ error: "Heat not found." }, 404);
  if (context.status !== "AWAITING_RESULT" || context.revision !== revision) {
    return json({ error: "The heat is not awaiting this result revision." }, 409);
  }
  if (context.round !== "FINAL" || context.event_status !== "FINAL") {
    return json({ error: "The event is not in the required round." }, 409);
  }
  // The completing scan writes the whole podium, so it is held to exactly the
  // rule the result form is held to. A scan that only records a place writes no
  // result and is not: the podium is deliberately incomplete at that moment.
  if (completesPodium) {
    const validation = validateResultSet(context.round, results, rosterResult.results);
    if (validation !== null) return validation;
  }

  const now = new Date().toISOString();
  const commandType = completesPodium ? "FINALIZE_HEAT_RESULT" : "RECORD_FINAL_PODIUM_PLACE";
  const assignments = new Map(rosterResult.results.map((entry) => [entry.race_entry_id, entry.duck_assignment_id]));
  const carriedGuard = carried.map(() => `AND EXISTS (
      SELECT 1 FROM final_podium_selections carried
       WHERE carried.heat_id = h.id AND carried.place = ? AND carried.race_entry_id = ?
    )`).join("\n    ");
  // Publishing pins the depth exactly, because the podium it writes must be
  // every place this final has. Recording only needs the place to be one this
  // final still has room for.
  const depthGuard = completesPodium
    ? `AND ? = ${requiredPodiumPlacesSql("h.event_id", "h.id")}`
    : `AND ? <= ${requiredPodiumPlacesSql("h.event_id", "h.id")}`;
  const selectedPlaceholders = results.map(() => "?").join(", ");
  const selectedAssignmentIds = results.map((result) => assignments.get(result.raceEntryId) as string);
  const publishGuard = completesPodium
    ? activeSelectionGuardSql(selectedPlaceholders, selectedAssignmentIds.map(() => "?").join(", "))
    : "";
  const statements: D1PreparedStatement[] = [env.DB.prepare(
    `INSERT INTO race_commands
      (id, event_id, command_type, result_id, requested_at, completed_at,
       actor_staff_profile_id, request_fingerprint)
     SELECT ?, ?, '${commandType}', ?, ?, ?, ?, ?
       FROM heats h JOIN events e ON e.id = h.event_id
       WHERE h.id = ? AND h.event_id = ? AND h.status = 'AWAITING_RESULT' AND h.revision = ?
          ${scannedPodiumGuardSql}
          ${scannedPodiumPlaceOpenSql}
          ${carriedGuard}
          ${depthGuard}
          ${publishGuard}`,
  ).bind(
    commandId, eventId, heatId, now, now, actor.id, requestFingerprint,
    heatId, eventId, revision,
    token, raceEntryId,
    place, raceEntryId,
    ...carried.flatMap((placement) => [placement.place, placement.raceEntryId]),
    completesPodium ? results.length : place,
    ...(completesPodium
      ? [
        ...results.map((result) => result.raceEntryId),
        ...selectedAssignmentIds,
        results.length,
      ]
      : []),
  )];

  if (completesPodium) {
    const resultRevision = context.result_revision + 1;
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
    statements.push(
      clearPodiumSelectionsStatement(env, eventId, heatId, commandId),
      env.DB.prepare(
        `UPDATE heats SET status = 'FINALIZED', finalized_at = ?, revision = revision + 1,
                source_command_id = ?, updated_at = ?
          WHERE id = ? AND event_id = ? AND status = 'AWAITING_RESULT' AND revision = ?
            AND ${commandExistsSql}`,
      ).bind(now, commandId, now, heatId, eventId, revision, commandId, eventId, heatId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, 'HEAT_RESULT_FINALIZED', 'HEAT', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, heatId, now,
        JSON.stringify({ staff_profile_id: actor.id, result_revision: resultRevision, results }),
      ),
    );
  } else {
    statements.push(
      // Sweep the two rows this scan is allowed to replace, and only because the
      // guarded command row above accepted it: whatever was standing in the
      // place being taken, and whatever this duck was standing in itself. The
      // guard proved neither of them still holds anything — the racer left, or
      // the place is deeper than the podium still has — so this is what stops a
      // row nobody can see from occupying a place or a duck forever.
      env.DB.prepare(
        `DELETE FROM final_podium_selections
          WHERE heat_id = ? AND (place = ? OR race_entry_id = ?) AND ${commandExistsSql}`,
      ).bind(heatId, place, raceEntryId, commandId, eventId, heatId),
      env.DB.prepare(
        `INSERT INTO final_podium_selections
          (id, event_id, heat_id, race_entry_id, duck_assignment_id, place,
           recorded_at, recorded_by_staff_profile_id, source_command_id)
         SELECT ?, ?, ?, ?, da.id, ?, ?, ?, ?
           FROM duck_assignments da
          WHERE da.event_id = ? AND da.race_entry_id = ? AND da.valid_to IS NULL
            AND ${commandExistsSql}`,
      ).bind(
        crypto.randomUUID(), eventId, heatId, raceEntryId, place, now, actor.id, commandId,
        eventId, raceEntryId, commandId, eventId, heatId,
      ),
      // A recorded place changes what the next scan may choose, so it moves the
      // heat forward the same way every other race operation does. The station
      // that painted the buttons then has a stale revision and reloads, instead
      // of offering a place another phone just took.
      env.DB.prepare(
        `UPDATE heats SET revision = revision + 1, source_command_id = ?, updated_at = ?
          WHERE id = ? AND event_id = ? AND status = 'AWAITING_RESULT' AND revision = ?
            AND ${commandExistsSql}`,
      ).bind(commandId, now, heatId, eventId, revision, commandId, eventId, heatId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, 'FINAL_PODIUM_PLACE_RECORDED', 'HEAT', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, heatId, now,
        JSON.stringify({ staff_profile_id: actor.id, place, race_entry_id: raceEntryId }),
      ),
    );
  }

  try {
    await env.DB.batch(statements);
  } catch {
    // Deliberately swallowed. A D1 batch is one transaction, so whether this
    // threw or merely wrote nothing, the command row below is the only honest
    // account of what happened — and both outcomes need the same answer.
  }
  // A guarded refusal today does raise: the audit insert is an unguarded
  // `VALUES` insert whose `command_id` foreign key points at the `race_commands`
  // row that never landed, so the batch aborts and rolls back. That is what
  // makes the refusal atomic, and it is why the catch above is load-bearing
  // rather than defensive.
  //
  // Reading the command back is the check that does not depend on any of that.
  // Every statement that could write is gated on the command row, so reordering
  // the batch, making the audit write best-effort, or gating it too would turn a
  // lost race into 201 and "2nd place saved" for a scan that wrote nothing —
  // the worst outcome this endpoint has.
  //
  // The advice is deliberately not "retry with the same command identifier".
  // Nothing was written, so there is no command to replay; the podium moved
  // under the page that painted the buttons, and the next scan has to be taken
  // from a fresh one.
  if (await findCommand(env, commandId) === null) {
    return json({
      error: "The podium changed while that duck was scanned."
        + " Scan it again and choose from the places that are still open.",
    }, 409);
  }
  return podiumScanResponse(env, eventId, heatId, false);
};

/**
 * Take one scanned duck back off the podium.
 *
 * Scanning is fast and a place is chosen by tapping one of three buttons, so
 * choosing the wrong one is the mistake this flow will actually produce. Without
 * a way back, a mis-tap is unfixable at the finish line: the wrong podium has to
 * be published in full and then corrected by a race director, which is a heavy
 * remedy for a wrong button and a slow one with a crowd waiting.
 *
 * It is deliberately reachable from both surfaces that show the podium, keyed by
 * the heat, the place, and the duck standing in it rather than by a tag, so the
 * station that can see the mistake can undo it without walking back to the duck.
 */
const clearFinalPodiumPlace = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  eventId: string,
  heatId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const raceEntryId = payload?.raceEntryId;
  const place = payload?.place;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || typeof raceEntryId !== "string" || raceEntryId.length === 0 || raceEntryId.length > 128
    || typeof place !== "number" || !Number.isSafeInteger(place)
    || place < 1 || place > FINAL_PODIUM_DEPTH
  ) return json({ error: "Command, the podium place, and the duck standing in it are required." }, 400);

  const requestFingerprint = await fingerprint({ heatId, raceEntryId, place, operation: "clear-podium-place" });
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    return commandMatches(previous, eventId, heatId, "CLEAR_FINAL_PODIUM_PLACE", requestFingerprint)
      ? podiumScanResponse(env, eventId, heatId, true)
      : json({ error: "This command identifier was already used for another operation." }, 409);
  }

  const now = new Date().toISOString();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO race_commands
          (id, event_id, command_type, result_id, requested_at, completed_at,
           actor_staff_profile_id, request_fingerprint)
         SELECT ?, ?, 'CLEAR_FINAL_PODIUM_PLACE', ?, ?, ?, ?, ?
           FROM heats h JOIN events e ON e.id = h.event_id
          WHERE h.id = ? AND h.event_id = ? AND h.status = 'AWAITING_RESULT'
            AND h.round = 'FINAL' AND e.status = 'FINAL'
            AND EXISTS (
              SELECT 1 FROM final_podium_selections held
               WHERE held.heat_id = h.id AND held.place = ? AND held.race_entry_id = ?
            )`,
      ).bind(
        commandId, eventId, heatId, now, now, actor.id, requestFingerprint,
        heatId, eventId, place, raceEntryId,
      ),
      env.DB.prepare(
        `DELETE FROM final_podium_selections
          WHERE event_id = ? AND heat_id = ? AND place = ? AND race_entry_id = ?
            AND ${commandExistsSql}`,
      ).bind(eventId, heatId, place, raceEntryId, commandId, eventId, heatId),
      env.DB.prepare(
        `UPDATE heats SET revision = revision + 1, source_command_id = ?, updated_at = ?
          WHERE id = ? AND event_id = ? AND status = 'AWAITING_RESULT'
            AND ${commandExistsSql}`,
      ).bind(commandId, now, heatId, eventId, commandId, eventId, heatId),
      env.DB.prepare(
        `INSERT INTO audit_events
          (id, event_id, command_id, action, subject_type, subject_id,
           actor_type, occurred_at, details_json)
         VALUES (?, ?, ?, 'FINAL_PODIUM_PLACE_CLEARED', 'HEAT', ?, 'STAFF', ?, ?)`,
      ).bind(
        crypto.randomUUID(), eventId, commandId, heatId, now,
        JSON.stringify({ staff_profile_id: actor.id, place, race_entry_id: raceEntryId }),
      ),
    ]);
  } catch {
    // Same reasoning as recording: the command row decides, not the exception.
  }
  if (await findCommand(env, commandId) === null) {
    return json({
      error: "That podium place is not recorded for a final that is waiting for its result."
        + " Refresh and try again.",
    }, 409);
  }
  return podiumScanResponse(env, eventId, heatId, false);
};

const finalizeWinnerByTag = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  token: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const eventId = payload?.eventId;
  const heatId = payload?.heatId;
  const raceEntryId = payload?.raceEntryId;
  const revision = payload?.revision;
  const place = payload?.place;
  if (
    typeof commandId !== "string" || !isCommandId(commandId)
    || typeof eventId !== "string" || eventId.length === 0 || eventId.length > 128
    || typeof heatId !== "string" || heatId.length === 0 || heatId.length > 128
    || typeof raceEntryId !== "string" || raceEntryId.length === 0 || raceEntryId.length > 128
    || !validRevision(revision)
  ) return json({ error: "Command and the exact scanned winner context are required." }, 400);

  // A place is what separates the two scanned result flows, and it is the
  // client's statement about which one it is asking for. Round one has exactly
  // one place and never sends it; the final always does, because the staffer had
  // to choose one before the request existed.
  if (place !== undefined) {
    if (
      typeof place !== "number" || !Number.isSafeInteger(place)
      || place < 1 || place > FINAL_PODIUM_DEPTH
    ) return json({ error: "Choose 1st, 2nd, or 3rd place for this duck." }, 400);
    return recordFinalPodiumPlace(
      env,
      actor,
      token,
      eventId,
      heatId,
      raceEntryId,
      revision,
      place,
      commandId,
    );
  }

  const results = [{ raceEntryId, place: 1 }];
  const requestFingerprint = await fingerprint({ heatId, results, tagToken: token });
  const previous = await findCommand(env, commandId);
  if (previous !== null) {
    return commandMatches(previous, eventId, heatId, "FINALIZE_HEAT_RESULT", requestFingerprint)
      ? finalizedResultResponse(env, eventId, heatId, true)
      : json({ error: "This command identifier was already used for another operation." }, 409);
  }

  const candidate = await winnerByTagCandidate(env, token);
  if (candidate === null) {
    // Distinguish "this racer is withdrawn or disqualified" from every other
    // reason a tag is not the current candidate, so a stale control that fires
    // anyway reports the same expected outcome the scan already showed.
    const ineligible = await winnerByTagIneligible(env, token);
    if (
      ineligible !== null
      && ineligible.eventId === eventId
      && ineligible.heatId === heatId
      && ineligible.raceEntryId === raceEntryId
    ) return ineligibleFinishResponse(ineligible);
  }
  // A page loaded while the event was still in round one, left open through the
  // start of the final, and then used. The duck is a live candidate, but for a
  // heat that awards three places rather than one, so the honest answer is that
  // this scan is missing the place — not that the duck cannot win.
  if (candidate !== null && candidate.round === "FINAL") {
    return json({
      error: "This duck is racing in the final, so its result is a podium place."
        + " Scan it again and choose the place it finished in.",
    }, 422);
  }
  if (
    candidate === null
    || candidate.eventId !== eventId
    || candidate.heatId !== heatId
    || candidate.raceEntryId !== raceEntryId
    || candidate.revision !== revision
  ) return json({ error: "This duck is not the current winner candidate for that heat revision." }, 409);

  return finalizeResultSet(env, actor, eventId, heatId, commandId, revision, results, token);
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

// The one remaining hard stop, and the only thing the retired "return
// processing" wording was ever really guarding: a duck named by a result row
// this command rewrites has left the event, so that row's duck assignment no
// longer describes a duck in the race.
//
// It is deliberately targeted rather than event-wide. `assignmentIds` is the set
// of assignments a correction would write; a reopen writes none and passes an
// empty list. Both halves are repeated verbatim inside the guarded command row,
// so this preflight can only ever produce a better error message than the batch,
// never a different decision.
const releasedResultDuckGuard = async (
  env: Env,
  eventId: string,
  heatId: string,
  assignmentIds: readonly string[],
): Promise<boolean> => {
  const written = assignmentIds.length === 0
    ? ""
    : ` OR ${selectedResultReleasedDuckSql(assignmentIds.map(() => "?").join(", "))}`;
  const dependency = await env.DB.prepare(
    `SELECT 1 AS blocked FROM heats h
      WHERE h.event_id = ? AND h.id = ?
        AND (${supersededResultReleasedDuckSql("h.event_id", "h.id")}${written})
      LIMIT 1`,
  ).bind(eventId, heatId, ...assignmentIds).first<{ blocked: number }>();
  return dependency !== null;
};

// Named preconditions rather than one message that blamed a concept this
// product does not have. `operation` is a fixed internal literal.
const finalResultStateError = (operation: "corrected" | "reopened"): string =>
  `Final results can be ${operation} only while the event is FINAL or COMPLETED.`;

const finalResultReleasedDuckError = (operation: "corrected" | "reopened"): string =>
  `Final results cannot be ${operation} once a duck has been released from this event.`;

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
    if (!(FINAL_RESULT_REVISABLE_EVENT_STATUSES as readonly string[]).includes(context.event_status)) {
      return json({ error: finalResultStateError("reopened") }, 409);
    }
    // A reopen supersedes the published podium and writes no new result rows, so
    // the released-duck stop covers exactly the rows it removes and nothing
    // else. It needs no eligibility guard: removing a place never requires the
    // racer who held it to still be able to hold one.
    if (await releasedResultDuckGuard(env, eventId, heatId, [])) {
      return json({ error: finalResultReleasedDuckError("reopened") }, 409);
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
            OR (h.round = 'FINAL'
              AND e.status IN ${FINAL_RESULT_REVISABLE_EVENT_STATUS_SQL}
              AND NOT ${supersededResultReleasedDuckSql("h.event_id", "h.id")}))`,
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

  const assignments = new Map(roster.results.map((entry) => [entry.race_entry_id, entry.duck_assignment_id]));
  // `validateResultSet` has already refused any selection without a current
  // assignment, so every lookup here resolves.
  const selectedAssignmentIds = results.map((result) => assignments.get(result.raceEntryId) as string);

  let promotion: FinalPromotionRow | null = null;
  if (context.round === "ROUND_ONE") {
    promotion = await finalPromotion(env, eventId, oldResults[0].raceEntryId);
    if (promotion === null || !["PLANNED", "LOADING"].includes(promotion.final_heat_status)) {
      return json({ error: "This winner can be corrected only before the final heat is ready." }, 409);
    }
  } else if (!(FINAL_RESULT_REVISABLE_EVENT_STATUSES as readonly string[]).includes(context.event_status)) {
    return json({ error: finalResultStateError("corrected") }, 409);
  } else if (await releasedResultDuckGuard(env, eventId, heatId, selectedAssignmentIds)) {
    return json({ error: finalResultReleasedDuckError("corrected") }, 409);
  }

  const now = new Date().toISOString();
  const resultRevision = context.result_revision + 1;
  const selectedPlaceholders = results.map(() => "?").join(", ");
  const assignmentPlaceholders = selectedAssignmentIds.map(() => "?").join(", ");
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO race_commands
        (id, event_id, command_type, result_id, requested_at, completed_at,
         actor_staff_profile_id, reason, request_fingerprint)
       SELECT ?, ?, 'CORRECT_HEAT_RESULT', ?, ?, ?, ?, ?, ?
         FROM heats h JOIN events e ON e.id = h.event_id
         WHERE h.id = ? AND h.event_id = ? AND h.status = 'FINALIZED' AND h.revision = ?
           AND ((h.round = 'ROUND_ONE' AND e.status IN ('ROUND_ONE', 'FINAL')
             AND EXISTS (
               SELECT 1
                 FROM heat_entries promoted
                 JOIN heats final_heat ON final_heat.id = promoted.heat_id
                WHERE promoted.event_id = h.event_id
                  AND promoted.race_entry_id = ?
                  AND final_heat.round = 'FINAL'
                  AND final_heat.status IN ('PLANNED', 'LOADING')
             ))
             OR (h.round = 'FINAL'
               AND e.status IN ${FINAL_RESULT_REVISABLE_EVENT_STATUS_SQL}
               AND NOT ${supersededResultReleasedDuckSql("h.event_id", "h.id")}
               AND NOT ${selectedResultReleasedDuckSql(assignmentPlaceholders)}))
           ${activeSelectionGuardSql(selectedPlaceholders, assignmentPlaceholders)}`,
    ).bind(
      commandId, eventId, heatId, now, now, actor.id, reason, requestFingerprint,
      heatId, eventId, revision, oldResults[0].raceEntryId,
      ...selectedAssignmentIds,
      ...results.map((result) => result.raceEntryId),
      ...selectedAssignmentIds,
      results.length,
    ),
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
        WHERE id = ? AND event_id = ? AND heat_id = ? AND race_entry_id = ?
          AND EXISTS (
            SELECT 1 FROM heats final_heat
             WHERE final_heat.id = heat_entries.heat_id
               AND final_heat.event_id = heat_entries.event_id
               AND final_heat.round = 'FINAL'
               AND final_heat.status IN ('PLANNED', 'LOADING')
          )
          AND EXISTS (
            SELECT 1 FROM race_commands correction
             WHERE correction.id = ? AND correction.event_id = heat_entries.event_id
               AND correction.command_type = 'CORRECT_HEAT_RESULT'
               AND correction.result_id = ?
          )`,
    ).bind(
      results[0].raceEntryId, commandId, now, promotion.heat_entry_id,
      eventId, promotion.final_heat_id, oldResults[0].raceEntryId,
      commandId, heatId,
    ));
    // The final roster changed even though the final's lifecycle state did not.
    // Bump its revision so station caches repaint the corrected finalist and a
    // stale ready command cannot proceed against the old roster.
    statements.push(env.DB.prepare(
      `UPDATE heats SET revision = revision + 1, source_command_id = ?, updated_at = ?
        WHERE id = ? AND event_id = ? AND round = 'FINAL'
          AND status IN ('PLANNED', 'LOADING')
          AND EXISTS (
            SELECT 1 FROM race_commands correction
             WHERE correction.id = ? AND correction.event_id = heats.event_id
               AND correction.command_type = 'CORRECT_HEAT_RESULT'
               AND correction.result_id = ?
          )`,
    ).bind(commandId, now, promotion.final_heat_id, eventId, commandId, heatId));
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
  registration_status: string;
  visible_number: number;
  qualifying_heat_id: string;
  qualifying_heat_number: number;
  podium_place: number | null;
}

// The staff finalist list, like every other staff roster, keeps a withdrawn or
// disqualified finalist visible and marked. They won their round-one heat and
// their duck is in the final's bag, so the bag and this list have to agree; what
// changed is only that they can no longer take a podium place. The public
// podium, which is projected separately by `race-board.ts`, still omits them.
const finalistRows = (
  env: Env,
  eventId: string,
): Promise<D1Result<FinalistRow>> => env.DB.prepare(
  `SELECT final_entry.race_entry_id, final_entry.slot_number,
          r.first_name, r.last_name, r.status AS registration_status,
          d.visible_number,
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
  const event = await env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(eventId).first<{ id: string }>();
  if (event === null) return json({ error: "Event not found." }, 404);
  const finalists = await finalistRows(env, eventId);
  return json({
    finalists: finalists.results.map((row) => ({
      raceEntryId: row.race_entry_id,
      slotNumber: row.slot_number,
      eligible: row.registration_status === "ACTIVE",
      participant: {
        firstName: row.first_name,
        lastName: row.last_name,
        registrationStatus: row.registration_status,
      },
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
  const winnerByTagMatch = url.pathname.match(/^\/api\/v1\/staff\/ducks\/([A-Za-z0-9_-]{22,128})\/heat-winner$/);
  if (winnerByTagMatch !== null && request.method === "POST") {
    const denied = requireAnyRole(actor, ["RESULT_TAKER", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return finalizeWinnerByTag(request, env, actor, winnerByTagMatch[1]);
  }
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
  if (operation === "/podium-place/clear" && request.method === "POST") {
    const denied = requireAnyRole(actor, ["RESULT_TAKER", "RACE_DIRECTOR"]);
    if (denied !== null) return denied;
    return clearFinalPodiumPlace(request, env, actor, eventId, heatId);
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
