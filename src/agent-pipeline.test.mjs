import assert from "node:assert/strict";
import test from "node:test";

import { closingIssueNumbers, firstDeployedRelease, latestTaskRun, markerNumbers, questionAnswered, recoverFailedIssue, validExactCheck, verificationFailureSignature, writeIssueStateIfCurrent } from "../scripts/agent-pipeline.mjs";

function fakeRecoveryGithub(comments) {
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

test("a spent retry budget parks the issue at agent:error", async () => {
  const { github, context, actions } = fakeRecoveryGithub(
    Array.from({ length: 5 }, (_, index) => ({ body: `<!-- agent-pipeline task-retry=${index + 1} -->` })),
  );

  assert.equal(await recoverFailedIssue({ github, context }, 70), "error");
  assert.ok(actions.comments.some((body) => body.includes("task-exhausted")));
  assert.deepEqual(actions.labels, ["enhancement", "agent:error"]);
  assert.equal(actions.dispatched, 0);
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

test("verification signatures cover the complete sorted failure index", () => {
  const first = verificationFailureSignature("Failure index:\n- test B\n- test A\n- test A");
  const reordered = verificationFailureSignature("Failure index:\n- test A\n- test B");

  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, reordered);
  assert.equal(verificationFailureSignature("plain failure detail"), null);
});

test("two identical attempts park the issue at agent:error", async () => {
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

test("markerNumbers extracts comma-separated machine state", () => {
  const comments = [
    { body: "<!-- agent-pipeline blocked-by=4,9 -->" },
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
      },
    },
  };
  const pr = {
    body: `<!-- agent-pipeline task-run=99 issue=7 base=${fork} -->`,
    base: { ref: "main", sha: currentMain },
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
  assert.equal(latestTaskRun(comments), 200);
});

test("an issue with no claim yet accepts the write", async () => {
  const { github, context, written } = fakeStateGithub([{ body: "no markers here" }]);

  assert.equal(await writeIssueStateIfCurrent({ github, context }, 7, "agent:queued", 300), true);
  assert.equal(written.length, 1);
  assert.equal(latestTaskRun([]), null);
});
