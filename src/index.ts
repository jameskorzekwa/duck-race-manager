interface Env {
  APP_ORIGIN: string;
  AWS_REGION: string;
  COGNITO_USER_POOL_ID: string;
  COGNITO_USER_POOL_CLIENT_ID: string;
  COGNITO_DOMAIN: string;
  DB: D1Database;
  EMAIL_QUEUE: Queue;
}

const json = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      const database = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();

      return json({
        service: "quickducks",
        status: database?.ok === 1 ? "ok" : "degraded",
        database: database?.ok === 1 ? "connected" : "unavailable",
        region: env.AWS_REGION,
      });
    }

    if (url.pathname === "/") {
      return new Response(
        `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>QuickDucks</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f3c740; color: #182018; }
      main { width: min(36rem, calc(100% - 3rem)); padding: 3rem; border: 3px solid #182018; background: #fff9df; box-shadow: 10px 10px 0 #182018; }
      h1 { margin: 0 0 1rem; font-size: clamp(3rem, 12vw, 6rem); line-height: .85; letter-spacing: -.06em; }
      p { font-size: 1.2rem; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main>
      <h1>Quick<br>Ducks</h1>
      <p>The duck race registration and race-day system is being prepared.</p>
    </main>
  </body>
</html>`,
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          },
        },
      );
    }

    return json({ error: "Not found" }, 404);
  },
} satisfies ExportedHandler<Env>;
