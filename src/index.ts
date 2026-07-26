import {
  findDuckRaceStatus,
  findRegistrationStatus,
  handleApi,
} from "./api.ts";
import { authenticateStaff } from "./auth.ts";
import { registrationScript, staffDuckScript } from "./client-scripts.ts";
import {
  faviconSvg,
  homeScript,
  manifestJson,
  renderDuck,
  renderHome,
  renderNotFound,
  renderRegistration,
  renderStaffAuthError,
  renderStaffDuck,
  renderStaffHome,
  renderStaffLogin,
  renderStaffPairing,
  renderStatus,
} from "./site.ts";
import {
  clearFailedOAuthCookie,
  completeStaffLogin,
  finishStaffLoginResponse,
  staffLogoutResponse,
  startStaffLogin,
} from "./staff-session.ts";
import type { Env } from "./types.ts";

const securityHeaders = {
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(), geolocation=(), microphone=()",
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

const html = (body: string, status = 200, noindex = false): Response =>
  new Response(body, {
    status,
    headers: {
      ...securityHeaders,
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; base-uri 'none'; connect-src 'self' https://challenges.cloudflare.com; form-action 'self'; frame-ancestors 'none'; frame-src https://challenges.cloudflare.com; img-src 'self' data:; object-src 'none'; script-src 'self' https://challenges.cloudflare.com; style-src 'unsafe-inline'; upgrade-insecure-requests",
      "content-type": "text/html; charset=utf-8",
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const appOrigin = new URL(env.APP_ORIGIN);

    if (url.origin !== appOrigin.origin) {
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

    if (url.pathname === "/assets/register.js" || url.pathname === "/assets/staff-duck.js") {
      return new Response(url.pathname === "/assets/register.js" ? registrationScript : staffDuckScript, {
        headers: {
          ...securityHeaders,
          "cache-control": "public, max-age=3600",
          "content-type": "text/javascript; charset=utf-8",
        },
      });
    }

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\nDisallow: /r/\nDisallow: /api/\nDisallow: /staff\nDisallow: /auth/\n", {
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

    if (url.pathname.startsWith("/api/v1/")) return handleApi(request, env);

    if (url.pathname === "/" && request.method === "GET") {
      return html(renderHome());
    }
    if (url.pathname === "/register" && request.method === "GET") {
      const siteKey = env.TURNSTILE_SITE_KEY?.trim();
      return html(renderRegistration(siteKey && env.TURNSTILE_SECRET_KEY ? siteKey : undefined), 200, true);
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
      return html(renderStaffDuck("a".repeat(32), "Staff Preview"), 200, true);
    }

    if (url.pathname === "/staff/login/start" && request.method === "GET") {
      return withSecurityHeaders(await startStaffLogin(request, env));
    }

    if (url.pathname === "/auth/callback" && request.method === "GET") {
      const completion = await completeStaffLogin(request, env);
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

    if (url.pathname === "/staff/logout" && request.method === "GET") {
      return withSecurityHeaders(staffLogoutResponse(env));
    }

    if (url.pathname === "/staff" && request.method === "GET") {
      const actor = await authenticateStaff(request, env);
      return actor === null
        ? html(renderStaffLogin(safeReturnTo(url.searchParams.get("returnTo"))), 200, true)
        : html(renderStaffHome(actor.displayName ?? actor.email), 200, true);
    }

    const staffDuckMatch = url.pathname.match(/^\/staff\/ducks\/([A-Za-z0-9_-]+)$/);
    if (staffDuckMatch !== null && request.method === "GET") {
      const actor = await authenticateStaff(request, env);
      if (actor === null) {
        const login = new URL("/staff", env.APP_ORIGIN);
        login.searchParams.set("returnTo", url.pathname);
        return new Response(null, { status: 303, headers: { ...securityHeaders, location: login.pathname + login.search } });
      }
      return html(renderStaffDuck(staffDuckMatch[1], actor.displayName ?? actor.email), 200, true);
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
      const actor = await authenticateStaff(request, env);
      if (actor !== null) {
        return new Response(null, {
          status: 303,
          headers: { ...securityHeaders, location: `/staff/ducks/${duckTagMatch[1]}` },
        });
      }
      const status = await findDuckRaceStatus(duckTagMatch[1], env);
      return status === null
        ? new Response(null, { status: 303, headers: { ...securityHeaders, location: "/" } })
        : html(renderDuck(status), 200, true);
    }

    return html(renderNotFound(), 404, true);
  },
} satisfies ExportedHandler<Env>;
