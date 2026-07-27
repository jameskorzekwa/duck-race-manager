import type { Env } from "./types.ts";

// The public site is driven by one derived phase rather than by raw lifecycle
// statuses, so navigation, home CTAs, `/register`, and `/race` can never
// disagree about what a visitor is allowed to do right now.
//
// | Phase        | Event state                | Nav                                      |
// | ------------ | -------------------------- | ---------------------------------------- |
// | PREPARING    | no event or DRAFT          | Home, Staff                              |
// | REGISTRATION | REGISTRATION_OPEN          | Home, Register, My Ducks, Staff          |
// | LOCKED_IN    | REGISTRATION_CLOSED        | Home, Race Status, My Ducks, Staff       |
// | RACING       | ROUND_ONE, FINAL           | Home, Race Status, My Ducks, Staff       |
// | RESULTS      | COMPLETED                  | Home, Race Status, My Ducks, Staff       |
export type PublicPhase = "PREPARING" | "REGISTRATION" | "LOCKED_IN" | "RACING" | "RESULTS";

// DRAFT is deliberately absent: it selects no public event at all, so it falls
// through to PREPARING exactly like "no event".
export const publicPhaseByStatus: Readonly<Record<string, PublicPhase>> = {
  REGISTRATION_OPEN: "REGISTRATION",
  REGISTRATION_CLOSED: "LOCKED_IN",
  ROUND_ONE: "RACING",
  FINAL: "RACING",
  COMPLETED: "RESULTS",
};

export const publicPhaseForStatus = (status: string | null | undefined): PublicPhase =>
  typeof status === "string" && Object.hasOwn(publicPhaseByStatus, status)
    ? publicPhaseByStatus[status]
    : "PREPARING";

// Page availability. `/register` is reachable only while registration is open;
// `/race` is reachable for all five post-DRAFT statuses, including while
// registration is still open.
export const phaseAllowsRegistration = (phase: PublicPhase): boolean => phase === "REGISTRATION";
export const phaseAllowsRaceStatus = (phase: PublicPhase): boolean => phase !== "PREPARING";

// Navigation. Register and Race Status strictly swap: the nav offers exactly one
// of them after DRAFT and neither while a race is being prepared. `/race` stays
// reachable during Registration even though the nav does not advertise it.
export const phaseShowsRegisterNav = phaseAllowsRegistration;
export const phaseShowsRaceStatusNav = (phase: PublicPhase): boolean =>
  phase !== "PREPARING" && phase !== "REGISTRATION";
// My Ducks is additionally revealed client-side by the saved-registration
// presence probe, so this is only the phase half of the rule.
export const phaseShowsMyDucks = (phase: PublicPhase): boolean => phase !== "PREPARING";

// Preparing wording is per page, not shared: `/register` is where a visitor is
// told to come back and register, and `/race` is a race-status page where that
// call to action would be wrong. Both are terminal single-message pages.
export const registrationPreparingMessage =
  "The next race is being prepared. Registration is not open yet, please come back later to register!";
export const racePreparingMessage =
  "The next race is being prepared. Live race status will appear here once the race begins.";
export const registrationClosedMessage = "Registration is closed.";

export interface PublicPhaseCta {
  href: string;
  label: string;
}

export const homePhaseCta: Readonly<Record<PublicPhase, PublicPhaseCta | null>> = {
  PREPARING: null,
  REGISTRATION: { href: "/register", label: "Register" },
  LOCKED_IN: { href: "/race", label: "View race status" },
  RACING: { href: "/race", label: "View live race" },
  RESULTS: { href: "/race", label: "View results" },
};

// One lightweight query so every server-rendered page can paint the correct
// navigation immediately. The status ordering matches `GET /api/v1/events/current`
// in `api.ts`, which is the same projection the browser re-reads when the live
// hub signals an event change; the two must not disagree.
export const getPublicPhase = async (env: Env): Promise<PublicPhase> => {
  const row = await env.DB.prepare(
    `SELECT status
       FROM events
      WHERE status IN (
        'REGISTRATION_OPEN',
        'REGISTRATION_CLOSED',
        'ROUND_ONE',
        'FINAL',
        'COMPLETED'
      )
      ORDER BY CASE status
        WHEN 'REGISTRATION_OPEN' THEN 0
        WHEN 'REGISTRATION_CLOSED' THEN 1
        WHEN 'ROUND_ONE' THEN 2
        WHEN 'FINAL' THEN 3
        ELSE 5
      END,
      event_date IS NULL,
      event_date
      LIMIT 1`,
  ).first<{ status: string }>();
  return publicPhaseForStatus(row?.status);
};
