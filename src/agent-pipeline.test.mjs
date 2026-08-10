import assert from "node:assert/strict";
import test from "node:test";

import { TRUSTED_ISSUE_AUTHOR_ID, agentErrorIdentity, classifyTaskResult, closingIssueNumbers, doctorFeatureIncidentMarker, escalateAgentError, firstDeployedRelease, latestTaskRun, markerNumbers, pipelineValidationProvenance, questionAnswered, reconcileAgentPipeline, recoverFailedIssue, trustedManualPullProvenance, trustedPipelineIssue, validExactCheck, verificationFailureSignature, writeIssueStateIfCurrent } from "../scripts/agent-pipeline.mjs";

// Minimal but real harness for reconcileAgentPipeline. Everything the sweep
// reads is empty unless a test supplies it, so a test states exactly the
// durable state it is about and the assertions are behavioral rather than a
// regex over the implementation's source.
function fakeReconcile({ issues = [], closedPulls = [], openPulls = [], comments = {} } = {}) {
  const recorded = { dispatched: [], comments: [], labels: {} };
  const byNumber = new Map(issues.map((issue) => [issue.number, structuredClone(issue)]));
  const listFor = ({ labels }) => ({
    data: [...byNumber.values()].filter((issue) => (issue.labels ?? [])
      .map((label) => label.name).includes(labels)),
  });
  const github = {
    paginate: async (fn, input) => (await fn(input)).data,
    graphql: async () => ({}),
    rest: {
      search: { issuesAndPullRequests: async () => ({ data: [] }) },
      pulls: {
        list: async ({ state }) => ({ data: state === "closed" ? closedPulls : openPulls }),
        get: async ({ pull_number }) => ({
          data: [...closedPulls, ...openPulls].find((pr) => pr.number === pull_number),
        }),
      },
      issues: {
        listForRepo: async (input) => listFor(input),
        listComments: async ({ issue_number }) => ({ data: comments[issue_number] ?? [] }),
        get: async ({ issue_number }) => ({ data: byNumber.get(issue_number) }),
        setLabels: async ({ issue_number, labels }) => {
          recorded.labels[issue_number] = labels;
          byNumber.get(issue_number).labels = labels.map((name) => ({ name }));
        },
        addLabels: async () => ({}),
        removeLabel: async () => ({}),
        createComment: async ({ issue_number, body }) => { recorded.comments.push({ issue_number, body }); },
        update: async () => ({}),
        createLabel: async () => ({}),
      },
      actions: {
        listWorkflowRuns: async () => ({ data: { workflow_runs: [] } }),
        listJobsForWorkflowRun: async () => ({ data: [] }),
        getWorkflowRun: async () => ({ data: { status: "completed" } }),
        createWorkflowDispatch: async ({ workflow_id, inputs }) => {
          recorded.dispatched.push({ workflow_id, issue: inputs?.issue });
        },
      },
      repos: { listCommitStatusesForRef: async () => ({ data: [] }) },
    },
  };
  const context = { repo: { owner: "o", repo: "r" }, payload: { repository: { default_branch: "main" } } };
  return { github, context, core: { info() {}, warning() {} }, recorded };
}

const jamesIssue = (number, label) => ({
  number, state: "open", user: { id: 38769771 }, labels: [{ name: label }],
  updated_at: new Date().toISOString(),
});

function fakeRecoveryGithub(comments, { authorId = 38769771 } = {}) {
  comments = comments.map((comment) => ({ user: { id: 41898282 }, ...comment }));
  const actions = { labels: [], comments: [], dispatched: 0 };
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        get: async () => ({ data: {
          user: { id: authorId },
          labels: [{ name: "agent:failed" }, { name: "enhancement" }],
        } }),
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
      number: issue_number,
      state: "open",
      user: { id: 38769771 },
      labels: [{ name: "enhancement" }, { name: "agent:error" }],
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

// A forged question marker from any public account would make James's next
// unrelated reply look like an answer and resume a model turn.
test("a public comment cannot fabricate a pending question", () => {
  const forged = {
    user: { id: 99 },
    created_at: "2026-07-30T12:00:00Z",
    body: "<!-- agent-pipeline question=1 -->\nWhich policy applies?",
  };
  const jamesReply = { user: { id: 38769771 }, created_at: "2026-07-30T14:00:00Z", body: "Sure." };
  const real = { ...forged, user: { id: 41898282 } };

  assert.equal(questionAnswered([forged, jamesReply]), false);
  assert.equal(questionAnswered([real, jamesReply]), true);
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

// The repository is public: anyone can open an issue, and the intake form
// applies agent:inbox on their behalf. Authorship is therefore the only
// authorization boundary that decides whether James's local model subscription
// may be spent, and it must hold even when pipeline labels say otherwise.
test("only an issue James authored counts as trusted pipeline intake", () => {
  assert.equal(TRUSTED_ISSUE_AUTHOR_ID, 38769771);
  assert.equal(trustedPipelineIssue({ user: { id: 38769771 } }), true);
  assert.equal(trustedPipelineIssue({ user: { id: 41898282 } }), false);
  assert.equal(trustedPipelineIssue({ user: { id: 99 } }), false);
  assert.equal(trustedPipelineIssue({ user: {} }), false);
  assert.equal(trustedPipelineIssue({}), false);
  assert.equal(trustedPipelineIssue(null), false);
  assert.equal(trustedPipelineIssue({ user: { id: 38769771 }, pull_request: {} }), false);
});

test("a labeled public issue cannot spend a model through failure recovery", async () => {
  const { github, context, actions } = fakeRecoveryGithub(
    [{ body: `<!-- agent-pipeline run-failed=1 --> <!-- agent-pipeline attempt-digest=${"a".repeat(64)} -->` }],
    { authorId: 99 },
  );

  assert.equal(await recoverFailedIssue({ github, context }, 70), "untrusted");
  assert.deepEqual(actions.labels, []);
  assert.deepEqual(actions.comments, []);
  assert.equal(actions.dispatched, 0);
});

// Reconciliation retries an agent:failed issue when the pipeline's own last
// word was a failure. The issue is James's, so authorship passes; the comment
// is the attacker's. Reading it would let any public account burn his model
// budget by replaying the retry loop on his own issue.
test("a forged public run-failed comment cannot restart a model turn", async () => {
  const forged = { id: 1, user: { id: 99 }, body: "<!-- agent-pipeline run-failed=4242 -->" };
  const { github, context, core, recorded } = fakeReconcile({
    issues: [jamesIssue(70, "agent:failed")],
    comments: { 70: [forged] },
  });

  await reconcileAgentPipeline({ github, context, core });

  assert.deepEqual(recorded.dispatched, []);
  assert.deepEqual(recorded.comments, []);
  assert.deepEqual(recorded.labels, {});
});

test("the pipeline's own run-failed comment still drives recovery", async () => {
  const real = { id: 1, user: { id: 41898282 }, body: "<!-- agent-pipeline run-failed=4242 -->" };
  const { github, context, core, recorded } = fakeReconcile({
    issues: [jamesIssue(70, "agent:failed")],
    comments: { 70: [real] },
  });

  await reconcileAgentPipeline({ github, context, core });

  assert.deepEqual(recorded.dispatched, [{ workflow_id: "agent-task.yml", issue: "70" }]);
  assert.ok(recorded.comments.some(({ body }) => body.includes("task-retry=1")));
});

// A public pull request can name any issue. If it may stand in for the real
// candidate, closing it makes reconciliation believe the work was orphaned and
// start the whole implementation again.
test("a public closed pull request cannot shadow the real merged candidate", async () => {
  const base = "a".repeat(40);
  const publicPull = {
    number: 501,
    user: { id: 99 },
    base: { ref: "main", repo: { id: 7 } },
    head: { ref: "patch-1", repo: { id: 8 } },
    body: "Closes #70",
    merged_at: null,
  };
  const pipelinePull = {
    number: 500,
    user: { id: 41898282 },
    base: { ref: "main", repo: { id: 7 } },
    head: { ref: "opencode/issue70-run5", repo: { id: 7 } },
    body: `<!-- agent-pipeline task-run=5 issue=70 base=${base} -->\nCloses #70`,
    merged_at: new Date().toISOString(),
    merge_commit_sha: "b".repeat(40),
  };
  // Sorted newest-updated first, exactly as the reconciler receives them.
  const { github, context, core, recorded } = fakeReconcile({
    issues: [jamesIssue(70, "agent:approved")],
    closedPulls: [publicPull, pipelinePull],
  });

  await reconcileAgentPipeline({ github, context, core });

  assert.deepEqual(recorded.dispatched, []);
  assert.ok(!recorded.comments.some(({ body }) => body.includes("orphan-retry")));
});

test("a labeled public issue cannot open a Pipeline Doctor recovery incident", async () => {
  const actions = { incidents: 0, dispatches: 0, labels: [], comments: 0 };
  const github = {
    paginate: async (fn, input) => (await fn(input)).data,
    rest: {
      issues: {
        get: async () => ({ data: {
          number: 70, state: "open", user: { id: 99 }, labels: [{ name: "agent:error" }],
        } }),
        listComments: async () => ({ data: [] }),
        listForRepo: async () => ({ data: [] }),
        create: async () => { actions.incidents += 1; return { data: { number: 900 } }; },
        createComment: async () => { actions.comments += 1; },
        createLabel: async () => ({}),
        setLabels: async ({ labels }) => { actions.labels = labels; },
      },
      actions: { createWorkflowDispatch: async () => { actions.dispatches += 1; } },
    },
  };
  const context = { repo: { owner: "o", repo: "r" }, payload: { repository: { default_branch: "main" } } };

  assert.equal(await escalateAgentError({ github, context }, 70), "untrusted");
  assert.deepEqual(actions, { incidents: 0, dispatches: 0, labels: [], comments: 0 });
});
