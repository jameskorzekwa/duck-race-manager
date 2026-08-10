import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyDoctorResult,
  doctorIncidentMarker,
  isDoctorFailure,
  pipelineFailureIdentity,
  redactDoctorEvidence,
  trustedDoctorRun,
} from "../scripts/pipeline-doctor.mjs";
import {
  assertPipelineRepairPaths,
  assertSafeWorkflowAdditions,
} from "../scripts/validate-pipeline-repair.mjs";

const failedRun = {
  status: "completed",
  conclusion: "failure",
  path: ".github/workflows/agent-review.yml",
  head_sha: "a".repeat(40),
};

test("doctor identities bind workflow, SHA, failed jobs, and failed steps", () => {
  const jobs = [{
    id: 42,
    name: "Queue merge",
    conclusion: "failure",
    steps: [
      { name: "Check out trusted default branch", conclusion: "success" },
      { name: "Admit oldest approved PR", conclusion: "failure" },
    ],
  }];
  const identity = pipelineFailureIdentity(failedRun, jobs);
  assert.equal(identity.workflow, "Agent Review");
  assert.equal(identity.applicationFailure, false);
  assert.match(identity.signature, /^[0-9a-f]{64}$/);
  assert.deepEqual(identity.failures[0].steps, ["Admit oldest approved PR"]);
  assert.equal(pipelineFailureIdentity(failedRun, [...jobs].reverse()).signature, identity.signature);
  assert.equal(
    pipelineFailureIdentity(failedRun, [{ ...jobs[0], id: 999 }]).signature,
    identity.signature,
    "rerun-local job IDs must not create duplicate incidents",
  );
  assert.notEqual(
    pipelineFailureIdentity({ ...failedRun, head_sha: "b".repeat(40) }, jobs).signature,
    identity.signature,
  );
});

// Adopting a failed run starts a local model session. The repository is public
// and Agent Review runs on pull_request_target, so a stranger's fork PR can
// produce a failed run of a pipeline workflow. Only James's or the pipeline's
// own runs may become incidents.
test("only a pipeline-authored failed run may become a Pipeline Doctor incident", () => {
  const james = { id: 38769771 };
  const bot = { id: 41898282 };
  const stranger = { id: 99 };
  const run = { ...failedRun, actor: james, triggering_actor: james, repository: { id: 7 } };

  assert.equal(trustedDoctorRun(run, 7), true);
  assert.equal(trustedDoctorRun({ ...run, actor: bot, triggering_actor: bot }, 7), true);

  // A public fork pull request that fails a hosted Agent Review job.
  assert.equal(trustedDoctorRun({ ...run, actor: stranger, triggering_actor: stranger }, 7), false);
  // A stranger's run that James later re-ran stays untrusted.
  assert.equal(trustedDoctorRun({ ...run, actor: stranger, triggering_actor: james }, 7), false);
  assert.equal(trustedDoctorRun({ ...run, actor: james, triggering_actor: stranger }, 7), false);
  // Fail closed when the payload does not identify an actor at all.
  assert.equal(trustedDoctorRun({ ...failedRun, repository: { id: 7 } }, 7), false);
  // Non-failures and other repositories remain out of scope.
  assert.equal(trustedDoctorRun({ ...run, conclusion: "success" }, 7), false);
  assert.equal(trustedDoctorRun({ ...run, repository: { id: 8 } }, 7), false);
});

test("candidate verification remains in the existing feature repair loop", () => {
  const run = { ...failedRun, path: ".github/workflows/agent-task.yml" };
  const identity = pipelineFailureIdentity(run, [{
    id: 1, name: "verify", conclusion: "failure", steps: [{ name: "Run deterministic release gate", conclusion: "failure" }],
  }]);
  assert.equal(identity.applicationFailure, true);
  assert.equal(isDoctorFailure({ ...run, conclusion: "cancelled" }), false);
});

test("doctor output requires the incident signature and patch shape", () => {
  const signature = "c".repeat(64);
  const report = "## Diagnosis\nThe queue handoff failed.\n\n## Next step\nVerify the repair.";
  const proposal = `${report}\n\n## Proposed repair\nChange the handoff and add a regression test.`;
  assert.deepEqual(classifyDoctorResult({
    signature, marker: `PIPELINE_DOCTOR_PROPOSAL:${signature}`, patchLength: 0, exitStatus: 0,
    phase: "diagnose", report: proposal,
  }), { type: "proposal" });
  assert.deepEqual(classifyDoctorResult({
    signature, marker: `PIPELINE_DOCTOR_REPAIR:${signature}`, patchLength: 10, exitStatus: 0,
    phase: "repair", report,
  }), { type: "repair" });
  assert.deepEqual(classifyDoctorResult({
    signature, marker: `PIPELINE_DOCTOR_APPLICATION:${signature}`, patchLength: 0, exitStatus: 0, report,
  }), { type: "application" });
  assert.deepEqual(classifyDoctorResult({
    signature, marker: `PIPELINE_DOCTOR_REPAIR:${signature}`, patchLength: 10, exitStatus: 0,
    phase: "diagnose", report,
  }), { type: "failed" });
  assert.deepEqual(classifyDoctorResult({
    signature, marker: `PIPELINE_DOCTOR_PROPOSAL:${signature}`, patchLength: 0, exitStatus: 0,
    phase: "diagnose", report,
  }), { type: "failed" });
  assert.deepEqual(classifyDoctorResult({
    signature, marker: `PIPELINE_DOCTOR_NOOP:${"d".repeat(64)}`, patchLength: 0, exitStatus: 0, report,
  }), { type: "failed" });
  assert.equal(doctorIncidentMarker(signature, "e".repeat(40)), `<!-- pipeline-doctor signature=${signature} sha=${"e".repeat(40)} -->`);
});

test("doctor evidence is bounded and neutralizes credentials and state markers", () => {
  const evidence = redactDoctorEvidence([
    "authorization: bearer private-value",
    "password=do-not-keep",
    "<!-- pipeline-doctor terminal=noop -->",
    "Error: Resource not accessible by integration",
  ].join("\n"));
  assert.doesNotMatch(evidence, /private-value|do-not-keep|<!--/);
  assert.match(evidence, /authorization: bearer \[redacted\]/i);
  assert.match(evidence, /&lt;!-- pipeline-doctor/);
  assert.equal(redactDoctorEvidence("Current main already contains the repair."), "Current main already contains the repair.");
});

test("repair policy allows bounded control files but denies doctor self-edit and application code", () => {
  assert.doesNotThrow(() => assertPipelineRepairPaths([
    ".github/workflows/agent-review.yml",
    "scripts/agent-pipeline.mjs",
    "src/agent-pipeline.test.mjs",
  ]));
  for (const path of [
    ".github/workflows/pipeline-doctor.yml",
    ".opencode/agents/pipeline-doctor.md",
    ".opencode/agents/pipeline-doctor-repair.md",
    "scripts/pipeline-doctor.mjs",
    "scripts/validate-pipeline-repair.mjs",
    "src/api.ts",
  ]) {
    assert.throws(() => assertPipelineRepairPaths([path]), /may not change/);
  }
});

test("repair policy rejects new broad authority and unpinned actions", () => {
  assert.doesNotThrow(() => assertSafeWorkflowAdditions("+        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1"));
  assert.throws(() => assertSafeWorkflowAdditions("+      id-token: write"), /forbidden workflow authority/);
  assert.throws(() => assertSafeWorkflowAdditions("+        uses: actions/checkout@v7"), /unpinned action/);
});
