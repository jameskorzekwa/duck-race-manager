import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// A retry that restarts from an empty snapshot throws away correct work and pays
// for it again. The previous attempt's patch is reused as the starting point,
// but only when it provably belongs to this issue and is still fresh.
export function selectSeed({ metadata, patchBytes, issue, savedAtMs, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  if (!metadata || !patchBytes || patchBytes.length === 0) {
    return { use: false, reason: "no saved patch" };
  }
  if (Number(metadata.issue) !== Number(issue)) {
    return { use: false, reason: `saved patch belongs to issue #${metadata.issue}` };
  }
  const digest = createHash("sha256").update(patchBytes).digest("hex");
  if (typeof metadata.digest === "string" && metadata.digest !== digest) {
    return { use: false, reason: "saved patch digest does not match its metadata" };
  }
  const age = now - Number(savedAtMs ?? metadata.savedAtMs ?? 0);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    return { use: false, reason: "saved patch is stale" };
  }
  return { use: true, digest, reason: `resuming issue #${issue} from ${metadata.runId ?? "a previous attempt"}` };
}

export function seedPaths(stateRoot, issue) {
  const directory = path.join(stateRoot, "patches");
  return {
    directory,
    patch: path.join(directory, `issue-${Number(issue)}.patch`),
    metadata: path.join(directory, `issue-${Number(issue)}.json`),
  };
}

function readSeed(stateRoot, issue) {
  const paths = seedPaths(stateRoot, issue);
  if (!existsSync(paths.patch) || !existsSync(paths.metadata)) return { paths };
  return {
    paths,
    patchBytes: readFileSync(paths.patch),
    metadata: JSON.parse(readFileSync(paths.metadata, "utf8")),
    savedAtMs: statSync(paths.patch).mtimeMs,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    args[String(process.argv[index]).replace(/^--/, "")] = process.argv[index + 1];
  }

  if (args.mode === "save") {
    if (!args.state || !args.issue || !args.patch) {
      throw new Error("Usage: seed-model-workspace.mjs --mode save --state <root> --issue <n> --patch <path> [--run <id>] [--base <sha>]");
    }
    const paths = seedPaths(args.state, args.issue);
    const patchBytes = existsSync(args.patch) ? readFileSync(args.patch) : Buffer.alloc(0);
    if (patchBytes.length === 0) {
      rmSync(paths.patch, { force: true });
      rmSync(paths.metadata, { force: true });
      process.stdout.write("cleared\n");
    } else {
      writeFileSync(paths.patch, patchBytes);
      writeFileSync(paths.metadata, JSON.stringify({
        issue: Number(args.issue),
        runId: args.run ?? null,
        baseSha: args.base ?? null,
        digest: createHash("sha256").update(patchBytes).digest("hex"),
        savedAtMs: Date.now(),
        sessionId: args.session ?? null,
        directory: args.directory ?? null,
        runnerName: args.runner ?? null,
        markerOffset: Number(args["marker-offset"] ?? 0),
      }, null, 2));
      process.stdout.write("saved\n");
    }
  } else if (args.mode === "clear") {
    if (!args.state || !args.issue) {
      throw new Error("Usage: seed-model-workspace.mjs --mode clear --state <root> --issue <n>");
    }
    const paths = seedPaths(args.state, args.issue);
    rmSync(paths.patch, { force: true });
    rmSync(paths.metadata, { force: true });
    process.stdout.write("cleared\n");
  } else {
    if (!args.state || !args.issue) {
      throw new Error("Usage: seed-model-workspace.mjs --state <root> --issue <n>");
    }
    const { paths, patchBytes, metadata, savedAtMs } = readSeed(args.state, args.issue);
    const decision = selectSeed({ metadata, patchBytes, issue: args.issue, savedAtMs });
    if (args.format === "json") {
      process.stdout.write(`${JSON.stringify({
        ...decision,
        patch: decision.use ? paths.patch : null,
        metadata: decision.use ? metadata : null,
      })}\n`);
    } else {
      process.stderr.write(`${decision.reason}\n`);
      process.stdout.write(decision.use ? `${paths.patch}\n` : "\n");
    }
  }
}
