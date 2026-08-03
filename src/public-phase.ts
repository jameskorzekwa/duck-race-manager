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
// registration is still open, and redirects home during Preparing.
export const phaseAllowsRegistration = (phase: PublicPhase): boolean => phase === "REGISTRATION";
export const phaseAllowsRaceStatus = (phase: PublicPhase): boolean => phase !== "PREPARING";

// Navigation. Register and Race Status strictly swap: the nav offers exactly one
// of them after DRAFT and neither while a race is being prepared. `/race` stays
// reachable during Registration even though the nav does not advertise it.
export const phaseShowsRegisterNav = phaseAllowsRegistration;
export const phaseShowsRaceStatusNav = (phase: PublicPhase): boolean =>
  phase !== "PREPARING" && phase !== "REGISTRATION";
// My Ducks follows the phase because the route redirects home during Preparing.
// The saved-registration probe still controls the page layout once it is open.
export const phaseShowsMyDucks = (phase: PublicPhase): boolean => phase !== "PREPARING";

// Preparing wording belongs to `/register` alone. It is the one page that may
// tell a visitor to come back and register, and it is a terminal single-message
// page while the race is being prepared. `/race` has no preparing wording at
// all: `phaseAllowsRaceStatus` is false during Preparing and the route sends the
// visitor home instead of painting an empty race-status page.
export const registrationPreparingMessage =
  "The next race is being prepared. Registration is not open yet, please come back later to register!";
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

// The phase a page renders when the current-event query cannot be answered.
// PREPARING is the same phase "no public event" already produces, so a degraded
// paint is an ordinary, already-tested page rather than a new state, and it is
// the conservative choice: it advertises neither Register nor Race Status, so a
// database hiccup can never invite a visitor into a flow that is not open.
export const fallbackPublicPhase: PublicPhase = "PREPARING";

export interface PublicRenderContext {
  phase: PublicPhase;
  smsNotificationsAvailable: boolean;
}

export const fallbackPublicRenderContext: PublicRenderContext = {
  phase: fallbackPublicPhase,
  smsNotificationsAvailable: false,
};

// One lightweight query so every server-rendered page can paint the correct
// navigation immediately. The status ordering matches `GET /api/v1/events/current`
// in `api.ts`, which is the same projection the browser re-reads when the live
// hub signals an event change; the two must not disagree.
//
// This resolver stays honest and rejects on a database failure. Page renders
// must use `publicPhaseForRender`; API handlers that legitimately depend on D1
// keep surfacing their errors.
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

// `/register` needs the same phase plus one event-level capability. It resolves
// both in this single query rather than adding a second D1 read to that page.
export const getPublicRenderContext = async (env: Env): Promise<PublicRenderContext> => {
  const row = await env.DB.prepare(
    `SELECT status, sms_notifications_enabled
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
  ).first<{ status: string; sms_notifications_enabled: number }>();
  return {
    phase: publicPhaseForStatus(row?.status),
    smsNotificationsAvailable: row?.sms_notifications_enabled === 1,
  };
};

// Navigation chrome is not worth an outage. Before the site became
// phase-driven, public pages such as the home page rendered without touching D1
// at all, so an unavailable, degraded, or transient D1 failure must not turn a
// page render into a 500 the way it would if the rejection escaped.
//
// The degraded paint self-corrects: every public content page carries
// `data-live-nav`, and `live-ui.js` rebuilds the navigation from
// `GET /api/v1/events/current` on the next live signal or poll, so the visitor
// sees the true phase within seconds of D1 recovering.
//
// Only HTML page renders may use this. API routes must keep failing loudly.
export const publicContextForRender = async (env: Env): Promise<PublicRenderContext> => {
  try {
    return await getPublicRenderContext(env);
  } catch {
    // Deliberately not logged: Worker invocation logs stay disabled because
    // private credentials occur in URL paths. The failure stays observable
    // where that is already the convention — `/health` and every API route that
    // reads the same data still fail on a broken database — so this catch
    // narrows a page render, not the diagnosis.
    return fallbackPublicRenderContext;
  }
};

export const publicPhaseForRender = async (env: Env): Promise<PublicPhase> => {
  try {
    return await getPublicPhase(env);
  } catch {
    return fallbackPublicPhase;
  }
};
