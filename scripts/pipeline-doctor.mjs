import { createHash } from "node:crypto";

import { redactE2eOutput } from "./e2e-redaction.mjs";

export const DOCTOR_WORKFLOWS = new Map([
  [".github/workflows/agent-task.yml", "Agent Task"],
  [".github/workflows/agent-review.yml", "Agent Review"],
  [".github/workflows/agent-reconcile.yml", "Agent Reconcile"],
  [".github/workflows/release.yml", "Release"],
]);

const FAILURE_CONCLUSIONS = new Set(["action_required", "failure", "startup_failure", "timed_out"]);

const normalizedWorkflowPath = (value) => String(value ?? "").split("@")[0];

export function isDoctorFailure(run) {
  return run?.status === "completed"
    && FAILURE_CONCLUSIONS.has(run.conclusion)
    && DOCTOR_WORKFLOWS.has(normalizedWorkflowPath(run.path));
}

export function pipelineFailureIdentity(run, jobs) {
  const workflowPath = normalizedWorkflowPath(run?.path);
  if (!isDoctorFailure(run)) throw new Error("Run is not an eligible Pipeline Doctor failure.");
  if (!/^[0-9a-f]{40}$/.test(String(run.head_sha ?? ""))) {
    throw new Error("Failed run does not identify a full lowercase head SHA.");
  }

  const failures = jobs
    .filter((job) => FAILURE_CONCLUSIONS.has(job.conclusion))
    .map((job) => ({
      id: Number(job.id),
      job: String(job.name),
      conclusion: String(job.conclusion),
      steps: (job.steps ?? [])
        .filter((step) => FAILURE_CONCLUSIONS.has(step.conclusion))
        .map((step) => String(step.name)),
    }))
    .sort((left, right) => left.job.localeCompare(right.job) || left.id - right.id);
  if (failures.length === 0) throw new Error("Failed run contains no failed job identity.");

  // Job IDs are execution-local. Hash only stable identities so rerunning the
  // same failed jobs at the same SHA reuses one incident.
  const signatureFailures = failures.map(({ job, conclusion, steps }) => ({ job, conclusion, steps }));
  const source = JSON.stringify({ version: 1, workflowPath, headSha: run.head_sha, failures: signatureFailures });
  const signature = createHash("sha256").update(source).digest("hex");
  const applicationFailure = workflowPath === ".github/workflows/agent-task.yml"
    && failures.every(({ job }) => job === "verify");
  return {
    applicationFailure,
    failures,
    headSha: run.head_sha,
    signature,
    workflow: DOCTOR_WORKFLOWS.get(workflowPath),
    workflowPath,
  };
}

const ANSI = /\u001b\[[0-9;]*m/g;
const CREDENTIALS = [
  /(authorization:\s*(?:basic|bearer)\s+)[^\s]+/gi,
  /((?:access[_-]?token|api[_-]?key|client[_-]?secret|password|refresh[_-]?token)\s*[=:]\s*)[^\s,;]+/gi,
  /((?:cookie|set-cookie):\s*)[^\r\n]+/gi,
];
const ERROR_ANCHOR = /(?:##\[error\]|\b(?:error|exception|failed|failure|forbidden|timed out|timeout)\b|\b(?:401|403|429|500)\b)/i;

export function redactDoctorEvidence(log, { maxCharacters = 30000, maxLineCharacters = 600 } = {}) {
  const lines = String(log ?? "").replace(ANSI, "").split(/\r?\n/).map((value) => {
    let line = redactE2eOutput(value).replaceAll("<!--", "&lt;!--").replaceAll("-->", "--&gt;");
    for (const pattern of CREDENTIALS) line = line.replace(pattern, "$1[redacted]");
    return line.length > maxLineCharacters ? `${line.slice(0, maxLineCharacters)} [line truncated]` : line;
  });
  const tailStart = Math.max(0, lines.length - 120);
  const selected = new Set(lines.slice(tailStart).map((_line, index) => tailStart + index));
  lines.forEach((line, index) => {
    if (!ERROR_ANCHOR.test(line)) return;
    for (let current = Math.max(0, index - 3); current <= Math.min(lines.length - 1, index + 8); current += 1) {
      selected.add(current);
    }
  });
  const text = [...selected].sort((left, right) => left - right).map((index) => lines[index]).join("\n").trim();
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n[truncated]`;
}

export function classifyDoctorResult({ signature, marker, patchLength, exitStatus, phase = "diagnose", report = "" }) {
  const failed = { type: "failed" };
  if (exitStatus !== 0 || !/^[0-9a-f]{64}$/.test(signature)
      || !/^## Diagnosis$/m.test(report) || !/^## Next step$/m.test(report)) return failed;
  const match = String(marker ?? "").match(
    /^PIPELINE_DOCTOR_(PROPOSAL|REPAIR|APPLICATION|EXTERNAL|NOOP):([0-9a-f]{64})$/,
  );
  if (!match || match[2] !== signature) return failed;
  const type = match[1].toLowerCase();
  const phaseTypes = phase === "diagnose"
    ? new Set(["proposal", "application", "external", "noop"])
    : phase === "repair"
      ? new Set(["repair", "external", "noop"])
      : new Set();
  if (!phaseTypes.has(type) || (type === "repair") !== (patchLength > 0)
      || (type === "proposal" && !/^## Proposed repair$/m.test(report))) return failed;
  return { type };
}

export function doctorIncidentMarker(signature, headSha) {
  if (!/^[0-9a-f]{64}$/.test(signature) || !/^[0-9a-f]{40}$/.test(headSha)) {
    throw new Error("Pipeline Doctor incident marker identity is invalid.");
  }
  return `<!-- pipeline-doctor signature=${signature} sha=${headSha} -->`;
}
