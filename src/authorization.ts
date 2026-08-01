import type { StaffActor } from "./auth.ts";

export const operationalRoles = [
  "REGISTRATION",
  "DUCK_MANAGER",
  "ANNOUNCER",
  "HEAT_RUNNER",
  "RESULT_TAKER",
  "RACE_DIRECTOR",
] as const;

export type OperationalRole = typeof operationalRoles[number];

const operationalRoleSet = new Set<string>(operationalRoles);

export const isOperationalRole = (value: unknown): value is OperationalRole =>
  typeof value === "string" && operationalRoleSet.has(value);

// The single strict reader for role vocabulary, used for both caller-supplied
// values and values already stored in D1. Anything outside the current
// vocabulary — including the retired RETURN_STEWARD — invalidates the whole
// list instead of being silently dropped, so a grant or role change is
// rejected and a corrupt stored assignment set denies rather than authorizes.
// `staff_role_assignments` now constrains `role` to exactly this vocabulary and
// its partial unique index forbids duplicate current roles, so a stored set can
// only fail this check if the database has been corrupted out of band.
export const normalizeOperationalRoles = (
  value: unknown,
  requireNonempty = false,
): OperationalRole[] | null => {
  if (!Array.isArray(value)) return null;
  if (requireNonempty && value.length === 0) return null;
  if (value.some((role) => !isOperationalRole(role))) return null;
  const roles = value as OperationalRole[];
  if (new Set(roles).size !== roles.length) return null;
  return operationalRoles.filter((role) => roles.includes(role));
};

export const hasAnyRole = (
  actor: StaffActor,
  roles: readonly OperationalRole[],
): boolean => actor.isSystemAdmin || roles.some((role) => actor.roles.includes(role));

export const hasAllRoles = (
  actor: StaffActor,
  roles: readonly OperationalRole[],
): boolean => actor.isSystemAdmin || roles.every((role) => actor.roles.includes(role));

export const forbidden = (): Response => Response.json(
  { error: "Permission required." },
  {
    status: 403,
    headers: {
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
    },
  },
);

export const requireAnyRole = (
  actor: StaffActor,
  roles: readonly OperationalRole[],
): Response | null => hasAnyRole(actor, roles) ? null : forbidden();

export const requireAllRoles = (
  actor: StaffActor,
  roles: readonly OperationalRole[],
): Response | null => hasAllRoles(actor, roles) ? null : forbidden();

export const canViewParticipantPii = (actor: StaffActor): boolean =>
  hasAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"]);

// Recording which duck won a heat is open to every staff member, whichever way
// it is recorded: by scanning the winning duck's permanent NFC tag, or through
// the finish line's last-resort manual selector when that tag will not scan.
//
// This is deliberately wider than the rest of the race-day matrix. Whoever is
// standing at the water's edge when a heat ends is the only person who saw
// which duck arrived first, and that is not reliably the one staffer holding
// RESULT_TAKER. Narrowing it to that role is what forced a heat runner to find
// somebody else before the result could be recorded, with the next heat already
// forming up behind them.
//
// It is an explicit list rather than "any authenticated staff" on purpose: a
// Cognito identity alone still authorizes nothing, and a profile with no
// operational role at all is still refused, so this widens who may record a
// winner without introducing a missing-role fallback.
//
// It is exactly the set of race-day roles that can already read a heat and its
// roster. That boundary is deliberate and load-bearing: `/staff/finish-line`
// fetches the heat list and heat detail the moment it opens, so a role admitted
// to the station but not to those reads would be handed a station that instantly
// 403s. The registration desk and the duck manager are not on the water and are
// not admitted here; the roles that stand at the pond all are.
//
// Both winner-recording commands share this one list so a scanned winner and a
// manually selected one cannot drift apart. Everything that comes *after* a
// published result — reopening it, correcting it, resetting the heat — stays
// with the race director, because undoing an official result is a different
// decision from taking one.
export const winnerRecordingRoles: readonly OperationalRole[] = [
  "ANNOUNCER",
  "HEAT_RUNNER",
  "RESULT_TAKER",
  "RACE_DIRECTOR",
];
