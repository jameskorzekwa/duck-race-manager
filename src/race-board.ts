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
  place: number | null;
}

export interface PublicRaceBoardEntry {
  participantDisplayName: string;
  duckNumber: number | null;
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

const currentEvent = (env: Env): Promise<BoardEventRow | null> => env.DB.prepare(
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
  const event = await currentEvent(env);
  if (event === null) return { event: null };

  const rows = await env.DB.prepare(
    `SELECT h.id AS heat_id, h.round, h.heat_number, h.status AS heat_status,
            he.slot_number, r.first_name, r.last_name, d.visible_number,
            CASE WHEN h.status = 'FINALIZED' THEN hr.place ELSE NULL END AS place
       FROM heats h
       LEFT JOIN heat_entries he ON he.heat_id = h.id AND he.event_id = h.event_id
       LEFT JOIN race_entries re ON re.id = he.race_entry_id
       LEFT JOIN registrations r ON r.id = re.registration_id
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
               h.heat_number, he.slot_number`,
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
