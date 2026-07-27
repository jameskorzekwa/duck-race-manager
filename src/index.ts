import {
  findDuckNumberRaceStatus,
  findDuckRaceStatus,
  findRegistrationStatus,
  handleApi,
} from "./api.ts";
import { authenticateStaff } from "./auth.ts";
import { hasAnyRole } from "./authorization.ts";
import {
  appSelectScript,
  finishLineScript,
  inventoryIntakeScript,
  liveScript,
  liveUiScript,
  participantScript,
  registrationScript,
  staffDuckScript,
  staffHomeScript,
  startLineScript,
} from "./client-scripts.ts";
import {
  faviconSvg,
  homeScript,
  manifestJson,
  renderDuck,
  renderHome,
  renderNotFound,
  renderPublicDuck,
  renderPublicDuckNotFound,
  renderRegistration,
  renderStaffAuthError,
  renderStaffDuck,
  renderFinishLine,
  renderInventoryIntake,
  renderInventoryIntakeUnsupported,
  renderMyDucks,
  renderStaffHome,
  renderStaffLogin,
  renderStaffPairing,
  renderStartLine,
  renderStatus,
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

const html = (body: string, status = 200, noindex = false, formActionOrigin?: string): Response =>
  new Response(body, {
    status,
    headers: {
      ...securityHeaders,
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; base-uri 'none'; connect-src 'self' https://challenges.cloudflare.com; form-action 'self'${formActionOrigin === undefined ? "" : ` ${formActionOrigin}`}; frame-ancestors 'none'; frame-src https://challenges.cloudflare.com; img-src 'self' data:; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'unsafe-inline'; upgrade-insecure-requests`,
      "content-type": "text/html; charset=utf-8",
      ...(formActionOrigin === undefined ? {} : { "referrer-policy": "same-origin" }),
      ...(noindex ? { "x-robots-tag": "noindex, nofollow" } : {}),
    },
  });

const withSecurityHeaders = (response: Response): Response => {
  for (const [name, value] of Object.entries(securityHeaders)) response.headers.set(name, value);
  return response;
};

const safeReturnTo = (value: string | null): string =>
  value !== null && value.startsWith("/") && !value.startsWith("//") && value.length <= 512
    ? value
    : "/staff";

// Compatibility-only page routing. Authorization and API protections never trust this value.
const hasAndroidUserAgent = (request: Request): boolean =>
  /\bAndroid\b/i.test(request.headers.get("user-agent") ?? "");

export const createWorker = (
  authenticate: typeof authenticateStaff = authenticateStaff,
  tokenFetch: typeof fetch = fetch,
): ExportedHandler<Env> => ({
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const appOrigin = new URL(env.APP_ORIGIN);
    const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
    const localPreview = appOrigin.protocol === "http:" && localHosts.has(appOrigin.hostname);
    const staffHtml = (body: string, status = 200): Response =>
      html(body, status, true, new URL(env.COGNITO_DOMAIN).origin);
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

    if (url.pathname === "/assets/home.js") {
      return new Response(homeScript, {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=3600",
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    }

    if (["/assets/live-ui.js", "/assets/register.js", "/assets/participant.js", "/assets/staff-duck.js", "/assets/staff-home.js", "/assets/live.js", "/assets/start-line.js", "/assets/finish-line.js", "/assets/inventory-intake.js", "/assets/app-select.js"].includes(url.pathname)) {
      const script = url.pathname === "/assets/live-ui.js"
        ? liveUiScript
        : url.pathname === "/assets/register.js"
          ? registrationScript
          : url.pathname === "/assets/participant.js"
            ? participantScript
            : url.pathname === "/assets/staff-home.js"
              ? staffHomeScript
              : url.pathname === "/assets/live.js"
                ? liveScript
                : url.pathname === "/assets/start-line.js"
                  ? startLineScript
                  : url.pathname === "/assets/finish-line.js"
                    ? finishLineScript
                    : url.pathname === "/assets/app-select.js"
                      ? appSelectScript
                      : url.pathname === "/assets/inventory-intake.js" ? inventoryIntakeScript : staffDuckScript;
      return new Response(script, {
        headers: {
          ...securityHeaders,
          "cache-control": ["/assets/live-ui.js", "/assets/staff-duck.js", "/assets/staff-home.js", "/assets/start-line.js", "/assets/finish-line.js", "/assets/inventory-intake.js", "/assets/app-select.js"].includes(url.pathname)
            ? "no-store"
            : "public, max-age=3600",
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

    if (url.pathname.startsWith("/api/v1/")) {
      return withSessionCookies(await handleApi(request, env, authenticateRequest, ctx));
    }

    if (url.pathname === "/" && request.method === "GET") {
      return html(renderHome());
    }
    if (url.pathname === "/register" && request.method === "GET") {
      const siteKey = env.TURNSTILE_SITE_KEY?.trim();
      return html(renderRegistration(siteKey && env.TURNSTILE_SECRET_KEY ? siteKey : undefined), 200, true);
    }
    if (url.pathname === "/my-ducks" && request.method === "GET") {
      return html(renderMyDucks(), 200, true);
    }
    if (url.pathname === "/r/mock" && request.method === "GET") return html(renderStatus(), 200, true);
    if (url.pathname === "/t/mock" && request.method === "GET") return html(renderDuck(), 200, true);
    if (url.pathname === "/t/mock-unpaired" && request.method === "GET") {
      return new Response(null, { status: 303, headers: { ...securityHeaders, location: "/" } });
    }
    if (url.pathname === "/mock/staff/ducks/128/pair" && request.method === "GET") {
      return html(renderStaffPairing(), 200, true);
    }
    if (url.pathname === "/mock/staff/ducks/128/working" && request.method === "GET") {
      return staffHtml(renderStaffDuck("a".repeat(32), "Staff Preview"));
    }
    if (url.pathname === "/mock/staff/home" && request.method === "GET") {
      return staffHtml(renderStaffHome("Administrator Preview", true, []));
    }
    if (url.pathname === "/mock/staff/start-line" && request.method === "GET") {
      return staffHtml(renderStartLine("Start-line Preview", false));
    }
    if (url.pathname === "/mock/staff/finish-line" && request.method === "GET") {
      return staffHtml(renderFinishLine("Finish-line Preview", false));
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

    if (url.pathname === "/staff" && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      return withSessionCookies(actor === null
        ? staffHtml(renderStaffLogin(safeReturnTo(url.searchParams.get("returnTo"))))
        : staffHtml(renderStaffHome(actor.displayName ?? actor.email, actor.isSystemAdmin, actor.roles)));
    }

    if (url.pathname === "/staff/inventory-intake" && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      if (actor === null) {
        const login = new URL("/staff", env.APP_ORIGIN);
        login.searchParams.set("returnTo", url.pathname);
        return withSessionCookies(new Response(null, { status: 303, headers: { ...securityHeaders, location: login.pathname + login.search } }));
      }
      if (!hasAnyRole(actor, ["DUCK_MANAGER", "RACE_DIRECTOR"])) {
        return withSessionCookies(html(renderStaffAuthError("This account does not have permission to use the inventory intake station.", actor), 403, true));
      }
      if (!hasAndroidUserAgent(request)) {
        const response = staffHtml(renderInventoryIntakeUnsupported(actor.displayName ?? actor.email), 400);
        response.headers.set("vary", "User-Agent");
        return withSessionCookies(response);
      }
      const response = staffHtml(renderInventoryIntake(
        actor.displayName ?? actor.email,
        appOrigin.origin,
        actor.isSystemAdmin,
        actor.roles,
      ));
      response.headers.set("vary", "User-Agent");
      return withSessionCookies(response);
    }

    if ((url.pathname === "/staff/start-line" || url.pathname === "/staff/finish-line") && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      if (actor === null) {
        const login = new URL("/staff", env.APP_ORIGIN);
        login.searchParams.set("returnTo", `${url.pathname}${url.search}`);
        return withSessionCookies(new Response(null, { status: 303, headers: { ...securityHeaders, location: login.pathname + login.search } }));
      }
      const startLine = url.pathname === "/staff/start-line";
      const allowed = startLine
        ? hasAnyRole(actor, ["HEAT_RUNNER", "RACE_DIRECTOR"])
        : hasAnyRole(actor, ["RESULT_TAKER", "RACE_DIRECTOR"]);
      if (!allowed) {
        return withSessionCookies(html(renderStaffAuthError(
          `This account does not have permission to use the ${startLine ? "start-line" : "finish-line"} station.`,
          actor,
        ), 403, true));
      }
      const displayName = actor.displayName ?? actor.email;
      return withSessionCookies(staffHtml(startLine
        ? renderStartLine(displayName, true, actor.isSystemAdmin, actor.roles)
        : renderFinishLine(displayName, true, actor.isSystemAdmin, actor.roles)));
    }

    const staffDuckMatch = url.pathname.match(/^\/staff\/ducks\/([A-Za-z0-9_-]+)$/);
    if (staffDuckMatch !== null && request.method === "GET") {
      const actor = await authenticateRequest(request, env);
      if (actor === null) {
        const login = new URL("/staff", env.APP_ORIGIN);
        login.searchParams.set("returnTo", url.pathname);
        return withSessionCookies(new Response(null, { status: 303, headers: { ...securityHeaders, location: login.pathname + login.search } }));
      }
      if (!hasAnyRole(actor, ["REGISTRATION", "DUCK_MANAGER", "RESULT_TAKER", "RETURN_STEWARD", "RACE_DIRECTOR"])) {
        return withSessionCookies(html(renderStaffAuthError("This account does not have permission to inspect staff duck records.", actor), 403, true));
      }
      return withSessionCookies(staffHtml(renderStaffDuck(
        staffDuckMatch[1],
        actor.displayName ?? actor.email,
        actor.isSystemAdmin,
        actor.roles,
      )));
    }

    // Public duck detail by the number printed on the duck and shown on the
    // board. It carries no token, so it stays anonymous and noindex like the
    // other public duck pages.
    const duckNumberMatch = url.pathname.match(/^\/duck\/([0-9]{1,9})$/);
    if (duckNumberMatch !== null && request.method === "GET") {
      const status = await findDuckNumberRaceStatus(duckNumberMatch[1], env);
      return status === null
        ? html(renderPublicDuckNotFound(duckNumberMatch[1]), 404, true)
        : html(renderPublicDuck(status), 200, true);
    }

    const privateStatusMatch = url.pathname.match(/^\/r\/([A-Za-z0-9_-]+)$/);
    if (privateStatusMatch !== null && request.method === "GET") {
      const registration = await findRegistrationStatus(privateStatusMatch[1], env);
      return registration === null
        ? html(renderNotFound(), 404, true)
        : html(renderStatus(registration), 200, true);
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
      return withSessionCookies(status === null
        ? new Response(null, { status: 303, headers: { ...securityHeaders, location: "/" } })
        : html(renderDuck(status), 200, true));
    }

    return html(renderNotFound(), 404, true);
  },
});

export default createWorker();
