import type { Env } from "./types.ts";

const objectName = "race-updates";
export const MAX_LIVE_CONNECTIONS = 1000;

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
  if (value.length === 0 || value.length > 256) return false;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const signal = parsed as Record<string, unknown>;
    return Object.keys(signal).sort().join(",") === "type,version"
      && signal.type === "refresh"
      && typeof signal.version === "string"
      && signal.version.length > 0
      && signal.version.length <= 128;
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

const publishRaceUpdate = async (env: Env): Promise<void> => {
  if (env.RACE_UPDATES === undefined) return;
  const signal = JSON.stringify({ type: "refresh", version: crypto.randomUUID() });
  const stub = env.RACE_UPDATES.get(env.RACE_UPDATES.idFromName(objectName));
  const response = await stub.fetch("https://race-updates.internal/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: signal,
  });
  if (!response.ok) throw new Error(`Race update publish failed with ${response.status}.`);
};

export const scheduleRaceUpdate = (env: Env, ctx?: ExecutionContext): void => {
  if (ctx === undefined || env.RACE_UPDATES === undefined) return;
  const publication = publishRaceUpdate(env).catch(() => undefined);
  try {
    ctx.waitUntil(publication);
  } catch {
    // Notification scheduling must never replace a committed mutation response.
  }
};
