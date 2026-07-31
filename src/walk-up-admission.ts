// A Round One heat is "unstarted" until its first committed START_HEAT
// command. `started_at` alone is not durable because a reset clears it; once the
// final heat has begun, resetting that heat must never reopen walk-up admission.
export const heatHasNeverStartedSql = (heatAlias: string): string => `
  ${heatAlias}.status IN ('LOADING', 'READY', 'CALLING')
  AND NOT EXISTS (
    SELECT 1 FROM race_commands walk_up_start
     WHERE walk_up_start.event_id = ${heatAlias}.event_id
       AND walk_up_start.command_type = 'START_HEAT'
       AND walk_up_start.result_id = ${heatAlias}.id
  )`;

export const unstartedRoundOneHeatExistsSql = (eventExpression: string): string => `EXISTS (
  SELECT 1 FROM heats walk_up_heat
   WHERE walk_up_heat.event_id = ${eventExpression}
     AND walk_up_heat.round = 'ROUND_ONE'
     AND ${heatHasNeverStartedSql("walk_up_heat")}
)`;

export interface WalkUpAdmission {
  allowed: boolean;
  reason: string;
}

// The answer for an event that does not exist, stated once so the server and the
// console's own no-event branch cannot drift into two different sentences.
// Deleting the event is the case that actually reaches this on race day.
export const WALK_UP_ADMISSION_WITHOUT_EVENT: WalkUpAdmission = {
  allowed: false,
  reason: "Walk-up registration is unavailable until an event is ready for registration.",
};

export const walkUpAdmissionFor = (status: string, allowed: boolean): WalkUpAdmission => {
  if (allowed && status === "ROUND_ONE") {
    return {
      allowed: true,
      reason: "Walk-up registration stays open until the final unstarted Round One heat begins.",
    };
  }
  if (allowed) return { allowed: true, reason: "Walk-up registration is open." };
  if (status === "ROUND_ONE") {
    return {
      allowed: false,
      reason: "Walk-up registration has closed because every Round One heat has started.",
    };
  }
  return {
    allowed: false,
    reason: "Walk-up registration is available while registration is open and until the final unstarted Round One heat begins.",
  };
};
