import type { Env } from "./types.ts";

const objectName = "race-updates";
export const MAX_LIVE_CONNECTIONS = 1000;
export const LIVE_UPDATE_DOMAINS = [
  "all",
  "event",
  "participants",
  "ducks",
  "heats",
  "staff",
  "support",
] as const;
export type LiveUpdateDomain = typeof LIVE_UPDATE_DOMAINS[number];

const liveUpdateDomainSet = new Set<string>(LIVE_UPDATE_DOMAINS);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const responseHeaders = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000",
  "x-content-type-options": "nosniff",
} as const;

const upgradeRequired = (): Response => new Response("A WebSocket connection is required.", {
  status: 426,
  headers: {
    ...responseHeaders,
    connection: "Upgrade",
    upgrade: "websocket",
  },
});

const denied = (message: string, status: number): Response => new Response(message, {
  status,
  headers: responseHeaders,
});

const validSignal = (value: string): boolean => {
  if (value.length === 0 || value.length > 512) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const signal = parsed as Record<string, unknown>;
    return Object.keys(signal).sort().join(",") === "domains,type,version"
      && signal.type === "refresh"
      && typeof signal.version === "string"
      && uuidPattern.test(signal.version)
      && Array.isArray(signal.domains)
      && signal.domains.length > 0
      && signal.domains.length <= LIVE_UPDATE_DOMAINS.length
      && signal.domains.every((domain) => typeof domain === "string" && liveUpdateDomainSet.has(domain))
      && new Set(signal.domains).size === signal.domains.length
      && (!signal.domains.includes("all") || signal.domains.length === 1);
  } catch {
    return false;
  }
};

export class RaceUpdates {
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/publish") {
      const signal = await request.text();
      if (!validSignal(signal)) return new Response(null, { status: 400, headers: responseHeaders });
      for (const socket of this.ctx.getWebSockets()) {
        try {
          socket.send(signal);
        } catch {
          try {
            socket.close(1011, "Refresh connection");
          } catch {
            // The socket is already gone.
          }
        }
      }
      return new Response(null, { status: 204 });
    }

    if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return upgradeRequired();
    }
    if (this.ctx.getWebSockets().length >= MAX_LIVE_CONNECTIONS) {
      return denied("Live updates are at capacity. Use polling and retry later.", 503);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket: WebSocket): void {
    socket.close(1008, "Client messages are not accepted");
  }

  webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  webSocketError(socket: WebSocket): void {
    try {
      socket.close(1011, "Refresh connection");
    } catch {
      // The runtime may already have closed the failed socket.
    }
  }
}

export const handleLiveConnection = (request: Request, env: Env): Promise<Response> | Response => {
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return upgradeRequired();
  }
  if (env.RACE_UPDATES === undefined) {
    return new Response("Live updates are temporarily unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(env.APP_ORIGIN).origin;
  } catch {
    return denied("Live updates are temporarily unavailable.", 503);
  }
  const configuredOrigin = new URL(expectedOrigin);
  const localPreview = configuredOrigin.protocol === "http:"
    && new Set(["localhost", "127.0.0.1", "[::1]"]).has(configuredOrigin.hostname);
  const receivedOrigin = request.headers.get("origin");
  if (receivedOrigin !== expectedOrigin && !(localPreview && receivedOrigin === "http://quickducks.com")) {
    return denied("The live connection origin is not allowed.", 403);
  }
  return env.RACE_UPDATES.get(env.RACE_UPDATES.idFromName(objectName)).fetch(request);
};

const normalizeDomains = (domains: readonly LiveUpdateDomain[]): LiveUpdateDomain[] => {
  const requested = new Set(domains);
  if (requested.has("all")) return ["all"];
  return LIVE_UPDATE_DOMAINS.filter((domain) => requested.has(domain));
};

const publishRaceUpdate = async (env: Env, domains: readonly LiveUpdateDomain[]): Promise<void> => {
  if (env.RACE_UPDATES === undefined) return;
  const signal = JSON.stringify({
    type: "refresh",
    domains: normalizeDomains(domains),
    version: crypto.randomUUID(),
  });
  const stub = env.RACE_UPDATES.get(env.RACE_UPDATES.idFromName(objectName));
  const response = await stub.fetch("https://race-updates.internal/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: signal,
  });
  if (!response.ok) throw new Error(`Race update publish failed with ${response.status}.`);
};

export const scheduleRaceUpdate = (
  env: Env,
  ctx: ExecutionContext | undefined,
  domains: readonly LiveUpdateDomain[] = ["all"],
): void => {
  if (ctx === undefined || env.RACE_UPDATES === undefined) return;
  const normalized = normalizeDomains(domains);
  if (normalized.length === 0) return;
  const publication = publishRaceUpdate(env, normalized).catch(() => undefined);
  try {
    ctx.waitUntil(publication);
  } catch {
    // Notification scheduling must never replace a committed mutation response.
  }
};

const domains = (...values: LiveUpdateDomain[]): readonly LiveUpdateDomain[] => values;

export const mutationRefreshDomains = (request: Request): readonly LiveUpdateDomain[] | null => {
  const { pathname } = new URL(request.url);
  const method = request.method;

  if (method === "POST" && pathname === "/api/v1/registrations") {
    return domains("participants");
  }
  if (method === "POST" && pathname === "/api/v1/staff/profiles") return domains("staff");
  if (method === "POST" && /^\/api\/v1\/staff\/profiles\/[^/]{1,128}\/(role|deactivate|reactivate)$/.test(pathname)) {
    return domains("staff");
  }

  if (method === "POST" && pathname === "/api/v1/staff/events") return domains("event");
  if (["PATCH", "PUT"].includes(method) && /^\/api\/v1\/staff\/events\/[^/]{1,128}\/configuration$/.test(pathname)) {
    return domains("event");
  }
  if (method === "DELETE" && /^\/api\/v1\/staff\/events\/[^/]{1,128}$/.test(pathname)) {
    return domains("event");
  }
  if (method === "POST" && /^\/api\/v1\/staff\/events\/[^/]{1,128}\/force-delete$/.test(pathname)) {
    return domains("all");
  }
  if (method === "POST" && /^\/api\/v1\/staff\/events\/[^/]{1,128}\/(open-registration|close-registration|reopen-registration)$/.test(pathname)) {
    return domains("event", "participants");
  }
  if (method === "POST" && /^\/api\/v1\/staff\/events\/[^/]{1,128}\/(start-round-one|start-final|complete)$/.test(pathname)) {
    return domains("event", "participants", "ducks", "heats");
  }

  if (method === "POST" && /^\/api\/v1\/staff\/events\/[^/]{1,128}\/registrations$/.test(pathname)) {
    return domains("participants");
  }
  if (["PATCH", "POST"].includes(method) && /^\/api\/v1\/staff\/registrations\/[^/]{1,128}(?:\/(withdraw|reactivate|disqualify))?$/.test(pathname)) {
    return domains("participants", "ducks", "heats");
  }

  if (pathname === "/api/v1/staff/inventory/provisioning/classify") return null;
  if (method === "POST" && /^\/api\/v1\/staff\/inventory\/provisioning(?:\/(takeover|confirm))?$/.test(pathname)) {
    return domains("ducks", "support");
  }
  if (method === "POST" && pathname === "/api/v1/staff/inventory/ducks") {
    return domains("ducks", "event");
  }
  if (method === "PATCH" && /^\/api\/v1\/staff\/inventory\/ducks\/[^/]{1,128}$/.test(pathname)) {
    return domains("ducks", "participants", "heats");
  }
  if (method === "POST" && /^\/api\/v1\/staff\/inventory\/(?:ducks\/[^/]{1,128}\/(?:tags\/(?:replace|retire)|assignments|reservations\/release)|assignments\/[^/]{1,128}\/unassign)$/.test(pathname)) {
    return domains("ducks", "participants", "heats");
  }
  if (method === "POST" && /^\/api\/v1\/staff\/ducks\/[A-Za-z0-9_-]+\/assignments$/.test(pathname)) {
    return domains("ducks", "participants", "heats");
  }

  if (["POST", "PUT"].includes(method) && /^\/api\/v1\/staff\/events\/[^/]{1,128}\/heats\/(?:round-one\/plan-commit|[^/]{1,128}\/(?:roster|results\/(?:finalize|reopen|correct)|lock|ready|call|start|finish))$/.test(pathname)) {
    return domains("event", "participants", "heats");
  }

  if (method === "POST" && /^\/api\/v1\/staff\/support\/events\/[^/]{1,128}\/notifications\/[^/]{1,128}\/(retry|suppress|cancel)$/.test(pathname)) {
    return domains("support");
  }

  return null;
};
