import { rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import { redactE2eOutput } from "./e2e-redaction.mjs";

const port = Number(process.env.E2E_PORT ?? 8787);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("E2E_PORT is invalid.");
const inspectorPort = Number(process.env.E2E_INSPECTOR_PORT ?? 9229);
if (!Number.isSafeInteger(inspectorPort) || inspectorPort < 1024 || inspectorPort > 65535) {
  throw new Error("E2E_INSPECTOR_PORT is invalid.");
}
const shardId = String(process.env.E2E_SHARD_ID ?? "default");
if (!/^[A-Za-z0-9_-]+$/.test(shardId)) throw new Error("E2E_SHARD_ID is invalid.");
const persistPath = `.wrangler/e2e-${shardId}`;
const origin = `http://localhost:${port}`;
const wrangler = process.platform === "win32" ? "npx.cmd" : "npx";
const environment = {
  ...process.env,
  CI: "true",
  WRANGLER_SEND_METRICS: "false",
};

rmSync(persistPath, { force: true, recursive: true });

const migration = spawnSync(wrangler, [
  "wrangler", "d1", "migrations", "apply", "quickducks-local",
  "--local", "--config", "wrangler.local.jsonc", "--persist-to", persistPath,
], { env: environment, stdio: "inherit" });

if (migration.error) throw migration.error;
if (migration.status !== 0) process.exit(migration.status ?? 1);

const server = spawn(wrangler, [
  "wrangler", "dev", "--config", "wrangler.local.jsonc",
  "--persist-to", persistPath, "--ip", "127.0.0.1", "--port", String(port),
  "--inspector-port", String(inspectorPort),
  "--var", `APP_ORIGIN:${origin}`, "--var", `COGNITO_DOMAIN:${origin}`,
], { env: environment, stdio: ["ignore", "pipe", "pipe"] });

const forwardRedacted = (stream, output) => {
  const lines = createInterface({ input: stream });
  lines.on("line", (line) => {
    output.write(`${redactE2eOutput(line)}\n`);
  });
};

forwardRedacted(server.stdout, process.stdout);
forwardRedacted(server.stderr, process.stderr);

const stop = (signal) => {
  if (!server.killed) server.kill(signal);
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
server.on("error", (error) => { throw error; });
server.on("exit", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
