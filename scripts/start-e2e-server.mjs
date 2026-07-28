import { rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";

import { redactE2eOutput } from "./e2e-redaction.mjs";

const persistPath = ".wrangler/e2e";
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
  "--persist-to", persistPath, "--ip", "127.0.0.1", "--port", "8787",
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
