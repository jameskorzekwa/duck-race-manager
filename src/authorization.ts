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
