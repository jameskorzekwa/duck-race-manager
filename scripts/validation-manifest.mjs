import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

const requireInteger = (value, name) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer.`);
  return number;
};

const requireMatch = (value, pattern, name) => {
  const text = String(value ?? "");
  if (!pattern.test(text)) throw new Error(`${name} has an invalid format.`);
  return text;
};

export function buildValidationManifest(input) {
  const completedAt = new Date(input.completedAt ?? Date.now()).toISOString();
  return {
    schemaVersion: 1,
    repository: requireMatch(input.repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repository"),
    runId: requireInteger(input.runId, "runId"),
    runAttempt: requireInteger(input.runAttempt, "runAttempt"),
    issue: requireInteger(input.issue, "issue"),
    baseSha: requireMatch(input.baseSha, SHA, "baseSha"),
    patchDigest: requireMatch(input.patchDigest, DIGEST, "patchDigest"),
    treeSha: requireMatch(input.treeSha, SHA, "treeSha"),
    packageLockDigest: requireMatch(input.packageLockDigest, DIGEST, "packageLockDigest"),
    nodeVersion: requireMatch(input.nodeVersion, /^v\d+\.\d+\.\d+$/, "nodeVersion"),
    completedAt,
  };
}

export function assertValidationManifest(manifest, expected) {
  if (manifest?.schemaVersion !== 1) throw new Error("Validation manifest schema is unsupported.");
  const normalized = buildValidationManifest(manifest);
  for (const [name, value] of Object.entries(expected)) {
    if (value !== undefined && String(normalized[name]) !== String(value)) {
      throw new Error(`Validation manifest ${name} does not match the expected value.`);
    }
  }
  return normalized;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function fileDigest(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, manifestPath] = process.argv.slice(2);
  if (!manifestPath || !["create", "verify"].includes(mode)) {
    throw new Error("Usage: validation-manifest.mjs <create|verify> <manifest-path>");
  }
  if (mode === "create") {
    const manifest = buildValidationManifest({
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      issue: process.env.VALIDATION_ISSUE,
      baseSha: process.env.VALIDATION_BASE_SHA,
      patchDigest: process.env.VALIDATION_PATCH_DIGEST,
      treeSha: git(["write-tree"]),
      packageLockDigest: fileDigest("package-lock.json"),
      nodeVersion: process.version,
    });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${manifest.treeSha}\n`);
  } else {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const validated = assertValidationManifest(manifest, {
      repository: process.env.GITHUB_REPOSITORY,
      runId: process.env.VALIDATION_RUN_ID,
      runAttempt: process.env.VALIDATION_RUN_ATTEMPT,
      issue: process.env.VALIDATION_ISSUE,
      baseSha: process.env.VALIDATION_BASE_SHA,
      patchDigest: process.env.VALIDATION_PATCH_DIGEST,
      treeSha: git(["rev-parse", "HEAD^{tree}"]),
    });
    process.stdout.write(`${validated.treeSha}\n`);
  }
}
