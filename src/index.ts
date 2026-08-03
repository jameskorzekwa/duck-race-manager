import { qrDecoderSource } from "./qr-decoder-source.ts";
import {
  findDuckNumberFollowState,
  findDuckNumberRaceStatus,
  findDuckRaceStatus,
  findRegistrationStatus,
  findTagFollowState,
  handleApi,
} from "./api.ts";
import { authenticateStaff } from "./auth.ts";
import { hasAnyRole, type OperationalRole } from "./authorization.ts";
import {
  announcerScript,
  appDatePickerScript,
  appSelectScript,
  finishLineScript,
  liveScript,
  liveUiScript,
  participantScript,
  registrationScript,
  staffAccessScript,
  staffDuckScript,
  staffHomeScript,
  staffInventoryScript,
  startLineScript,
} from "./client-scripts.ts";
import { isLocalPreviewOrigin } from "./local-preview.ts";
import {
  dispatchPendingEmailNotifications,
  handleEmailUnsubscribe,
  handleEmailQueue,
  sendEmailWithSes,
  sendSmsWithAws,
  type EmailSender,
  type SmsSender,
} from "./email-notifications.ts";
import {
  phaseAllowsRaceStatus,
  phaseShowsMyDucks,
  publicContextForRender,
  publicPhaseForRender,
  type PublicPhase,
  type PublicRenderContext,
} from "./public-phase.ts";
import { getPublicRaceBoard } from "./race-board.ts";
import {
  canOpenAdminConsole,
  faviconSvg,
  manifestJson,
  renderDuck,
  renderHome,
  renderNotFound,
  renderPublicDuck,
  renderPublicDuckNotFound,
  renderRace,
  renderRegistration,
  renderStaffAuthError,
  renderStaffDuck,
  renderAnnouncer,
  renderFinishLine,
  renderMyDucks,
  renderStaffAccess,
  renderStaffHome,
  renderStaffInventory,
  renderStaffLogin,
  renderStaffNoAccess,
  renderStaffPairing,
  renderStaffRegistration,
  renderStartLine,
  renderStatus,
  searchScript,
} from "./site.ts";
import {
  authenticateStaffSession,
  clearFailedOAuthCookie,
  completeStaffLogin,
  finishStaffLoginResponse,
  staffLogoutResponse,
  startStaffLogin,
} from "./staff-session.ts";
import type { Env } from "./types.ts";

export { RaceUpdates } from "./live-updates.ts";

const securityHeaders = {
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), nfc=(self)",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
} as const;

const json = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: {
      ...securityHeaders,
      "cache-control": "no-store",
    },
  });

// Cloudflare injects its Web Analytics beacon into HTML responses at the edge,
// after this Worker returns. The script is served from one origin and reports
// to another, so both are allowed explicitly rather than widening the policy.
const analyticsScriptOrigin = "https://static.cloudflareinsights.com";
const analyticsReportOrigin = "https://cloudflareinsights.com";

const html = (body: string, status = 200, noindex = false, formActionOrigin?: string): Response =>
  new Response(body, {
    status,
    headers: {
      ...securityHeaders,
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; base-uri 'none'; connect-src 'self' https://challenges.cloudflare.com ${analyticsReportOrigin}; form-action 'self'${formActionOrigin === undefined ? "" : ` ${formActionOrigin}`}; frame-ancestors 'none'; frame-src https://challenges.cloudflare.com; img-src 'self' data:; object-src 'none'; script-src 'self' https://challenges.cloudflare.com ${analyticsScriptOrigin}; style-src 'unsafe-inline'; upgrade-insecure-requests`,
      "content-type": "text/html; charset=utf-8",
      ...(formActionOrigin === undefined ? {} : { "referrer-policy": "same-origin" }),
      ...(noindex ? { "x-robots-tag": "noindex, nofollow" } : {}),
    },
  });

// Camera access stays denied for the whole site except the authenticated staff
// duck-pairing page, which is the only surface that scans a participant QR
// code. Public pages, APIs, and every other staff station keep `camera=()`.
const withCameraAccess = (response: Response): Response => {
  response.headers.set(
    "permissions-policy",
    securityHeaders["permissions-policy"].replace("camera=()", "camera=(self)"),
  );
  return response;
};

const withSecurityHeaders = (response: Response): Response => {
  for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
  return response;
};

const safeReturnTo = (value: string | null): string =>
  value !== null && value.startsWith("/") && !value.startsWith("//") && value.length <= 512
    ? value
    : "/staff";

// Focused race-day station pages. Each is one path, one role set, one renderer,
// so a new station cannot drift from the shared 303/403/noindex treatment. A Map
// is used rather than an object literal because the key is the request path.
// Announcer sits between the two stations it reports on, matching the staff nav.
interface StationPage {
  roles: readonly OperationalRole[];
  name: string;
  render: (
    displayName: string,
    isSystemAdmin: boolean,
    roles: readonly OperationalRole[],
    phase: PublicPhase,
  ) => string;
}

const stationPages = new Map<string, StationPage>([
  ["/staff/registration", {
    roles: ["REGISTRATION", "RACE_DIRECTOR"],
    name: "registration",
    render: (displayName, isSystemAdmin, roles, phase) => renderStaffRegistration(displayName, isSystemAdmin, roles, phase),
  }],
  ["/staff/start-line", {
    roles: ["HEAT_RUNNER", "RACE_DIRECTOR"],
    name: "start-line",
    render: (displayName, isSystemAdmin, roles, phase) => renderStartLine(displayName, true, isSystemAdmin, roles, phase),
  }],
  ["/staff/announcer", {
    roles: ["ANNOUNCER", "RACE_DIRECTOR"],
    name: "announcer",
    render: (displayName, isSystemAdmin, roles, phase) => renderAnnouncer(displayName, true, isSystemAdmin, roles, phase),
  }],
  ["/staff/finish-line", {
    roles: ["RESULT_TAKER", "RACE_DIRECTOR"],
    name: "finish-line",
    render: (displayName, isSystemAdmin, roles, phase) => renderFinishLine(displayName, true, isSystemAdmin, roles, phase),
  }],
]);

const inventoryRoles: readonly OperationalRole[] = ["DUCK_MANAGER", "RACE_DIRECTOR"];

// Where `/staff` sends a signed-in staffer who cannot open the Admin view, in
// race-day priority order. `RACE_DIRECTOR` is deliberately absent from every
// entry: a race director opens the Admin view itself — that is the role whose
// whole job is changing the state of the overall race — and never reaches this
// list. Each page named here performs its own authoritative check on arrival;
// this list only decides which one is offered first, and none of them redirects
// back to `/staff` while authenticated, so the redirect cannot loop.
const staffLandingPages: readonly (readonly [string, readonly OperationalRole[]])[] = [
  ["/staff/registration", ["REGISTRATION"]],
  ["/staff/start-line", ["HEAT_RUNNER"]],
  ["/staff/finish-line", ["RESULT_TAKER"]],
  ["/staff/announcer", ["ANNOUNCER"]],
  ["/staff/inventory", ["DUCK_MANAGER"]],
];

export const createWorker = (
  authenticate: typeof authenticateStaff = authenticateStaff,
  tokenFetch: typeof fetch = fetch,
  emailSender: EmailSender = sendEmailWithSes,
  smsSender: SmsSender = sendSmsWithAws,
): ExportedHandler<Env> => ({
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const appOrigin = new URL(env.APP_ORIGIN);
    const localPreview = isLocalPreviewOrigin(env.APP_ORIGIN);
    const staffHtml = (body: string, status = 200): Response =>
      html(body, status, true, new URL(env.COGNITO_DOMAIN).origin);
    // One lightweight current-event query per HTML request. Every page renders
    // its navigation, and the public pages their whole body, from this phase, so
    // the first paint is already correct. Staff pages resolve it too: their
    // primary site navigation is the same one a visitor sees, so it has to be
    // built from the same phase. Signed-in operational pages opt their primary
    // navigation into the live hub they already use; sign-in, no-access, error,
    // and not-found pages keep no live-navigation subscriber or socket.
    // `publicPhaseForRender` degrades a
    // database failure to the Preparing phase instead of failing the render, so
    // no page on this path can 500 because of the phase query alone.
    let phaseResolution: Promise<PublicPhase> | undefined;
    const publicPhase = (): Promise<PublicPhase> => (phaseResolution ??= publicPhaseForRender(env));
    let contextResolution: Promise<PublicRenderContext> | undefined;
    const publicContext = (): Promise<PublicRenderContext> =>
      (contextResolution ??= publicContextForRender(env));
    let sessionAuthentication: Awaited<ReturnType<typeof authenticateStaffSession>> | undefined;
    const authenticateRequest: typeof authenticateStaff = async (authRequest, authEnv) => {
      sessionAuthentication ??= await authenticateStaffSession(authRequest, authEnv, authenticate, tokenFetch);
      return sessionAuthentication.actor;
    };
    const withSessionCookies = (response: Response): Response => {
      for (const cookie of sessionAuthentication?.setCookies ?? []) response.headers.append("set-cookie", cookie);
      return response;
    };

    if (!localPreview && url.origin !== appOrigin.origin) {
      const destination = new URL(`${url.pathname}${url.search}`, appOrigin);

      return new Response(null, {
        status: 308,
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=3600",
          location: destination.toString(),
        },
      });
    }

    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon.ico") {
      return new Response(faviconSvg, {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=604800, immutable",
          "content-type": "image/svg+xml; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/site.webmanifest") {
      return new Response(manifestJson, {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=86400",
          "content-type": "application/manifest+json; charset=utf-8",
        },
      });
    }

    // Pure-JavaScript QR decoder for browsers without native `BarcodeDetector`,
    // notably iOS Safari and Firefox. It is shipped as source text and never
    // executed in the Worker. The staff pairing page loads it on demand only
    // when native detection is missing, so browsers that have it never pay for
    // the download. The content is version-pinned, so it caches immutably.
    if (url.pathname === "/assets/qr-decoder.js") {
      return new Response(qrDecoderSource, {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=31536000, immutable",
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/assets/search.js") {
      return new Response(searchScript, {
        headers: {
          ...securityHeaders,
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    }

    if (["/assets/live-ui.js", "/assets/register.js", "/assets/participant.js", "/assets/staff-duck.js", "/assets/staff-home.js", "/assets/staff-access.js", "/assets/live.js", "/assets/start-line.js", "/assets/announcer.js", "/assets/finish-line.js", "/assets/staff-inventory.js", "/assets/app-select.js", "/assets/app-date-picker.js"].includes(url.pathname)) {
      const script = url.pathname === "/assets/live-ui.js"
        ? liveUiScript
        : url.pathname === "/assets/register.js"
          ? registrationScript
          : url.pathname === "/assets/participant.js"
            ? participantScript
            : url.pathname === "/assets/staff-home.js"
              ? staffHomeScript
              : url.pathname === "/assets/staff-access.js"
                ? staffAccessScript
                : url.pathname === "/assets/live.js"
                  ? liveScript
                  : url.pathname === "/assets/start-line.js"
                    ? startLineScript
                    : url.pathname === "/assets/announcer.js"
                      ? announcerScript
                      : url.pathname === "/assets/finish-line.js"
                        ? finishLineScript
                        : url.pathname === "/assets/app-select.js"
                          ? appSelectScript
                          : url.pathname === "/assets/app-date-picker.js"
                            ? appDatePickerScript
                            : url.pathname === "/assets/staff-inventory.js" ? staffInventoryScript : staffDuckScript;
      return new Response(script, {
        headers: {
          ...securityHeaders,
          // These classic scripts share globals and are deployed as one unit.
          // Never mix a cached page client with a rolled-back live-ui runtime.
          "cache-control": "no-store",
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\nDisallow: /my-ducks\nDisallow: /r/\nDisallow: /api/\nDisallow: /staff\nDisallow: /auth/\n", {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=86400",
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/health") {
      const database = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();

      return json({
        service: "quickducks",
        status: database?.ok === 1 ? "ok" : "degraded",
        database: database?.ok === 1 ? "connected" : "unavailable",
        region: env.AWS_REGION,
      });
    }

    if (url.pathname === "/notifications/unsubscribe") {
      return withSecurityHeaders(await handleEmailUnsubscribe(request, env));
    }

    if (url.pathname.startsWith("/api/v1/")) {
      return withSessionCookies(await handleApi(request, env, authenticateRequest, ctx));
    }

    if (url.pathname === "/" && request.method === "GET") {
      return html(renderHome(await publicPhase()));
    }
    if (url.pathname === "/register" && request.method === "GET") {
      const siteKey = env.TURNSTILE_SITE_KEY?.trim();
      const configuredSiteKey = siteKey && env.TURNSTILE_SECRET_KEY ? siteKey : undefined;
      // A local preview has no Turnstile keys and no route to Cloudflare's
      // siteverify endpoint, which would otherwise leave the public form
      // permanently unsubmittable. This must be the exact condition
      // `createRegistration` uses to waive verification — the secret alone, not
      // the pair of keys. Deriving it from the site key instead would offer a
      // bypass form on a preview that has only a secret, and the API would then
      // reject every submission it invited.
      const protectionWaived = env.TURNSTILE_SECRET_KEY === undefined && localPreview;
      const context = await publicContext();
      return html(renderRegistration(
        configuredSiteKey,
        context.phase,
        protectionWaived,
        context.smsNotificationsAvailable,
      ), 200, true);
    }
    // Race Status exists only once there is a race to report on. Before that
    // there is no stage, no heat, and no result, and the nav does not offer the
    // page, so a visitor arriving from a bookmark or an old link is sent home
    // rather than shown a race-status page with nothing in it. This is exactly
    // what `/my-ducks` below does, including under a degraded phase query: a
    // failed read resolves to Preparing and therefore redirects too.
    if (url.pathname === "/race" && request.method === "GET") {
      const phase = await publicPhase();
      if (!phaseAllowsRaceStatus(phase)) {
        return new Response(null, { status: 303, headers: { ...securityHeaders, location: "/" } });
      }
      // Preserve the client-refetched live board while giving a scriptless
      // results visit the same authoritative public Winners projection. A
      // transient failure here degrades only the initial board paint; the page
      // and its live client remain available, just as they were before this
      // resilient fallback existed.
      let initialBoard: Awaited<ReturnType<typeof getPublicRaceBoard>> | undefined;
      try {
        initialBoard = await getPublicRaceBoard(env);
      } catch {
        initialBoard = undefined;
      }
      return html(renderRace(phase, initialBoard), 200, true);
    }
    // My Ducks exists only once there is a public race to have ducks in. Before
    // registration opens the nav does not offer it, so a visitor who reaches it
    // from a bookmark or an old link is sent home rather than shown an empty
    // page for a race that is still being prepared.
    if (url.pathname === "/my-ducks" && request.method === "GET") {
      const phase = await publicPhase();
      if (!phaseShowsMyDucks(phase)) {
        return new Response(null, { status: 303, headers: { ...securityHeaders, location: "/" } });
      }
      return html(renderMyDucks(phase), 200, true);
    }
    if (url.pathname === "/r/mock" && request.method === "GET") {
      return html(renderStatus(undefined, await publicPhase()), 200, true);
    }
    if (url.pathname === "/t/mock" && request.method === "GET") {
      return html(renderDuck(undefined, await publicPhase()), 200, true);
    }
    if (url.pathname === "/t/mock-unpaired" && request.method === "GET") {
      return new Response(null, { status: 303, headers: { ...securityHeaders, location: "/" } });
    }
    if (url.pathname === "/mock/staff/ducks/128/pair" && request.method === "GET") {
      return html(renderStaffPairing(await publicPhase()), 200, true);
    }
    if (url.pathname === "/mock/staff/ducks/128/working" && request.method === "GET") {
      return staffHtml(renderStaffDuck("a".repeat(32), "Staff Preview", false, [], await publicPhase()));
    }
    if (url.pathname === "/mock/staff/home" && request.method === "GET") {
      return staffHtml(renderStaffHome("Administrator Preview", true, [], await publicPhase()));
    }
    if (url.pathname === "/mock/staff/start-line" && request.method === "GET") {
      return staffHtml(renderStartLine("Start-line Preview", false, false, [], await publicPhase()));
    }
    if (url.pathname === "/mock/staff/announcer" && request.method === "GET") {
      return staffHtml(renderAnnouncer("Announcer Preview", false, false, [], await publicPhase()));
    }
    if (url.pathname === "/mock/staff/finish-line" && request.method === "GET") {
      return staffHtml(renderFinishLine("Finish-line Preview", false, false, [], await publicPhase()));
    }

    if (url.pathname === "/staff/login/start" && request.method === "GET") {
      return withSecurityHeaders(await startStaffLogin(request, env));
    }

    if (url.pathname === "/auth/callback" && request.method === "GET") {
      const completion = await completeStaffLogin(request, env, authenticate, tokenFetch);
      if (completion.ok) return withSecurityHeaders(finishStaffLoginResponse(completion));
      return new Response(renderStaffAuthError(completion.error), {
        status: completion.status,
        headers: {
          ...securityHeaders,
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; style-src 'unsafe-inline'; upgrade-insecure-requests",
          "content-type": "text/html; charset=utf-8",
          "set-cookie": clearFailedOAuthCookie(),
          "x-robots-tag": "noindex, nofollow",
        },
      });
    }

    if (url.pathname === "/staff/logout") {
      return withSecurityHeaders(await staffLogoutResponse(request, env, tokenFetch));
    }

    // `/staff` is both the sign-in page and the Admin view. It is also the
    // return target sign-in falls back to, so it can never simply 403 a regular
    // staff member. Three outcomes, in this order:
    //
    // 1. A system administrator or a `RACE_DIRECTOR` receives the Admin view.
    //    `is_system_admin` is an account type; `RACE_DIRECTOR` is the race-day
    //    role for changing the state of the overall race, and every control
    //    that does so — the lifecycle transitions, the heats, the rosters, the
    //    result corrections, finalist verification — lives only here. The
    //    per-view gating inside the page is unchanged, so a race director still
    //    sees no Support view, no Access item, and none of the administrator
    //    cards. `canOpenAdminConsole` is the same predicate the nav link uses.
    // 2. Anyone else is sent to the first page their own roles actually open.
    //    Every target is a distinct path with its own role check and none of
    //    them redirects back here while authenticated, so this cannot loop.
    // 3. A staff member with no operational role at all matches nothing and
    //    receives the "No operational roles assigned" page, which says what is
    //    missing and who grants it, rather than bouncing or dead-ending.
    if (url.pathname === "/staff" && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      const phase = await publicPhase();
      if (actor === null) {
        return withSessionCookies(staffHtml(renderStaffLogin(safeReturnTo(url.searchParams.get("returnTo")), phase)));
      }
      if (!canOpenAdminConsole(actor.isSystemAdmin, actor.roles)) {
        const landing = staffLandingPages
          .find(([, roles]) => roles.some((role) => actor.roles.includes(role)))?.[0];
        return withSessionCookies(landing === undefined
          ? staffHtml(renderStaffNoAccess(actor.displayName ?? actor.email, phase))
          : new Response(null, {
            status: 303,
            headers: { ...securityHeaders, location: landing },
          }));
      }
      return withSessionCookies(staffHtml(renderStaffHome(
        actor.displayName ?? actor.email,
        actor.isSystemAdmin,
        actor.roles,
        phase,
      )));
    }

    // Staff account and role management is event-independent administrator work,
    // so it is its own page rather than a console section.
    if (url.pathname === "/staff/access" && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      if (actor === null) {
        const login = new URL("/staff", env.APP_ORIGIN);
        login.searchParams.set("returnTo", url.pathname);
        return withSessionCookies(new Response(null, { status: 303, headers: { ...securityHeaders, location: login.pathname + login.search } }));
      }
      if (!actor.isSystemAdmin) {
        return withSessionCookies(html(renderStaffAuthError("This account does not have permission to manage staff access.", actor), 403, true));
      }
      return withSessionCookies(staffHtml(renderStaffAccess(
        actor.displayName ?? actor.email,
        actor.isSystemAdmin,
        actor.roles,
        await publicPhase(),
      )));
    }

    // Inventory is a normal staff page on every device. The focused intake URL
    // is a second entry to this same complete page and authorization boundary.
    // NFC scanning is the only part that needs Android Chrome, and the page turns
    // that part off in the browser rather than being refused here: a device
    // check that replaced the whole page also removed the staff navigation from it, which is how a
    // laptop ended up on a dead end with no way back.
    if ((url.pathname === "/staff/inventory" || url.pathname === "/staff/inventory-intake") && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      if (actor === null) {
        const login = new URL("/staff", env.APP_ORIGIN);
        login.searchParams.set("returnTo", url.pathname);
        return withSessionCookies(new Response(null, { status: 303, headers: { ...securityHeaders, location: login.pathname + login.search } }));
      }
      if (!hasAnyRole(actor, inventoryRoles)) {
        return withSessionCookies(html(renderStaffAuthError("This account does not have permission to use duck inventory.", actor), 403, true));
      }
      return withSessionCookies(staffHtml(renderStaffInventory(
        actor.displayName ?? actor.email,
        appOrigin.origin,
        actor.isSystemAdmin,
        actor.roles,
        await publicPhase(),
      )));
    }

    const station = stationPages.get(url.pathname);
    if (station !== undefined && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      if (actor === null) {
        const login = new URL("/staff", env.APP_ORIGIN);
        login.searchParams.set("returnTo", `${url.pathname}${url.search}`);
        return withSessionCookies(new Response(null, { status: 303, headers: { ...securityHeaders, location: login.pathname + login.search } }));
      }
      if (!hasAnyRole(actor, station.roles)) {
        return withSessionCookies(html(renderStaffAuthError(
          `This account does not have permission to use the ${station.name} station.`,
          actor,
        ), 403, true));
      }
      return withSessionCookies(staffHtml(station.render(
        actor.displayName ?? actor.email,
        actor.isSystemAdmin,
        actor.roles,
        await publicPhase(),
      )));
    }

    const staffDuckMatch = url.pathname.match(/^\/staff\/ducks\/([A-Za-z0-9_-]+)$/);
    if (staffDuckMatch !== null && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      if (actor === null) {
        const login = new URL("/staff", env.APP_ORIGIN);
        login.searchParams.set("returnTo", url.pathname);
        return withSessionCookies(new Response(null, { status: 303, headers: { ...securityHeaders, location: login.pathname + login.search } }));
      }
      // Must stay identical to the role set `staff-api.ts` requires for
      // `GET /api/v1/staff/ducks/:token`, which this page fetches immediately.
      // A wider page allow-list only renders a console that instantly 403s.
      if (!hasAnyRole(actor, ["REGISTRATION", "DUCK_MANAGER", "RESULT_TAKER", "RACE_DIRECTOR"])) {
        return withSessionCookies(html(renderStaffAuthError("This account does not have permission to inspect staff duck records.", actor), 403, true));
      }
      const staffDuckPage = staffHtml(renderStaffDuck(
        staffDuckMatch[1],
        actor.displayName ?? actor.email,
        actor.isSystemAdmin,
        actor.roles,
        await publicPhase(),
      ));
      return withSessionCookies(hasAnyRole(actor, ["REGISTRATION", "RACE_DIRECTOR"])
        ? withCameraAccess(staffDuckPage)
        : staffDuckPage);
    }

    // Public duck detail by the number printed on the duck and shown on the
    // board. It carries no token, so it stays anonymous and noindex like the
    // other public duck pages.
    const duckNumberMatch = url.pathname.match(/^\/duck\/([0-9]{1,9})$/);
    if (duckNumberMatch !== null && request.method === "GET") {
      const status = await findDuckNumberRaceStatus(duckNumberMatch[1], env);
      const phase = await publicPhase();
      // The follow control is resolved from the same anonymous request, so a
      // page painted for a browser that already follows this participant never
      // offers to add them twice.
      return status === null
        ? html(renderPublicDuckNotFound(duckNumberMatch[1], phase), 404, true)
        : html(renderPublicDuck(
          status,
          phase,
          await findDuckNumberFollowState(request, env, duckNumberMatch[1]),
        ), 200, true);
    }

    const privateStatusMatch = url.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
    if (privateStatusMatch !== null && request.method === "GET") {
      const registration = await findRegistrationStatus(privateStatusMatch[1], env);
      // The not-found page is phase-free, so an unknown token costs one lookup
      // and nothing more.
      return registration === null
        ? html(renderNotFound(), 404, true)
        : html(renderStatus(registration, await publicPhase()), 200, true);
    }

    const duckTagMatch = url.pathname.match(/^\/t\/([A-Za-z0-9_-]+)$/);
    if (duckTagMatch !== null && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      if (actor !== null) {
        return withSessionCookies(new Response(null, {
          status: 303,
          headers: { ...securityHeaders, location: `/staff/ducks/${duckTagMatch[1]}` },
        }));
      }
      const status = await findDuckRaceStatus(duckTagMatch[1], env);
      if (status === null) {
        return withSessionCookies(new Response(null, {
          status: 303,
          headers: { ...securityHeaders, location: "/" },
        }));
      }
      // Tag GETs stay read-only: this resolves the follow control from the
      // browser collection cookie without refreshing it or issuing one.
      return withSessionCookies(html(renderDuck(
        status,
        await publicPhase(),
        await findTagFollowState(request, env, duckTagMatch[1]),
      ), 200, true));
    }

    // Catch-all. Every unmatched path lands here, including bot and scanner
    // traffic, so it deliberately runs no phase query and renders the minimal
    // Home-and-Staff navigation instead.
    return html(renderNotFound(), 404, true);
  },
  async queue(batch, env): Promise<void> {
    await handleEmailQueue(batch, env, emailSender, smsSender);
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(dispatchPendingEmailNotifications(env));
  },
});

export default createWorker();
