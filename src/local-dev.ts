// Local development entry point. `wrangler.local.jsonc` points `main` here;
// `wrangler.jsonc` never does, so nothing in this file is bundled into the
// deployed Worker. It exists so the whole site — including authenticated staff
// surfaces — can run with no network access to Cognito or any other service.
//
// The real Worker is untouched: this module only supplies the two seams
// `createWorker` already accepts (a staff token verifier and the fetch used for
// Cognito token calls) and answers the handful of hosted-UI URLs the OAuth code
// path navigates to. Sign-in therefore exercises the production PKCE flow,
// cookie handling, D1 profile lookup, and role loading rather than bypassing it.
//
// Every request is refused unless `APP_ORIGIN` is a local address — loopback, or
// a private network address over https — and the request arrived on that same
// origin, so a copy of this module deployed by accident serves nothing.
import { authenticateStaff } from "./auth.ts";
import {
  dispatchPendingEmailNotifications,
  handleEmailQueue,
  type EmailSender,
  type OutboundEmail,
  type OutboundSms,
  type SmsSender,
} from "./email-notifications.ts";
import { createWorker } from "./index.ts";
import { isLocalPreviewOrigin, isLoopbackOrigin } from "./local-preview.ts";
import { escapeHtml } from "./site.ts";
import type { Env } from "./types.ts";

export { RaceUpdates } from "./live-updates.ts";

const accessTokenPrefix = "localdev-";
const refreshTokenPrefix = "localdevr-";
const localEmails: (OutboundEmail & { sentAt: string })[] = [];
const localSmsMessages: (OutboundSms & { sentAt: string })[] = [];

// Local development remains fully offline. The queue consumer exercises the
// production claim, rendering, status, and attempt code, while this final seam
// retains synthetic messages in memory for browser tests and local inspection.
const localEmailSender: EmailSender = async (email) => {
  localEmails.push({ ...email, sentAt: new Date().toISOString() });
  return { providerMessageId: `local-${crypto.randomUUID()}` };
};

const localSmsSender: SmsSender = async (sms) => {
  localSmsMessages.push({ ...sms, sentAt: new Date().toISOString() });
  return { providerMessageId: `local-sms-${crypto.randomUUID()}` };
};

const noStoreHtml = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; style-src 'unsafe-inline'",
  "content-type": "text/html; charset=utf-8",
  "x-robots-tag": "noindex, nofollow",
} as const;

// Staff tokens must satisfy the production charset `[A-Za-z0-9._~-]`, and a
// Cognito subject may legitimately contain characters outside it — a locally
// provisioned identity is namespaced by email address. Base64url keeps every
// subject expressible without widening the token pattern the real code enforces.
const encodeSubject = (subject: string): string => {
  const bytes = new TextEncoder().encode(subject);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const decodeSubject = (encoded: string): string | null => {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const padded = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
};

const subjectFromToken = (token: string, prefix: string): string | null =>
  token.startsWith(prefix) ? decodeSubject(token.slice(prefix.length)) : null;

export const localAccessToken = (subject: string): string => `${accessTokenPrefix}${encodeSubject(subject)}`;

// Replaces only the Cognito JWT verifier. The D1 staff-profile lookup, the
// active-profile requirement, and role loading all still run exactly as deployed,
// so local authorization behaviour matches production.
const verifyLocalToken = async (token: string): Promise<{ sub: string }> => {
  const subject = subjectFromToken(token, accessTokenPrefix);
  if (subject === null) throw new Error("Not a local preview staff token.");
  return { sub: subject };
};

const localAuthenticate: typeof authenticateStaff = (request, env) =>
  authenticateStaff(request, env, verifyLocalToken);

const formBody = (init?: RequestInit): URLSearchParams =>
  new URLSearchParams(typeof init?.body === "string" ? init.body : String(init?.body ?? ""));

// Answers the two Cognito token endpoints in process. Nothing leaves the Worker,
// so sign-in works with the machine fully offline.
const localTokenFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));

  // Revocation is acknowledged but not enforced: there is no token store to
  // revoke against, so a refresh token captured before signing out still works
  // locally. Cognito really does revoke.
  if (url.pathname === "/oauth2/revoke") return new Response(null, { status: 200 });

  if (url.pathname === "/oauth2/token") {
    const body = formBody(init);
    const grant = body.get("grant_type");
    const refreshToken = body.get("refresh_token") ?? "";
    const encodedSubject = grant === "authorization_code"
      ? body.get("code")
      : grant === "refresh_token" && refreshToken.startsWith(refreshTokenPrefix)
        ? refreshToken.slice(refreshTokenPrefix.length)
        : null;
    if (encodedSubject === null || encodedSubject === "" || decodeSubject(encodedSubject) === null) {
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    return Response.json({
      access_token: `${accessTokenPrefix}${encodedSubject}`,
      refresh_token: `${refreshTokenPrefix}${encodedSubject}`,
      expires_in: 900,
      token_type: "Bearer",
    });
  }

  return Response.json({ error: "unsupported_local_endpoint" }, { status: 404 });
};

interface LocalAccount {
  id: string;
  subject: string;
  email: string;
  displayName: string;
  isSystemAdmin: boolean;
  roles: readonly string[];
}

// One administrator plus one single-role account per operational role, so every
// role-gated surface can be opened as an actor who holds exactly the role under
// test. Administrators hold no role rows and pass role checks implicitly.
const localAccounts: readonly LocalAccount[] = [
  {
    id: "local-admin",
    subject: "local-admin",
    email: "admin@quickducks.local",
    displayName: "Avery Admin",
    isSystemAdmin: true,
    roles: [],
  },
  {
    id: "local-director",
    subject: "local-director",
    email: "director@quickducks.local",
    displayName: "Dana Director",
    isSystemAdmin: false,
    roles: ["RACE_DIRECTOR"],
  },
  {
    id: "local-registration",
    subject: "local-registration",
    email: "registration@quickducks.local",
    displayName: "Robin Registration",
    isSystemAdmin: false,
    roles: ["REGISTRATION"],
  },
  {
    id: "local-ducks",
    subject: "local-ducks",
    email: "ducks@quickducks.local",
    displayName: "Morgan Duck Manager",
    isSystemAdmin: false,
    roles: ["DUCK_MANAGER"],
  },
  {
    id: "local-announcer",
    subject: "local-announcer",
    email: "announcer@quickducks.local",
    displayName: "Alex Announcer",
    isSystemAdmin: false,
    roles: ["ANNOUNCER"],
  },
  {
    id: "local-heats",
    subject: "local-heats",
    email: "heats@quickducks.local",
    displayName: "Harper Heat Runner",
    isSystemAdmin: false,
    roles: ["HEAT_RUNNER"],
  },
  {
    id: "local-results",
    subject: "local-results",
    email: "results@quickducks.local",
    displayName: "Riley Result Taker",
    isSystemAdmin: false,
    roles: ["RESULT_TAKER"],
  },
];

const assignedAt = "2026-01-01T00:00:00.000Z";

// Idempotent: re-running leaves an already-seeded database untouched, and the
// role rows are inserted only when the profile row survives so a database that
// already carries these accounts is never given duplicate current roles.
const ensureLocalAccounts = async (env: Env): Promise<void> => {
  const statements = [];
  for (const account of localAccounts) {
    statements.push(env.DB.prepare(
      `INSERT OR IGNORE INTO staff_profiles (id, cognito_sub, email, display_name, is_system_admin, is_active)
       VALUES (?, ?, ?, ?, ?, 1)`,
    ).bind(account.id, account.subject, account.email, account.displayName, account.isSystemAdmin ? 1 : 0));
    for (const role of account.roles) {
      statements.push(env.DB.prepare(
        `INSERT OR IGNORE INTO staff_role_assignments (id, staff_profile_id, role, assigned_at)
         SELECT ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM staff_profiles WHERE id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM staff_role_assignments
               WHERE staff_profile_id = ? AND role = ? AND revoked_at IS NULL)`,
      ).bind(`${account.id}-${role}`, account.id, role, assignedAt, account.id, account.id, role));
    }
  }
  await env.DB.batch(statements);
};

const accountsResponse = (): Response =>
  Response.json({
    accounts: localAccounts.map((account) => ({
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      isSystemAdmin: account.isSystemAdmin,
      roles: account.roles,
      token: localAccessToken(account.subject),
    })),
  }, { headers: { "cache-control": "no-store" } });

const signInChooser = async (env: Env, authorizeUrl: URL): Promise<Response> => {
  const state = authorizeUrl.searchParams.get("state") ?? "";
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri") ?? "";
  const appOrigin = new URL(env.APP_ORIGIN).origin;
  // The hosted UI would only ever redirect to a registered callback. Keeping the
  // same rule locally means a mistyped configuration fails here instead of
  // sending a usable code somewhere else.
  if (!redirectUri.startsWith(`${appOrigin}/`)) {
    return new Response(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local sign-in</title></head><body><h1>Unexpected redirect target</h1><p>The sign-in request asked to return to <code>${escapeHtml(redirectUri)}</code>, which is not on <code>${escapeHtml(appOrigin)}</code>.</p></body></html>`,
      { status: 400, headers: noStoreHtml },
    );
  }

  const profiles = await env.DB.prepare(
    `SELECT p.id, p.cognito_sub, p.email, p.display_name, p.is_system_admin,
            (SELECT group_concat(r.role, ', ')
               FROM staff_role_assignments r
              WHERE r.staff_profile_id = p.id AND r.revoked_at IS NULL) AS roles
       FROM staff_profiles p
      WHERE p.is_active = 1
      ORDER BY p.is_system_admin DESC, p.email`,
  ).all<{
    id: string;
    cognito_sub: string;
    email: string;
    display_name: string | null;
    is_system_admin: number;
    roles: string | null;
  }>();

  const body = profiles.results.length === 0
    ? `<p class="empty">No staff accounts exist in the local database yet.</p>
       <form method="post" action="/__local/staff">
         <input type="hidden" name="returnTo" value="${escapeHtml(authorizeUrl.pathname + authorizeUrl.search)}">
         <button type="submit">Create the local staff accounts</button>
       </form>`
    : `<ul>${profiles.results.map((profile) => {
      const target = new URL(redirectUri);
      target.searchParams.set("code", encodeSubject(profile.cognito_sub));
      target.searchParams.set("state", state);
      const access = profile.is_system_admin === 1 ? "Administrator" : (profile.roles ?? "No roles assigned");
      return `<li><a href="${escapeHtml(target.toString())}"><strong>${escapeHtml(profile.display_name ?? profile.email)}</strong><span>${escapeHtml(profile.email)}</span><span class="roles">${escapeHtml(access)}</span></a></li>`;
    }).join("")}</ul>`;

  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local staff sign-in</title><style>
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin:0; padding:1.5rem 1rem; font-family: system-ui, sans-serif; background:#f4f7f7; color:#12333a; }
main { max-width:34rem; margin:0 auto; background:#fff; border-radius:1rem; padding:1.5rem; box-shadow:0 1px 3px rgba(0,0,0,.15); }
h1 { margin:0 0 .35rem; font-size:1.35rem; }
p { margin:0 0 1rem; color:#4a6b72; font-size:.92rem; }
ul { list-style:none; margin:0; padding:0; display:grid; gap:.6rem; }
a, button { display:block; width:100%; text-align:left; padding:.85rem 1rem; border:2px solid #cfdcde; border-radius:.7rem; background:#fbfdfd; color:inherit; text-decoration:none; font:inherit; cursor:pointer; min-height:3rem; }
a:hover, a:focus, button:hover, button:focus { border-color:#128a9c; background:#eef8fa; }
strong { display:block; font-size:1rem; }
span { display:block; font-size:.82rem; color:#4a6b72; word-break:break-word; }
.roles { font-weight:700; color:#12333a; }
.empty { font-weight:700; color:#12333a; }
.note { margin:1.2rem 0 0; font-size:.8rem; }
</style></head><body><main>
<h1>Local staff sign-in</h1>
<p>This stands in for the Cognito hosted UI. Choose the account to sign in as — no password, no email code, no network.</p>
${body}
<p class="note">Served by <code>src/local-dev.ts</code>. This page does not exist in the deployed Worker.</p>
</main></body></html>`,
    { headers: noStoreHtml },
  );
};

// Names both conditions and shows both values, because "it refused" is otherwise
// indistinguishable between "your APP_ORIGIN is wrong" and "you opened a
// different address than the one it is serving".
const refusal = (env: Env, requestUrl: URL): Response =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Local development entry point</title></head><body><h1>Refusing to run</h1>`
      + `<p>src/local-dev.ts serves a local development site only. It needs <code>APP_ORIGIN</code> to be loopback on either scheme, or a private network address over https, and it needs the request to arrive on that same origin.</p>`
      + `<ul><li>APP_ORIGIN is <code>${escapeHtml(env.APP_ORIGIN ?? "unset")}</code></li>`
      + `<li>this request arrived on <code>${escapeHtml(requestUrl.origin)}</code></li></ul>`
      + `<p>Start it with <code>npm run dev:local</code>, or <code>npm run dev:network</code> to reach it from other devices.</p></body></html>`,
    { status: 500, headers: noStoreHtml },
  );

const worker = createWorker(localAuthenticate, localTokenFetch, localEmailSender, localSmsSender);

const localWorker: ExportedHandler<Env> = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Two independent conditions, because each covers a different mistake.
    //
    // The configured origin catches this module being deployed with a production
    // config. `APP_ORIGIN` is typed as a required string, but a config can omit
    // the var and the type would not know, so it tolerates being absent.
    //
    // The request origin catches this *config* being served from anywhere but the
    // machine it was written for — `wrangler dev --remote`, or a deploy that
    // publishes a preview URL. It demands an exact match rather than merely
    // another local-looking origin, because the request's Host is chosen by the
    // caller: anyone reaching the socket could otherwise send a private-looking
    // Host and pass. Both dev commands set `APP_ORIGIN` to the address they tell
    // you to open, so an exact match is what already happens. Loopback stays
    // allowed alongside it so `http://127.0.0.1:8787` still works under
    // `dev:local`, where `APP_ORIGIN` names `localhost`.
    const appOrigin = env.APP_ORIGIN ?? "";
    if (!isLocalPreviewOrigin(appOrigin)) return refusal(env, url);
    if (url.origin !== new URL(appOrigin).origin && !isLoopbackOrigin(url.origin)) return refusal(env, url);

    if (url.pathname === "/oauth2/authorize" && request.method === "GET") {
      return signInChooser(env, url);
    }

    // Stands in for the Cognito hosted logout. The session and refresh cookies
    // are already cleared by the real logout handler before it redirects here.
    if (url.pathname === "/logout") {
      const requested = url.searchParams.get("logout_uri") ?? "/";
      const appOrigin = new URL(env.APP_ORIGIN).origin;
      const target = requested.startsWith(`${appOrigin}/`) || requested === appOrigin ? requested : appOrigin;
      return new Response(null, {
        status: 303,
        headers: { "cache-control": "no-store", location: target },
      });
    }

    if (url.pathname.startsWith("/__local/")) {
      // This endpoint mints staff, so it holds the same line as every other
      // staff mutation: a cross-origin page must not be able to reach it.
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== new URL(env.APP_ORIGIN).origin) {
        return Response.json({ error: "Cross-origin local bootstrap is not allowed." }, { status: 403 });
      }
    }

    if (url.pathname === "/__local/staff" && request.method === "POST") {
      await ensureLocalAccounts(env);
      const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
      if (contentType.startsWith("application/x-www-form-urlencoded")) {
        const submitted = await request.formData();
        const returnTo = String(submitted.get("returnTo") ?? "/staff");
        const target = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/staff";
        return new Response(null, {
          status: 303,
          headers: { "cache-control": "no-store", location: target },
        });
      }
      return accountsResponse();
    }

    // A convenience for the seeding script and for pasting a bearer token into
    // curl. It reveals only local development credentials.
    //
    // In network mode this is reachable by every device on the network, and the
    // token it returns is an administrator. That is not a hole worth plugging
    // here: the sign-in stand-in at /oauth2/authorize hands out a staff session
    // to anyone who asks by design, so withholding the token would only be
    // theatre. Network mode is open to the network — it says so when it starts,
    // and docs/LOCAL_DEVELOPMENT.md says it again.
    if (url.pathname === "/__local/staff" && request.method === "GET") return accountsResponse();

    if (url.pathname === "/__local/emails" && request.method === "GET") {
      return Response.json({ emails: localEmails }, {
        headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
      });
    }
    if (url.pathname === "/__local/emails" && request.method === "DELETE") {
      localEmails.length = 0;
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }
    if (url.pathname === "/__local/sms" && request.method === "GET") {
      return Response.json({ messages: localSmsMessages }, {
        headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" },
      });
    }
    if (url.pathname === "/__local/sms" && request.method === "DELETE") {
      localSmsMessages.length = 0;
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    }

    if (url.pathname.startsWith("/__local/")) {
      return Response.json({ error: "Unknown local development endpoint." }, { status: 404 });
    }

    return worker.fetch!(request, env, ctx);
  },
  async queue(batch, env): Promise<void> {
    await handleEmailQueue(batch, env, localEmailSender, localSmsSender);
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(dispatchPendingEmailNotifications(env));
  },
};

export default localWorker;
