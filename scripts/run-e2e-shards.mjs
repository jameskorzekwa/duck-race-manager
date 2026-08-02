import { spawn } from "node:child_process";

const command = process.platform === "win32" ? "npm.cmd" : "npm";
const children = [1, 2].map((shard) => spawn(command, [
  "run", "test:e2e", "--", `--shard=${shard}/2`,
], {
  env: {
    ...process.env,
    E2E_BASE_URL: `http://localhost:${8786 + shard}`,
    E2E_INSPECTOR_PORT: String(9230 + shard),
    E2E_PORT: String(8786 + shard),
    E2E_SHARD_ID: String(shard),
  },
  stdio: "inherit",
}));

const stop = (signal) => {
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

const results = await Promise.all(children.map((child) => new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
})));
const failure = results.find(({ code, signal }) => code !== 0 || signal !== null);
if (failure) {
  if (failure.signal) process.kill(process.pid, failure.signal);
  process.exit(failure.code ?? 1);
}
