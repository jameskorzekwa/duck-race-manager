import type { StaffActor } from "./auth.ts";
import { isCommandId } from "./registration.ts";
import {
  cognitoStaffLifecycle,
  type StaffIdentityLifecycle,
} from "./staff-access.ts";
import type { Env } from "./types.ts";

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
  if (Number.isFinite(length) && length > 8_192) return null;
  try {
    const body = await request.text();
    if (body.length > 8_192) return null;
    const parsed = JSON.parse(body) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
};

type StaffRole = "ADMIN" | "STAFF";
type LifecycleCommandType = "CHANGE_STAFF_ROLE" | "DEACTIVATE_STAFF" | "REACTIVATE_STAFF";

interface StaffProfileRow {
  id: string;
  email: string;
  display_name: string | null;
  is_system_admin: number;
  is_active: number;
  created_at: string;
}

interface LifecycleCommandRow {
  command_type: LifecycleCommandType;
  target_staff_profile_id: string;
  requested_role: StaffRole | null;
  result_is_system_admin: number;
  result_is_active: number;
  id: string;
  email: string;
  display_name: string | null;
  created_at: string;
}

const staffProfileResponse = (
  profile: StaffProfileRow,
  result: { isSystemAdmin: number; isActive: number } = {
    isSystemAdmin: profile.is_system_admin,
    isActive: profile.is_active,
  },
): Record<string, unknown> => ({
  id: profile.id,
  email: profile.email,
  displayName: profile.display_name,
  role: result.isSystemAdmin === 1 ? "ADMIN" : "STAFF",
  createdAt: profile.created_at,
  active: result.isActive === 1,
});

const listStaffProfiles = async (env: Env, actor: StaffActor): Promise<Response> => {
  if (!actor.isSystemAdmin) return json({ error: "Administrator permission required." }, 403);
  const profiles = await env.DB.prepare(
    `SELECT id, email, display_name, is_system_admin, is_active, created_at
       FROM staff_profiles
      ORDER BY is_system_admin DESC, COALESCE(display_name, email) COLLATE NOCASE, email COLLATE NOCASE
      LIMIT 200`,
  ).all<StaffProfileRow>();
  return json({ staff: profiles.results.map((profile) => staffProfileResponse(profile)) });
};

const findCommand = (commandId: string, env: Env): Promise<LifecycleCommandRow | null> =>
  env.DB.prepare(
    `SELECT c.command_type, c.target_staff_profile_id, c.requested_role,
            c.result_is_system_admin, c.result_is_active,
            p.id, p.email, p.display_name, p.created_at
       FROM staff_lifecycle_commands c
       JOIN staff_profiles p ON p.id = c.target_staff_profile_id
      WHERE c.id = ?
      LIMIT 1`,
  ).bind(commandId).first<LifecycleCommandRow>();

const commandMatches = (
  command: LifecycleCommandRow,
  commandType: LifecycleCommandType,
  targetId: string,
  role: StaffRole | null,
): boolean => command.command_type === commandType
  && command.target_staff_profile_id === targetId
  && command.requested_role === role;

const commandResponse = (command: LifecycleCommandRow): Response => json({
  staff: staffProfileResponse({
    ...command,
    is_system_admin: command.result_is_system_admin,
    is_active: command.result_is_active,
  }),
  replayed: true,
});

const findTarget = (targetId: string, env: Env): Promise<StaffProfileRow | null> =>
  env.DB.prepare(
    `SELECT id, email, display_name, is_system_admin, is_active, created_at
       FROM staff_profiles
      WHERE id = ?
      LIMIT 1`,
  ).bind(targetId).first<StaffProfileRow>();

const hasAnotherActiveAdmin = async (targetId: string, env: Env): Promise<boolean> => {
  const administrator = await env.DB.prepare(
    `SELECT id
       FROM staff_profiles
      WHERE id != ? AND is_system_admin = 1 AND is_active = 1
      LIMIT 1`,
  ).bind(targetId).first<{ id: string }>();
  return administrator !== null;
};

const replayAfterConflict = async (
  commandId: string,
  commandType: LifecycleCommandType,
  targetId: string,
  role: StaffRole | null,
  env: Env,
): Promise<Response | null> => {
  const replay = await findCommand(commandId, env);
  return replay !== null && commandMatches(replay, commandType, targetId, role)
    ? commandResponse(replay)
    : null;
};

const persistLifecycle = async (
  env: Env,
  actor: StaffActor,
  profile: StaffProfileRow,
  commandId: string,
  commandType: LifecycleCommandType,
  role: StaffRole | null,
  resultIsSystemAdmin: number,
  resultIsActive: number,
  action: "STAFF_ROLE_CHANGED" | "STAFF_DEACTIVATED" | "STAFF_REACTIVATED",
  details: Record<string, unknown>,
): Promise<void> => {
  const now = new Date().toISOString();
  const update = commandType === "CHANGE_STAFF_ROLE"
    ? env.DB.prepare(
      `UPDATE staff_profiles
          SET is_system_admin = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(resultIsSystemAdmin, now, profile.id)
    : env.DB.prepare(
      `UPDATE staff_profiles
          SET is_active = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(resultIsActive, now, profile.id);
  await env.DB.batch([
    update,
    env.DB.prepare(
      `INSERT INTO staff_lifecycle_commands
        (id, command_type, target_staff_profile_id, requested_by_staff_profile_id,
         requested_role, result_is_system_admin, result_is_active, requested_at, completed_at)
       SELECT ?, ?, ?, ?, ?, p.is_system_admin, p.is_active, ?, ?
         FROM staff_profiles p
        WHERE p.id = ?`,
    ).bind(
      commandId,
      commandType,
      profile.id,
      actor.id,
      role,
      now,
      now,
      profile.id,
    ),
    env.DB.prepare(
      `INSERT INTO staff_lifecycle_audit_events
        (id, command_id, actor_staff_profile_id, target_staff_profile_id,
         action, occurred_at, details_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      commandId,
      actor.id,
      profile.id,
      action,
      now,
      JSON.stringify(details),
    ),
  ]);
};

const roleChange = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  targetId: string,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  const role = payload?.role;
  if (typeof commandId !== "string" || !isCommandId(commandId) || (role !== "ADMIN" && role !== "STAFF")) {
    return json({ error: "Command and staff role are required." }, 400);
  }

  const existingCommand = await findCommand(commandId, env);
  if (existingCommand !== null) {
    return commandMatches(existingCommand, "CHANGE_STAFF_ROLE", targetId, role)
      ? commandResponse(existingCommand)
      : json({ error: "This command identifier was already used for another staff lifecycle operation." }, 409);
  }

  const profile = await findTarget(targetId, env);
  if (profile === null) return json({ error: "Staff profile not found." }, 404);
  if (actor.id === profile.id && profile.is_system_admin === 1 && role === "STAFF") {
    return json({ error: "Administrators cannot demote their own account." }, 409);
  }
  if (
    profile.is_active === 1
    && profile.is_system_admin === 1
    && role === "STAFF"
    && !await hasAnotherActiveAdmin(profile.id, env)
  ) {
    return json({ error: "The final active administrator cannot be demoted." }, 409);
  }

  const resultIsSystemAdmin = role === "ADMIN" ? 1 : 0;
  try {
    await persistLifecycle(
      env,
      actor,
      profile,
      commandId,
      "CHANGE_STAFF_ROLE",
      role,
      resultIsSystemAdmin,
      profile.is_active,
      "STAFF_ROLE_CHANGED",
      {
        previousRole: profile.is_system_admin === 1 ? "ADMIN" : "STAFF",
        role,
      },
    );
  } catch {
    const replay = await replayAfterConflict(commandId, "CHANGE_STAFF_ROLE", targetId, role, env);
    if (replay !== null) return replay;
    if (
      profile.is_active === 1
      && profile.is_system_admin === 1
      && role === "STAFF"
      && !await hasAnotherActiveAdmin(profile.id, env)
    ) {
      return json({ error: "The final active administrator cannot be demoted." }, 409);
    }
    return json({ error: "The role change conflicted with another update. Refresh and try again." }, 409);
  }

  const updated = await findTarget(profile.id, env);
  return json({
    staff: staffProfileResponse(updated ?? profile, updated === null ? {
      isSystemAdmin: resultIsSystemAdmin,
      isActive: profile.is_active,
    } : undefined),
    replayed: false,
  });
};

const compensate = async (action: () => Promise<void>): Promise<boolean> => {
  try {
    await action();
    return true;
  } catch {
    return false;
  }
};

const changeActiveState = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  targetId: string,
  active: boolean,
  identity: StaffIdentityLifecycle,
): Promise<Response> => {
  const payload = await readJson(request);
  const commandId = payload?.commandId;
  if (typeof commandId !== "string" || !isCommandId(commandId)) {
    return json({ error: "A valid command identifier is required." }, 400);
  }
  const commandType = active ? "REACTIVATE_STAFF" : "DEACTIVATE_STAFF";
  const action = active ? "STAFF_REACTIVATED" : "STAFF_DEACTIVATED";

  const existingCommand = await findCommand(commandId, env);
  if (existingCommand !== null) {
    return commandMatches(existingCommand, commandType, targetId, null)
      ? commandResponse(existingCommand)
      : json({ error: "This command identifier was already used for another staff lifecycle operation." }, 409);
  }

  const profile = await findTarget(targetId, env);
  if (profile === null) return json({ error: "Staff profile not found." }, 404);
  if (!active && actor.id === profile.id) {
    return json({ error: "Administrators cannot deactivate their own account." }, 409);
  }
  if (
    !active
    && profile.is_active === 1
    && profile.is_system_admin === 1
    && !await hasAnotherActiveAdmin(profile.id, env)
  ) {
    return json({ error: "The final active administrator cannot be deactivated." }, 409);
  }

  try {
    if (active) {
      await identity.enable(profile.email, env);
    } else {
      await identity.disable(profile.email, env);
      try {
        await identity.globalSignOut(profile.email, env);
      } catch {
        const restored = await compensate(() => identity.enable(profile.email, env));
        return restored
          ? json({ error: "Cognito could not end every staff session. No lifecycle change was saved." }, 502)
          : json({ error: "Cognito staff access could not be reconciled. Retry with the same command identifier." }, 502);
      }
    }
  } catch {
    return json({ error: `Cognito could not ${active ? "reactivate" : "deactivate"} this staff account. Try again.` }, 502);
  }

  try {
    await persistLifecycle(
      env,
      actor,
      profile,
      commandId,
      commandType,
      null,
      profile.is_system_admin,
      active ? 1 : 0,
      action,
      {
        previousActive: profile.is_active === 1,
        active,
        role: profile.is_system_admin === 1 ? "ADMIN" : "STAFF",
      },
    );
  } catch {
    const replay = await replayAfterConflict(commandId, commandType, targetId, null, env);
    if (replay !== null) return replay;

    const restored = active
      ? await compensate(() => identity.disable(profile.email, env))
      : await compensate(() => identity.enable(profile.email, env));
    if (!restored) {
      return json({ error: "Cognito staff access could not be reconciled. Retry with the same command identifier." }, 502);
    }
    if (
      !active
      && profile.is_active === 1
      && profile.is_system_admin === 1
      && !await hasAnotherActiveAdmin(profile.id, env)
    ) {
      return json({ error: "The final active administrator cannot be deactivated." }, 409);
    }
    return json({ error: "The lifecycle change conflicted with another update. Refresh and try again." }, 409);
  }

  const updated = await findTarget(profile.id, env);
  return json({
    staff: staffProfileResponse(updated ?? profile, updated === null ? {
      isSystemAdmin: profile.is_system_admin,
      isActive: active ? 1 : 0,
    } : undefined),
    replayed: false,
  });
};

export const handleStaffLifecycleOperations = async (
  request: Request,
  env: Env,
  actor: StaffActor,
  identity: StaffIdentityLifecycle = cognitoStaffLifecycle,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname === "/api/v1/staff/profiles" && request.method === "GET") {
    return listStaffProfiles(env, actor);
  }

  const match = url.pathname.match(/^\/api\/v1\/staff\/profiles\/([^/]{1,128})\/(role|deactivate|reactivate)$/);
  if (match === null || request.method !== "POST") return null;
  if (!actor.isSystemAdmin) return json({ error: "Administrator permission required." }, 403);

  if (match[2] === "role") return roleChange(request, env, actor, match[1]);
  return changeActiveState(request, env, actor, match[1], match[2] === "reactivate", identity);
};
