import type { Env } from "./types.ts";

interface StatusRow {
  event_id: string;
  event_slug: string;
  event_name: string;
  event_date: string | null;
  event_status: string;
  public_name_policy: string;
  first_name: string;
  last_name: string;
  registration_status: string;
  race_entry_id: string;
  visible_number: number | null;
  round_one_heat_number: number | null;
  round_one_heat_status: string | null;
  round_one_place: number | null;
  final_heat_number: number | null;
  final_heat_status: string | null;
  final_place: number | null;
}

interface CurrentHeatRow {
  round: string;
  heat_number: number;
  status: string;
}

// The two follow signals that ride alongside a public status. `followId` is a
// race entry identifier that is inert on its own: it unlocks nothing except the
// same public status it accompanies, and the follow endpoint revalidates it.
// `inMyDucks` reports only what this browser's own collection already contains.
export interface PublicFollowState {
  followId: string;
  inMyDucks: boolean;
}

export interface PublicRaceStatus {
  event: {
    id: string;
    slug: string;
    name: string;
    eventDate: string | null;
    status: string;
  };
  participantDisplayName: string;
  duck: { visibleNumber: number } | null;
  assignedHeat: {
    roundOne: { number: number; status: string } | null;
    final: { number: number; status: string } | null;
  };
  currentHeat: { round: string; number: number; status: string } | null;
  outcome: string;
}

// Plain race-day language for heat status and for the finalized outcomes that
// represent an official result. Server rendering and the browser client both
// read these maps so a page never changes its wording after a live refetch.
export const publicHeatStatusLabels: Record<string, string> = {
  PLANNED: "Coming up",
  LOADING: "Ducks are being prepared",
  READY: "Ready to call",
  CALLING: "Calling racers now",
  RUNNING: "Racing now",
  AWAITING_RESULT: "Race finished; checking the result",
  FINALIZED: "Result official",
  CANCELLED: "Not running",
};

export const publicHeatStatusLabel = (status: string): string =>
  Object.prototype.hasOwnProperty.call(publicHeatStatusLabels, status)
    ? publicHeatStatusLabels[status]
    : "Status being checked";

// Only outcomes decided by a finalized heat appear here. Everything else has no
// official finishing result yet and must not render one.
export const publicOfficialResults: Record<string, string> = {
  FIRST_PLACE: "1st place · Official podium",
  SECOND_PLACE: "2nd place · Official podium",
  THIRD_PLACE: "3rd place · Official podium",
  FINAL_COMPLETE: "Finished the final · Off the podium",
  ROUND_ONE_WINNER: "Won its round-one heat",
  ELIMINATED: "Did not advance past round one",
};

export const publicOfficialResult = (outcome: string): string | null =>
  Object.prototype.hasOwnProperty.call(publicOfficialResults, outcome)
    ? publicOfficialResults[outcome]
    : null;

const displayName = (policy: string, firstName: string, lastName: string): string => {
  if (policy === "FULL_NAME") return `${firstName} ${lastName}`;
  if (policy === "FIRST_NAME_ONLY" || lastName.length === 0) return firstName;
  return `${firstName} ${lastName.slice(0, 1).toUpperCase()}.`;
};

const getCurrentHeat = (env: Env, eventId: string): Promise<CurrentHeatRow | null> =>
  env.DB.prepare(
    `SELECT round, heat_number, status
       FROM heats
      WHERE event_id = ?
        AND status IN ('CALLING', 'RUNNING', 'AWAITING_RESULT')
      ORDER BY CASE status
        WHEN 'RUNNING' THEN 0
        WHEN 'AWAITING_RESULT' THEN 1
        ELSE 2
      END,
      CASE round WHEN 'ROUND_ONE' THEN 0 ELSE 1 END,
      heat_number
      LIMIT 1`,
  ).bind(eventId).first<CurrentHeatRow>();

const statusSelect = `
  SELECT e.id AS event_id, e.slug AS event_slug, e.name AS event_name,
         e.event_date, e.status AS event_status, e.public_name_policy,
         r.first_name, r.last_name, r.status AS registration_status,
         re.id AS race_entry_id, d.visible_number,
         round_heat.heat_number AS round_one_heat_number,
         round_heat.status AS round_one_heat_status,
         round_result.place AS round_one_place,
         final_heat.heat_number AS final_heat_number,
         final_heat.status AS final_heat_status,
         final_result.place AS final_place
    FROM race_entries re
    JOIN registrations r ON r.id = re.registration_id
    JOIN events e ON e.id = re.event_id
    LEFT JOIN duck_assignments da
      ON da.race_entry_id = re.id AND da.valid_to IS NULL
    LEFT JOIN ducks d ON d.id = da.duck_id
    LEFT JOIN heats round_heat ON round_heat.id = (
      SELECT he.heat_id
        FROM heat_entries he
        JOIN heats h ON h.id = he.heat_id
       WHERE he.race_entry_id = re.id AND h.round = 'ROUND_ONE'
       ORDER BY h.heat_number
       LIMIT 1
    )
    LEFT JOIN heat_results round_result
      ON round_result.heat_id = round_heat.id
     AND round_result.race_entry_id = re.id
    LEFT JOIN heats final_heat ON final_heat.id = (
      SELECT he.heat_id
        FROM heat_entries he
        JOIN heats h ON h.id = he.heat_id
       WHERE he.race_entry_id = re.id AND h.round = 'FINAL'
       ORDER BY h.heat_number
       LIMIT 1
    )
    LEFT JOIN heat_results final_result
      ON final_result.heat_id = final_heat.id
     AND final_result.race_entry_id = re.id`;

const outcome = (row: StatusRow): string => {
  if (row.registration_status === "DISQUALIFIED") return "DISQUALIFIED";
  if (row.registration_status === "WITHDRAWN") return "WITHDRAWN";
  if (row.final_place === 1) return "FIRST_PLACE";
  if (row.final_place === 2) return "SECOND_PLACE";
  if (row.final_place === 3) return "THIRD_PLACE";
  if (row.final_heat_status === "FINALIZED") return "FINAL_COMPLETE";
  if (row.final_heat_number !== null) return "FINALIST";
  if (row.round_one_place === 1) return "ROUND_ONE_WINNER";
  if (row.round_one_heat_status === "FINALIZED") return "ELIMINATED";
  if (row.round_one_heat_status === "RUNNING") return "RUNNING";
  if (row.round_one_heat_status === "AWAITING_RESULT") return "AWAITING_RESULT";
  if (row.registration_status === "SUBMITTED" || row.visible_number === null) {
    return "AWAITING_DUCK_PAIRING";
  }
  if (row.round_one_heat_number === null) return "HEAT_ASSIGNMENT_PENDING";
  return "NOT_RACED";
};

const buildStatus = async (env: Env, row: StatusRow): Promise<PublicRaceStatus> => {
  const currentHeat = await getCurrentHeat(env, row.event_id);
  return {
    event: {
      id: row.event_id,
      slug: row.event_slug,
      name: row.event_name,
      eventDate: row.event_date,
      status: row.event_status,
    },
    participantDisplayName: displayName(row.public_name_policy, row.first_name, row.last_name),
    duck: row.visible_number === null ? null : { visibleNumber: row.visible_number },
    assignedHeat: {
      roundOne: row.round_one_heat_number === null ? null : {
        number: row.round_one_heat_number,
        status: row.round_one_heat_status ?? "PLANNED",
      },
      final: row.final_heat_number === null ? null : {
        number: row.final_heat_number,
        status: row.final_heat_status ?? "PLANNED",
      },
    },
    currentHeat: currentHeat === null ? null : {
      round: currentHeat.round,
      number: currentHeat.heat_number,
      status: currentHeat.status,
    },
    outcome: outcome(row),
  };
};

export const getPublicStatusByTag = async (
  env: Env,
  token: string,
): Promise<PublicRaceStatus | null> => {
  const row = await env.DB.prepare(
    `${statusSelect}
      JOIN duck_tags dt ON dt.duck_id = d.id
     WHERE dt.token = ?
       AND dt.status = 'ACTIVE'
       AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
     LIMIT 1`,
  ).bind(token).first<StatusRow>();
  return row === null ? null : buildStatus(env, row);
};

// The visible number is already public: it is printed on the duck and shown on
// the live board. This reuses the same projection as the tag and race-entry
// lookups, and additionally scopes the row to one caller-supplied public event
// so a number can never reach an entry outside the current public race.
export const getPublicStatusByDuckNumber = async (
  env: Env,
  eventId: string,
  visibleNumber: number,
): Promise<PublicRaceStatus | null> => {
  const row = await env.DB.prepare(
    `${statusSelect}
     WHERE re.event_id = ?
       AND d.visible_number = ?
       AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
     LIMIT 1`,
  ).bind(eventId, visibleNumber).first<StatusRow>();
  return row === null ? null : buildStatus(env, row);
};

export const getPublicStatusByRaceEntry = async (
  env: Env,
  raceEntryId: string,
): Promise<PublicRaceStatus | null> => {
  const row = await env.DB.prepare(
    `${statusSelect}
     WHERE re.id = ?
       AND e.status IN ('REGISTRATION_OPEN', 'REGISTRATION_CLOSED', 'ROUND_ONE', 'FINAL', 'COMPLETED')
     LIMIT 1`,
  ).bind(raceEntryId).first<StatusRow>();
  return row === null ? null : buildStatus(env, row);
};
