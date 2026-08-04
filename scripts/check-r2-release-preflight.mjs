import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const binding = config.r2_buckets?.find((candidate) => candidate.binding === "DUCK_PHOTOS");
if (binding?.bucket_name !== "quickducks-duck-photos") {
  throw new Error("wrangler.jsonc must bind DUCK_PHOTOS to quickducks-duck-photos.");
}
if (!process.env.CLOUDFLARE_API_TOKEN || !process.env.CLOUDFLARE_ACCOUNT_ID) {
  throw new Error("The R2 release preflight requires the production Cloudflare token and account ID.");
}

const directory = mkdtempSync(join(tmpdir(), "quickducks-r2-preflight-"));
const input = join(directory, "input");
const output = join(directory, "output");
const probe = Buffer.from(`quickducks-r2-preflight:${randomUUID()}`, "utf8");
const canary = Buffer.from("quickducks-r2-release-probe-v1", "utf8");
const temporaryObject = `${binding.bucket_name}/release-preflight/${randomUUID()}`;
const canaryObject = `${binding.bucket_name}/health/release-probe-v1`;
const executable = process.platform === "win32" ? "npx.cmd" : "npx";

const wrangler = (args, label, allowFailure = false) => {
  const result = spawnSync(executable, ["--no-install", "wrangler", ...args], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    encoding: "utf8",
  });
  if (!allowFailure && (result.error || result.status !== 0)) {
    throw new Error(`R2 ${label} failed; verify that the production bucket exists and the token has object read/write/delete access.`);
  }
  return result.status === 0;
};

try {
  writeFileSync(input, probe, { mode: 0o600 });
  wrangler(["r2", "object", "put", temporaryObject, "--file", input, "--remote"], "write preflight");
  wrangler(["r2", "object", "get", temporaryObject, "--file", output, "--remote"], "read preflight");
  if (!readFileSync(output).equals(probe)) throw new Error("R2 preflight read did not match the written probe.");
  wrangler(["r2", "object", "delete", temporaryObject, "--remote"], "delete preflight");
  writeFileSync(input, canary, { mode: 0o600 });
  wrangler(["r2", "object", "put", canaryObject, "--file", input, "--remote"], "health canary write");
} finally {
  wrangler(["r2", "object", "delete", temporaryObject, "--remote"], "temporary cleanup", true);
  rmSync(directory, { force: true, recursive: true });
}

process.stdout.write("Production R2 bucket passed read, write, and delete preflight.\n");
