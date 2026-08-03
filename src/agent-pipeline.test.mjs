import assert from "node:assert/strict";
import test from "node:test";

import { agentErrorIdentity, classifyTaskResult, closingIssueNumbers, doctorFeatureIncidentMarker, escalateAgentError, firstDeployedRelease, latestTaskRun, markerNumbers, pipelineValidationProvenance, questionAnswered, recoverFailedIssue, trustedManualPullProvenance, validExactCheck, verificationFailureSignature, writeIssueStateIfCurrent } from "../scripts/agent-pipeline.mjs";

function fakeRecoveryGithub(comments) {
  comments = comments.map((comment) => ({ user: { id: 41898282 }, ...comment }));
  const actions = { labels: [], comments: [], dispatched: 0 };
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        get: async () => ({ data: { labels: [{ name: "agent:failed" }, { name: "enhancement" }] } }),
        setLabels: async ({ labels }) => { actions.labels = labels; },
        createComment: async ({ body }) => { actions.comments.push(body); },
      },
      actions: { createWorkflowDispatch: async () => { actions.dispatched += 1; } },
    },
  };
  const context = { repo: { owner: "o", repo: "r" }, payload: { repository: { default_branch: "main" } } };
  return { github, context, actions };
}

test("a fresh failure retries immediately and lands back in the queue path", async () => {
  const digest = (value) => `<!-- agent-pipeline attempt-digest=${value.repeat(64)} -->`;
  const { github, context, actions } = fakeRecoveryGithub([
    { body: `<!-- agent-pipeline run-failed=1 --> ${digest("a")}` },
    { body: `<!-- agent-pipeline run-failed=2 --> ${digest("b")}` },
  ]);

  assert.equal(await recoverFailedIssue({ github, context }, 70), "retried");
  assert.ok(actions.comments.some((body) => body.includes("task-retry=1")));
  assert.deepEqual(actions.labels, ["enhancement", "agent:inbox"]);
  assert.equal(actions.dispatched, 1);
});

test("a blocked task names itself first and persists only its prerequisites", () => {
  assert.deepEqual(classifyTaskResult({
    issue: 156,
    marker: "PIPELINE_TASK_BLOCKED:156,155",
    patchLength: 0,
    exitStatus: 0,
  }), { type: "blocked", numbers: [155] });
  assert.deepEqual(classifyTaskResult({
    issue: 156,
    marker: "PIPELINE_TASK_BLOCKED:155",
    patchLength: 0,
    exitStatus: 0,
  }), { type: "failed", numbers: [] });
  assert.deepEqual(classifyTaskResult({
    issue: 156,
    marker: "PIPELINE_TASK_BLOCKED:156,155,155",
    patchLength: 0,
    exitStatus: 0,
  }), { type: "failed", numbers: [] });
});

test("a spent retry budget enters the transient agent:error handoff", async () => {
  const { github, context, actions } = fakeRecoveryGithub(
    Array.from({ length: 5 }, (_, index) => ({ body: `<!-- agent-pipeline task-retry=${index + 1} -->` })),
  );

  assert.equal(await recoverFailedIssue({ github, context }, 70), "error");
  assert.ok(actions.comments.some((body) => body.includes("task-exhausted")));
  assert.deepEqual(actions.labels, ["enhancement", "agent:error"]);
  assert.equal(actions.dispatched, 0);
});

test("a trusted recovery reset starts a fresh retry budget", async () => {
  const { github, context, actions } = fakeRecoveryGithub([
    ...Array.from({ length: 5 }, (_, index) => ({ body: `<!-- agent-pipeline task-retry=${index + 1} -->` })),
    { body: "<!-- agent-pipeline recovery-reset=200 -->" },
    { body: `<!-- agent-pipeline run-failed=201 --> <!-- agent-pipeline attempt-digest=${"a".repeat(64)} -->` },
  ]);

  assert.equal(await recoverFailedIssue({ github, context }, 70), "retried");
  assert.ok(actions.comments.some((body) => body.includes("task-retry=1")));
  assert.equal(actions.dispatched, 1);
});

test("the same hosted failures twice stop repair churn even when the patch changes", async () => {
  const signature = "d".repeat(64);
  const { github, context, actions } = fakeRecoveryGithub([
    { body: `<!-- agent-pipeline run-failed=1 --> <!-- agent-pipeline attempt-digest=${"a".repeat(64)} --> <!-- agent-pipeline verification-signature=${signature} -->` },
    { body: `<!-- agent-pipeline run-failed=2 --> <!-- agent-pipeline attempt-digest=${"b".repeat(64)} --> <!-- agent-pipeline verification-signature=${signature} -->` },
  ]);

  assert.equal(await recoverFailedIssue({ github, context }, 70), "error");
  assert.ok(actions.comments.some((body) => body.includes("repeated-verification")));
  assert.equal(actions.dispatched, 0);
});

test("two pre-artifact infrastructure failures stop retry churn", async () => {
  const marker = "<!-- agent-pipeline infrastructure-failure=pre-artifact -->";
  const { github, context, actions } = fakeRecoveryGithub([
    { body: `<!-- agent-pipeline run-failed=1 --> ${marker}` },
    { body: `<!-- agent-pipeline run-failed=2 --> ${marker}` },
  ]);

  assert.equal(await recoverFailedIssue({ github, context }, 70), "error");
  assert.ok(actions.comments.some((body) => body.includes("repeated-infrastructure=pre-artifact")));
  assert.deepEqual(actions.labels, ["enhancement", "agent:error"]);
  assert.equal(actions.dispatched, 0);
});

test("verification signatures cover the complete sorted failure index", () => {
  const first = verificationFailureSignature("Failure index:\n- test B\n- test A\n- test A");
  const reordered = verificationFailureSignature("Failure index:\n- test A\n- test B");

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, reordered);
  assert.equal(verificationFailureSignature("plain failure detail"), null);
});

test("two identical attempts enter the transient agent:error handoff", async () => {
  const digest = `<!-- agent-pipeline attempt-digest=${"c".repeat(64)} -->`;
  const { github, context, actions } = fakeRecoveryGithub([
    { body: `<!-- agent-pipeline run-failed=1 --> ${digest}` },
    { body: `<!-- agent-pipeline run-failed=2 --> ${digest}` },
  ]);

  assert.equal(await recoverFailedIssue({ github, context }, 70), "error");
  assert.ok(actions.comments.some((body) => body.includes("no-progress")));
  assert.deepEqual(actions.labels, ["enhancement", "agent:error"]);
  assert.equal(actions.dispatched, 0);
});

test("agent error identity binds one exhausted recovery generation", () => {
  const comments = [
    { user: { id: 41898282 }, body: "<!-- agent-pipeline task-run=100 -->" },
    { user: { id: 41898282 }, body: "<!-- agent-pipeline no-progress=aaaaaaaaaaaa -->" },
    { user: { id: 41898282 }, body: "<!-- agent-pipeline recovery-reset=12 -->" },
    { user: { id: 41898282 }, body: "<!-- agent-pipeline task-run=200 -->" },
    { user: { id: 41898282 }, body: "<!-- agent-pipeline repeated-infrastructure=pre-artifact -->" },
  ];
  const identity = agentErrorIdentity(70, comments);
  assert.equal(identity.sourceRun, 200);
  assert.equal(identity.reason, "repeated-infrastructure=pre-artifact");
  assert.match(identity.signature, /^[0-9a-f]{64}$/);
  assert.equal(
    doctorFeatureIncidentMarker(identity),
    `<!-- pipeline-doctor feature=70 source=200 signature=${identity.signature} -->`,
  );
  assert.notEqual(agentErrorIdentity(71, comments).signature, identity.signature);
});

test("reconciliation transfers agent:error to a durable doctor-owned blocker", async () => {
  const featureComments = [
    { user: { id: 41898282 }, body: "<!-- agent-pipeline task-run=200 -->" },
    { user: { id: 41898282 }, body: "<!-- agent-pipeline task-exhausted -->" },
  ];
  const actions = { comments: [], dispatches: [], incidents: [], labels: [] };
  const issues = {
    get: async ({ issue_number }) => ({ data: {
      number: issue_number, state: "open", labels: [{ name: "enhancement" }, { name: "agent:error" }],
    } }),
    listComments: async ({ issue_number }) => ({ data: issue_number === 70 ? featureComments : [] }),
    listForRepo: async () => ({ data: [] }),
    createLabel: async () => ({}),
    create: async (input) => {
      actions.incidents.push(input);
      return { data: { number: 900, state: "open", labels: input.labels, body: input.body } };
    },
    createComment: async (input) => { actions.comments.push(input); },
    setLabels: async ({ labels }) => { actions.labels = labels; },
  };
  const github = {
    paginate: async (fn, input) => (await fn(input)).data,
    rest: {
      issues,
      actions: { createWorkflowDispatch: async (input) => { actions.dispatches.push(input); } },
    },
  };
  const context = { repo: { owner: "o", repo: "r" }, payload: { repository: { default_branch: "main" } } };

  assert.equal(await escalateAgentError({ github, context }, 70), "escalated");
  assert.deepEqual(actions.labels, ["enhancement", "agent:blocked"]);
  assert.equal(actions.incidents.length, 1);
  assert.deepEqual(actions.incidents[0].labels, ["pipeline:incident"]);
  assert.match(actions.incidents[0].body, /pipeline-doctor feature=70 source=200 signature=/);
  assert.ok(actions.comments.some(({ issue_number, body }) => issue_number === 70
    && body.includes("recovery-reset=900") && body.includes("blocked-by=900")));
  assert.deepEqual(actions.dispatches, [{
    owner: "o", repo: "r", workflow_id: "pipeline-doctor.yml", ref: "main", inputs: { incident: "900" },
  }]);
});

test("an unapproved doctor proposal keeps the errored feature blocked without redispatch", async () => {
  const featureComments = [
    { user: { id: 41898282 }, body: "<!-- agent-pipeline task-run=200 -->" },
    { user: { id: 41898282 }, body: "<!-- agent-pipeline task-exhausted -->" },
    { user: { id: 41898282 }, body: "<!-- agent-pipeline blocked-by=900 -->" },
  ];
  const identity = agentErrorIdentity(70, featureComments);
  const incident = {
    number: 900,
    state: "open",
    labels: [{ name: "pipeline:incident" }, { name: "pipeline:approval-required" }],
    body: doctorFeatureIncidentMarker(identity),
  };
  const incidentComments = [{
    user: { id: 41898282 },
    body: `<!-- pipeline-doctor proposal=${identity.signature} source=200 -->\nDiagnosis`,
  }];
  const actions = { dispatches: 0, labels: [] };
  const issues = {
    get: async ({ issue_number }) => ({ data: issue_number === 70
      ? { number: 70, state: "open", user: { id: 38769771 }, labels: [{ name: "agent:error" }] }
      : incident }),
    listComments: async ({ issue_number }) => ({ data: issue_number === 70 ? featureComments : incidentComments }),
    listForRepo: async () => ({ data: [incident] }),
    createComment: async () => ({}),
    setLabels: async ({ labels }) => { actions.labels = labels; },
  };
  const github = {
    paginate: async (fn, input) => (await fn(input)).data,
    rest: {
      issues,
      actions: { createWorkflowDispatch: async () => { actions.dispatches += 1; } },
    },
  };
  const context = { repo: { owner: "o", repo: "r" }, payload: { repository: { default_branch: "main" } } };

  assert.equal(await escalateAgentError({ github, context }, 70), "escalated");
  assert.deepEqual(actions.labels, ["agent:blocked"]);
  assert.equal(actions.dispatches, 0);
});

test("a question resumes only on a James reply newer than the question", () => {
  const question = {
    user: { id: 41898282 },
    created_at: "2026-07-30T12:00:00Z",
    body: "<!-- agent-pipeline question=1 -->\nWhich policy applies?",
  };
  const earlierJames = { user: { id: 38769771 }, created_at: "2026-07-30T11:00:00Z", body: "context" };
  const bot = { user: { id: 41898282 }, created_at: "2026-07-30T13:00:00Z", body: "noise" };
  const answer = { user: { id: 38769771 }, created_at: "2026-07-30T14:00:00Z", body: "Use option B." };

  assert.equal(questionAnswered([earlierJames, question]), false);
  assert.equal(questionAnswered([earlierJames, question, bot]), false);
  assert.equal(questionAnswered([earlierJames, question, bot, answer]), true);
  assert.equal(questionAnswered([earlierJames, answer]), false);
});

test("closingIssueNumbers extracts unique durable closing references", () => {
  assert.deepEqual(closingIssueNumbers("Closes #12\nFixes #12\nResolved #30"), [12, 30]);
  assert.deepEqual(closingIssueNumbers("Related to #12"), []);
});

test("validation provenance binds one task run to one immutable tested tree", () => {
  const body = [
    `<!-- agent-pipeline task-run=123 issue=7 base=${"a".repeat(40)} -->`,
    `<!-- agent-pipeline validation-run=123 attempt=2 artifact=456 digest=${"b".repeat(64)} tree=${"c".repeat(40)} -->`,
    "Closes #7",
  ].join("\n");
  assert.deepEqual(pipelineValidationProvenance({ body }), {
    runId: 123,
    runAttempt: 2,
    artifactId: 456,
    artifactDigest: "b".repeat(64),
    treeSha: "c".repeat(40),
  });
  assert.equal(pipelineValidationProvenance({ body: body.replace("validation-run=123", "validation-run=124") }), null);
});

test("only a trusted same-repository manual PR can own one issue outside the pipeline", () => {
  const pull = {
    user: { id: 38769771 },
    base: { ref: "main", repo: { id: 7 } },
    head: { repo: { id: 7 } },
    body: "Closes #104",
  };

  assert.equal(trustedManualPullProvenance(pull, "main"), true);
  assert.equal(trustedManualPullProvenance({ ...pull, user: { id: 99 } }, "main"), false);
  assert.equal(trustedManualPullProvenance({
    ...pull,
    head: { repo: { id: 8 } },
  }, "main"), false);
  assert.equal(trustedManualPullProvenance({ ...pull, body: "Closes #104\nCloses #105" }, "main"), false);
  assert.equal(trustedManualPullProvenance(pull, "develop"), false);
});

test("markerNumbers extracts comma-separated machine state", () => {
  const comments = [
    { user: { id: 41898282 }, body: "<!-- agent-pipeline blocked-by=4,9 -->" },
    { body: "Unrelated prose" },
  ];
  assert.deepEqual(markerNumbers(comments, "blocked-by"), [4, 9]);
  assert.deepEqual(markerNumbers(comments, "canonical-issue"), []);
});

test("validExactCheck accepts a trusted review after main moves beyond the fork point", async () => {
  const fork = "a".repeat(40);
  const reviewedMain = "b".repeat(40);
  const currentMain = "c".repeat(40);
  const github = {
    paginate: async (fn, args) => (await fn(args)).data,
    rest: {
      actions: {
        getWorkflowRun: async () => ({ data: {
          event: "workflow_dispatch",
          head_branch: "main",
          head_sha: reviewedMain,
          path: ".github/workflows/agent-review.yml",
        } }),
      },
      repos: {
        listCommitStatusesForRef: async () => ({ data: [{
          context: "Agent Review / Exact SHA",
          creator: { id: 41898282 },
          state: "success",
          description: `agent-review:${fork}:123 Exact-head review approved`,
          created_at: "2026-07-28T12:00:00Z",
        }] }),
        compareCommitsWithBasehead: async ({ basehead }) => ({
          data: { status: [
            `${fork}...${reviewedMain}`,
            `${reviewedMain}...${currentMain}`,
          ].includes(basehead) ? "ahead" : "diverged" },
        }),
        getBranch: async () => ({ data: { commit: { sha: currentMain } } }),
      },
    },
  };
  const pr = {
    body: `<!-- agent-pipeline task-run=99 issue=7 base=${fork} -->`,
    base: { ref: "main", sha: fork },
    head: { sha: "d".repeat(40) },
  };

  assert.equal(await validExactCheck(github, "owner", "repo", pr), true);
  github.rest.actions.getWorkflowRun = async () => ({ data: {
    event: "workflow_dispatch",
    head_branch: "feature",
    head_sha: reviewedMain,
    path: ".github/workflows/agent-review.yml",
  } });
  assert.equal(await validExactCheck(github, "owner", "repo", pr), false);
});

test("a merge carried to production by a later release still settles as deployed", async () => {
  const runs = [
    { id: 1, head_sha: "aaa", status: "completed", conclusion: "failure", created_at: "2026-07-31T20:04:00Z" },
    { id: 2, head_sha: "bbb", status: "completed", conclusion: "success", created_at: "2026-07-31T20:13:00Z" },
  ];
  const github = {
    rest: {
      repos: {
        compareCommitsWithBasehead: async ({ basehead }) => ({
          data: { status: basehead === "aaa...bbb" ? "ahead" : "diverged" },
        }),
      },
    },
  };

  const deployed = await firstDeployedRelease(github, "o", "r", runs, "aaa");
  assert.equal(deployed.id, 2);
});

test("an unreleased merge does not settle as deployed", async () => {
  const runs = [
    { id: 3, head_sha: "ccc", status: "completed", conclusion: "success", created_at: "2026-07-31T19:00:00Z" },
  ];
  const github = {
    rest: {
      repos: { compareCommitsWithBasehead: async () => ({ data: { status: "diverged" } }) },
    },
  };

  assert.equal(await firstDeployedRelease(github, "o", "r", runs, "zzz"), null);
});

test("an identical release commit settles as deployed", async () => {
  const runs = [{ id: 4, head_sha: "ddd", status: "completed", conclusion: "success", created_at: "2026-07-31T21:00:00Z" }];
  const github = { rest: { repos: { compareCommitsWithBasehead: async () => ({ data: { status: "identical" } }) } } };

  assert.equal((await firstDeployedRelease(github, "o", "r", runs, "ddd")).id, 4);
});

function fakeStateGithub(comments) {
  comments = comments.map((comment) => ({ user: { id: 41898282 }, ...comment }));
  const written = [];
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        listComments: () => {},
        get: async () => ({ data: { labels: [{ name: "agent:failed" }, { name: "enhancement" }] } }),
        setLabels: async ({ labels }) => { written.push(labels); },
      },
    },
  };
  return { github, context: { repo: { owner: "o", repo: "r" } }, written };
}

test("an older run may not overwrite state a newer run has claimed", async () => {
  const comments = [
    { body: "<!-- agent-pipeline task-run=100 -->" },
    { body: "<!-- agent-pipeline task-run=200 -->" },
  ];
  const { github, context, written } = fakeStateGithub(comments);

  assert.equal(await writeIssueStateIfCurrent({ github, context }, 7, "agent:failed", 100), false);
  assert.deepEqual(written, []);
});

test("the newest run owns the state and writes it", async () => {
  const comments = [
    { body: "<!-- agent-pipeline task-run=100 -->" },
    { body: "<!-- agent-pipeline task-run=200 -->" },
  ];
  const { github, context, written } = fakeStateGithub(comments);

  assert.equal(await writeIssueStateIfCurrent({ github, context }, 7, "agent:running", 200), true);
  assert.deepEqual(written, [["enhancement", "agent:running"]]);
  assert.equal(latestTaskRun(comments.map((comment) => ({ user: { id: 41898282 }, ...comment }))), 200);
});

test("an issue with no claim yet accepts the write", async () => {
  const { github, context, written } = fakeStateGithub([{ body: "no markers here" }]);

  assert.equal(await writeIssueStateIfCurrent({ github, context }, 7, "agent:queued", 300), true);
  assert.equal(written.length, 1);
  assert.equal(latestTaskRun([]), null);
});

test("untrusted comments cannot claim ownership of an agent task", () => {
  const comments = [
    { user: { id: 99 }, body: "<!-- agent-pipeline task-run=999 -->" },
    { user: { id: 41898282 }, body: "<!-- agent-pipeline task-run=200 -->" },
  ];
  assert.equal(latestTaskRun(comments), 200);
});
