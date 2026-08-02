import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_PATHS = new Set([
  ".github/workflows/agent-reconcile.yml",
  ".github/workflows/agent-review-revoke.yml",
  ".github/workflows/agent-review.yml",
  ".github/workflows/agent-task.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/pipeline-metrics.yml",
  ".github/workflows/release.yml",
  ".opencode/agents/pipeline-orchestrator.md",
  ".opencode/agents/pipeline-reviewer.md",
  ".opencode/agents/pipeline-risk-reviewer.md",
  ".opencode/agents/pipeline-scout.md",
  ".opencode/agents/pipeline-tester.md",
  "docs/AGENT_PIPELINE.md",
  "scripts/agent-pipeline.mjs",
  "scripts/cleanup-model-workspace.mjs",
  "scripts/e2e-redaction.mjs",
  "scripts/run-e2e-shards.mjs",
  "scripts/seed-model-workspace.mjs",
  "scripts/summarize-verification-failure.mjs",
  "scripts/validation-manifest.mjs",
  "scripts/wait-for-openchamber-session.mjs",
  "src/agent-patch-policy.test.mjs",
  "src/agent-pipeline-security.test.mjs",
  "src/agent-pipeline.test.mjs",
  "src/e2e-redaction.test.mjs",
  "src/openchamber-session.test.mjs",
  "src/release-safety.test.mjs",
  "src/resume-previous-attempt.test.mjs",
  "src/validation-manifest.test.mjs",
  "src/verification-feedback.test.mjs",
]);

const FORBIDDEN_ADDITION = [
  /\bid-token:\s*write\b/,
  /\bmodels:\s*read\b/,
  /\bpermissions:\s*write-all\b/,
  /\bpersist-credentials:\s*true\b/,
  /\bsecrets:\s*inherit\b/,
  /\b(?:curl|wget)\b[^\n]*(?:authorization|token|secret)/i,
];

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function nulFields(value) {
  return value.split("\0").filter(Boolean);
}

export function assertPipelineRepairPaths(paths) {
  const blocked = paths.filter((candidate) => !ALLOWED_PATHS.has(candidate));
  if (blocked.length > 0) {
    throw new Error(`Pipeline Doctor patches may not change these paths:\n${blocked.join("\n")}`);
  }
}

export function assertSafeWorkflowAdditions(diff) {
  const additions = String(diff).split(/\r?\n/)
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  const forbidden = additions.filter((line) => FORBIDDEN_ADDITION.some((pattern) => pattern.test(line)));
  if (forbidden.length > 0) {
    throw new Error(`Pipeline Doctor patch adds forbidden workflow authority:\n${forbidden.join("\n")}`);
  }
  const unpinned = additions.filter((line) => /^\s*uses:\s*/.test(line)
    && !/uses:\s*(?:[^\s@]+)@[0-9a-f]{40}(?:\s+#.*)?$/.test(line)
    && !/uses:\s*docker:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/.test(line));
  if (unpinned.length > 0) {
    throw new Error(`Pipeline Doctor patch adds an unpinned action:\n${unpinned.join("\n")}`);
  }
}

export function validatePipelineRepair(cwd) {
  const changed = nulFields(git(cwd, ["diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD"]));
  if (changed.length === 0) throw new Error("Pipeline Doctor repair patch is empty.");
  if (changed.length > 12) throw new Error("Pipeline Doctor repair changes more than 12 files.");
  assertPipelineRepairPaths(changed);

  const entries = nulFields(git(cwd, ["ls-files", "-s", "-z"]));
  const unsafe = entries.filter((entry) => /^(?:120000|160000) /.test(entry));
  if (unsafe.length > 0) throw new Error("Pipeline Doctor repairs may not contain symlinks or gitlinks.");

  const numstat = git(cwd, ["diff", "--cached", "--no-renames", "--numstat", "HEAD"]);
  const changedLines = numstat.trim().split(/\r?\n/).filter(Boolean).reduce((total, line) => {
    const [added, deleted] = line.split("\t");
    if (added === "-" || deleted === "-") throw new Error("Pipeline Doctor repairs may not add binary files.");
    return total + Number(added) + Number(deleted);
  }, 0);
  if (changedLines > 1500) throw new Error("Pipeline Doctor repair exceeds the 1,500-line limit.");

  assertSafeWorkflowAdditions(git(cwd, ["diff", "--cached", "--no-renames", "--unified=0", "HEAD"]));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  validatePipelineRepair(process.argv[2] ?? process.cwd());
}
