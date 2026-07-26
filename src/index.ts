import {
  findDuckRaceStatus,
  findRegistrationStatus,
  handleApi,
} from "./api.ts";
import {
  faviconSvg,
  homeScript,
  manifestJson,
  renderDuck,
  renderHome,
  renderNotFound,
  renderRegistration,
  renderStaffPairing,
  renderStatus,
} from "./site.ts";
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
      "content-security-policy": "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'unsafe-inline'; upgrade-insecure-requests",
      "content-type": "text/html; charset=utf-8",
      ...(noindex ? { "x-robots-tag": "noindex, nofollow" } : {}),
    },
  });

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

    if (url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nAllow: /\nDisallow: /r/\nDisallow: /api/\n", {
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
    if (url.pathname === "/register" && request.method === "GET") return html(renderRegistration(), 200, true);
    if (url.pathname === "/r/mock" && request.method === "GET") return html(renderStatus(), 200, true);
    if (url.pathname === "/t/mock" && request.method === "GET") return html(renderDuck(), 200, true);
    if (url.pathname === "/t/mock-unpaired" && request.method === "GET") {
      return new Response(null, { status: 303, headers: { ...securityHeaders, location: "/" } });
    }
    if (url.pathname === "/mock/staff/ducks/128/pair" && request.method === "GET") {
      return html(renderStaffPairing(), 200, true);
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
      const status = await findDuckRaceStatus(duckTagMatch[1], env);
      return status === null
        ? new Response(null, { status: 303, headers: { ...securityHeaders, location: "/" } })
        : html(renderDuck(status), 200, true);
    }

    return html(renderNotFound(), 404, true);
  },
} satisfies ExportedHandler<Env>;
