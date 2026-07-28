import { publicDuckName } from "./duck-name-filter.ts";
import type { Env } from "./types.ts";

type BoardRound = "ROUND_ONE" | "FINAL";
type BoardHeatStatus = "PLANNED" | "LOADING" | "READY" | "CALLING" | "RUNNING"
  | "AWAITING_RESULT" | "FINALIZED" | "CANCELLED";

const eventStatuses = new Set(["REGISTRATION_OPEN", "REGISTRATION_CLOSED", "ROUND_ONE", "FINAL", "COMPLETED"]);
const heatStatuses = new Set<BoardHeatStatus>([
  "PLANNED", "LOADING", "READY", "CALLING", "RUNNING", "AWAITING_RESULT", "FINALIZED", "CANCELLED",
]);

interface BoardEventRow {
  id: string;
  name: string;
  event_date: string | null;
  status: string;
  public_name_policy: string;
}

interface BoardRow {
  heat_id: string;
  round: BoardRound;
  heat_number: number;
  heat_status: BoardHeatStatus;
  slot_number: number | null;
  first_name: string | null;
  last_name: string | null;
  visible_number: number | null;
  duck_name: string | null;
  place: number | null;
}

export interface PublicRaceBoardEntry {
  participantDisplayName: string;
  duckNumber: number | null;
  // The participant-chosen name, filtered at read time, or null. The board
  // always keeps `duckNumber` beside it.
  duckName: string | null;
  place: number | null;
}

export interface PublicRaceBoardHeat {
  round: BoardRound;
  number: number;
  status: BoardHeatStatus;
  roster: PublicRaceBoardEntry[];
}

export interface PublicRaceBoard {
  event: null | {
    name: string;
    eventDate: string | null;
    status: string;
    currentHeat: { round: BoardRound; number: number; status: BoardHeatStatus } | null;
    roundOneHeats: PublicRaceBoardHeat[];
    finalHeats: PublicRaceBoardHeat[];
    podium: PublicRaceBoardEntry[];
  };
}

export const publicDisplayName = (
  policy: string,
  firstName: string,
  lastName: string,
): string => {
  if (policy === "FULL_NAME") return `${firstName} ${lastName}`;
  if (policy === "FIRST_NAME_ONLY" || lastName.length === 0) return firstName;
  return `${firstName} ${lastName.slice(0, 1).toUpperCase()}.`;
};

// The one event the public board renders. Every other public view that resolves
// a board-visible identifier reuses this selection so a duck number always
// resolves inside the same race the board is showing.
export const getCurrentPublicEvent = (env: Env): Promise<BoardEventRow | null> => env.DB.prepare(
  `SELECT id, name, event_date, status, public_name_policy
     FROM events
    WHERE status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
    ORDER BY CASE status
      WHEN 'ROUND_ONE' THEN 0
      WHEN 'FINAL' THEN 1
      WHEN 'COMPLETED' THEN 2
      WHEN 'REGISTRATION_CLOSED' THEN 3
      ELSE 4
    END,
    event_date IS NULL,
    event_date
    LIMIT 1`,
).first<BoardEventRow>();

const currentHeat = (heats: PublicRaceBoardHeat[]): PublicRaceBoardHeat | undefined => {
  for (const status of ["RUNNING", "AWAITING_RESULT", "CALLING"] as const) {
    const heat = heats.find((candidate) => candidate.status === status);
    if (heat !== undefined) return heat;
  }
  return undefined;
};

export const getPublicRaceBoard = async (env: Env): Promise<PublicRaceBoard> => {
  const event = await getCurrentPublicEvent(env);
  if (event === null) return { event: null };

  // A withdrawn or disqualified participant is publicly not racing. Their duck
  // stays physically in its heat bag and may still float past the finish line,
  // but the board, the current-heat roster, the finalists, and the podium must
  // all behave as if it is not there.
  //
  // The exclusion sits on the `registrations` join rather than in the WHERE
  // clause for two reasons. The heat row itself survives, because a LEFT JOIN
  // that matches nothing still yields the heat, so a heat whose every racer left
  // is still published as a heat instead of vanishing from the board. And the
  // participant's name is never fetched at all, so it cannot leak through a
  // later change to this projection. The existing first/last name null check
  // below is what drops the roster entry, and it is the same check that already
  // drops a heat with no entries.
  //
  // Omission never renumbers anything: the remaining entries keep their stored
  // slot order and their printed duck numbers exactly as the physical bags hold
  // them, and the podium is derived from the surviving final rosters, so a
  // participant who left can never be published as a winner.
  const rows = await env.DB.prepare(
    `SELECT h.id AS heat_id, h.round, h.heat_number, h.status AS heat_status,
            he.slot_number, r.first_name, r.last_name, d.visible_number,
            re.duck_name,
            CASE WHEN h.status = 'FINALIZED' THEN hr.place ELSE NULL END AS place
       FROM heats h
       LEFT JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
       LEFT JOIN race_entries re ON re.id = he.race_entry_id
       LEFT JOIN registrations r
         ON r.id = re.registration_id AND r.status IN ('SUBMITTED', 'ACTIVE')
        LEFT JOIN duck_assignments da ON da.id = (
          SELECT da2.id FROM duck_assignments da2
           WHERE da2.event_id = he.event_id AND da2.race_entry_id = he.race_entry_id
             AND da2.valid_to IS NULL
           LIMIT 1
        )
       LEFT JOIN ducks d ON d.id = da.duck_id
       LEFT JOIN heat_results hr
         ON hr.heat_id = h.id AND hr.race_entry_id = he.race_entry_id AND hr.status = 'FINALIZED'
      WHERE h.event_id = ?
      ORDER BY CASE h.round WHEN 'ROUND_ONE' THEN 0 ELSE 1 END,
               h.heat_number,
               CASE WHEN h.status = 'FINALIZED' AND hr.place = 1 THEN 0 ELSE 1 END,
               he.slot_number`,
  ).bind(event.id).all<BoardRow>();

  const byHeat = new Map<string, PublicRaceBoardHeat>();
  for (const row of rows.results) {
    let heat = byHeat.get(row.heat_id);
    if (heat === undefined) {
      heat = {
        round: row.round,
        number: row.heat_number,
        status: heatStatuses.has(row.heat_status) ? row.heat_status : "PLANNED",
        roster: [],
      };
      byHeat.set(row.heat_id, heat);
    }
    if (row.slot_number !== null && row.first_name !== null && row.last_name !== null) {
      heat.roster.push({
        participantDisplayName: publicDisplayName(event.public_name_policy, row.first_name, row.last_name),
        duckNumber: row.visible_number,
        // A roster entry with no duck number yet carries no name either: the
        // name only means something next to the duck it belongs to.
        duckName: row.visible_number === null ? null : publicDuckName(row.duck_name),
        place: row.place,
      });
    }
  }

  const heats = [...byHeat.values()];
  const activeHeat = currentHeat(heats);
  const finalHeats = heats.filter((heat) => heat.round === "FINAL");
  const podium = finalHeats.flatMap((heat) => heat.roster)
    .filter((entry) => entry.place !== null)
    .sort((left, right) => (left.place ?? 0) - (right.place ?? 0));
  return {
    event: {
      name: event.name,
      eventDate: event.event_date,
      status: eventStatuses.has(event.status) ? event.status : "REGISTRATION_CLOSED",
      currentHeat: activeHeat === undefined ? null : {
        round: activeHeat.round,
        number: activeHeat.number,
        status: activeHeat.status,
      },
      roundOneHeats: heats.filter((heat) => heat.round === "ROUND_ONE"),
      finalHeats,
      podium,
    },
  };
};
