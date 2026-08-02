import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("implementation keeps models and candidate execution outside native-token publication", async () => {
  const workflow = await read(".github/workflows/agent-task.yml");
  const implement = workflow.slice(workflow.indexOf("  implement:"), workflow.indexOf("  verify:"));
  const verify = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  publish:"));
  const publish = workflow.slice(workflow.indexOf("  publish:"));

  assert.doesNotMatch(implement, /id-token: write/);
  assert.doesNotMatch(implement, /models: read|OPENCODE_AUTH_CONTENT|GITHUB_TOKEN:/);
  assert.match(implement, /runs-on: \[self-hosted, macOS, ARM64, quickducks-implement\]/);
  assert.match(implement, /openchamber session create/);
  assert.match(implement, /vars\.AGENT_IMPLEMENT_MODEL \|\| 'openai\/gpt-5\.6-sol'/);
  assert.match(implement, /vars\.AGENT_IMPLEMENT_VARIANT \|\| 'xhigh'/);
  assert.match(implement, /PIPELINE_IMPLEMENT_MODEL.*=~.*\^\[a-z0-9-\]\+\/\[A-Za-z0-9\._-\]\+\$/);
  assert.match(implement, /--model "\$PIPELINE_IMPLEMENT_MODEL"/);
  assert.doesNotMatch(implement, /quickducks-local-oauth-model/);
  assert.doesNotMatch(implement, /OPENCODE_ENSEMBLE_TIMEOUT|--dir "\$GITHUB_WORKSPACE"/);
  assert.match(implement, /timeout-minutes: 170/);
  assert.match(implement, /--timeout 9600/);
  assert.match(implement, /untrustedReviewEvidence/);
  assert.match(implement, /git archive "\$EXPECTED_BASE"/);
  assert.match(implement, /seed-model-workspace\.mjs/);
  assert.match(implement, /apply --3way --index "\$seed"/);
  assert.ok(
    implement.indexOf('apply --3way --index "$seed"') < implement.indexOf("rsync -a --delete --exclude '.git/' \"$seed_repo/\""),
    "a resumed patch must be validated before it reaches the model workspace",
  );
  assert.match(implement, /&& node "\$GITHUB_WORKSPACE\/scripts\/validate-agent-patch\.mjs" "\$seed_repo"/);
  assert.match(implement, /resumedFromPreviousAttempt/);
  assert.match(implement, /--mode save/);
  assert.match(implement, /validate-agent-patch\.mjs" --source "\$PIPELINE_MODEL_DIR"/);
  for (const runtimePath of ["node_modules", "package.json", "package-lock.json", "bun.lock"]) {
    assert.match(implement, new RegExp(`\\.opencode/${runtimePath.replace(".", "\\.")}`));
  }
  assert.ok(implement.indexOf(".opencode/node_modules") < implement.indexOf("validate-agent-patch.mjs\" --source"));
  const extractionRsync = 'rsync -a --delete --exclude \'.git/\' "$PIPELINE_MODEL_DIR/" "$patch_repo/"';
  assert.ok(implement.includes(extractionRsync));
  assert.ok(implement.indexOf("validate-agent-patch.mjs\" --source") < implement.indexOf(extractionRsync));
  assert.match(implement, /cleanup-model-workspace\.mjs/);
  const workspaceReset = '"$state_path" "$state_root/runners" "$model_dir"';
  assert.ok(implement.includes(workspaceReset));
  assert.ok(
    implement.indexOf(workspaceReset) < implement.indexOf('git archive "$EXPECTED_BASE"'),
    "retry reconstruction must restore and remove a preserved read-only workspace before extraction",
  );
  assert.match(implement, /if: steps\.result\.conclusion == 'success'/);
  assert.match(implement, /temp_state="\$\{PIPELINE_MODEL_STATE:-\$RUNNER_TEMP\/agent-task\/cleanup-state\.json\}"/);
  assert.match(implement, /wait-for-openchamber-session\.mjs/);
  assert.doesNotMatch(implement, /openchamber session create[\s\S]*?--wait/);
  assert.match(implement, /session-dispatch\.json" 2>&1 \|\| true/);
  assert.match(implement, /--dir "\$PIPELINE_MODEL_DIR" \\\n\s+--result/);
  assert.doesNotMatch(implement, /rm -rf "\$RUNNER_TEMP\/agent-task"/);
  assert.match(implement, /scripts\/validate-agent-patch\.mjs/);
  assert.match(implement, /--mode idle \\\n\s+--dir "\$PIPELINE_MODEL_DIR"/);
  assert.match(implement, /--mode idle \\\n\s+--dir "\$previous_dir"/);
  assert.doesNotMatch(verify, /id-token: write|models: read/);
  assert.match(verify, /scripts\/validate-agent-patch\.mjs/);
  for (const gate of ["dependency audit", "typecheck", "unit and integration tests", "browser integration tests", "Wrangler validation", "local migration validation"]) {
    assert.match(verify, new RegExp(`run_gate "${gate}"`));
  }
  assert.match(verify, /exit "\$status"\n\s+\} 2>&1 \| tee/);
  assert.doesNotMatch(publish, /id-token: write/);
  assert.match(publish, /actions: write/);
  assert.match(publish, /contents: write/);
  assert.doesNotMatch(publish, /opencode run|npm test|npm run test:e2e/);
  assert.doesNotMatch(publish, /exchange_github_app_token|api\.opencode\.ai|id-token: write/);
  assert.match(publish, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(publish, /attempt-digest=\$\{attemptDigest\}/);
  assert.match(publish, /verification-signature=\$\{verificationSignature\}/);
  assert.match(publish, /infrastructure-failure=\$\{infrastructureFailure\}/);
  const failureStep = publish.slice(publish.indexOf("Mark failed implementation or publication"));
  assert.ok(
    failureStep.indexOf("const pipeline = await import") < failureStep.indexOf("pipeline.verificationFailureSignature"),
    "the failure step must import the trusted policy before computing a signature",
  );
  assert.match(publish, /ATTEMPT_DIGEST: \$\{\{ needs\.implement\.outputs\.digest \}\}/);
  assert.match(publish, /base64 \| tr -d '\\n'/);
  assert.match(publish, /github-actions\[bot\]/);
  assert.doesNotMatch(publish, /gh workflow run ci\.yml/);
  assert.match(publish, /gh workflow run agent-review\.yml/);
  assert.match(publish, /--ref "\$\{\{ github\.event\.repository\.default_branch \}\}"/);
  assert.match(publish, /scripts\/validate-agent-patch\.mjs/);
  assert.match(publish, /base=\$\{EXPECTED_BASE\}/);
  assert.doesNotMatch(publish, /current_base|Default branch advanced/);
});

test("review publishes a candidate-SHA check without privileged candidate execution", async () => {
  const workflow = await read(".github/workflows/agent-review.yml");
  const validate = workflow.slice(workflow.indexOf("  validate-candidate:"), workflow.indexOf("  independent-review:"));
  const review = workflow.slice(workflow.indexOf("  independent-review:"), workflow.indexOf("  gate:"));
  const gate = workflow.slice(workflow.indexOf("  gate:"), workflow.indexOf("  queue-merge:"));

  assert.doesNotMatch(validate, /id-token: write|models: read|cache: npm/);
  assert.doesNotMatch(review, /models: read|OPENCODE_AUTH_CONTENT|GITHUB_TOKEN:/);
  assert.match(review, /runs-on: \[self-hosted, macOS, ARM64, quickducks-review\]/);
  assert.match(review, /openchamber session create/);
  assert.match(review, /vars\.AGENT_REVIEW_MODEL \|\| 'anthropic\/claude-opus-4-8'/);
  assert.match(review, /--model "\$PIPELINE_REVIEW_MODEL"/);
  assert.match(review, /wait-for-openchamber-session\.mjs/);
  assert.doesNotMatch(review, /openchamber session create[\s\S]*?--wait/);
  assert.match(review, /session-dispatch\.json" 2>&1 \|\| true/);
  assert.doesNotMatch(review, /quickducks-local-oauth-model/);
  assert.doesNotMatch(review, /REVIEW_CANDIDATE_PATH|--dir "\$GITHUB_WORKSPACE\/trusted"/);
  assert.match(review, /\.pipeline\/candidate\.patch/);
  assert.match(review, /gh issue view "\$ISSUE_NUMBER" --repo "\$GITHUB_REPOSITORY"/);
  assert.match(review, /if: steps\.result\.conclusion == 'success'/);
  assert.match(review, /temp_state="\$\{PIPELINE_MODEL_STATE:-\$RUNNER_TEMP\/agent-review\/cleanup-state\.json\}"/);
  assert.match(review, /git -C trusted archive/);
  assert.match(review, /--mode idle \\\n\s+--dir "\$PIPELINE_MODEL_DIR"/);
  assert.match(review, /--mode idle \\\n\s+--dir "\$previous_dir"/);
  assert.doesNotMatch(review, /rm -rf "\$RUNNER_TEMP\/agent-review"/);
  assert.match(review, /timeout-minutes: 75/);
  assert.match(workflow, /github\.actor_id == '38769771'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /PR_NUMBER: \$\{\{ inputs\.pr \|\| github\.event\.pull_request\.number \}\}/);
  assert.match(workflow, /pr\.user\.id === 41898282/);
  assert.match(workflow, /github\.event\.pull_request\.user\.id != 41898282/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.(?:base|head)\.sha/);
  assert.match(validate, /scripts\/validate-agent-patch\.mjs/);
  assert.doesNotMatch(review, /id-token: write|issues: write|pull-requests: write/);
  assert.match(gate, /Agent Review \/ Exact SHA/);
  assert.doesNotMatch(gate, /actions\/checkout|npm test|opencode run/);
  const decisionStepIndex = gate.indexOf("      - name: Record exact-head decision");
  assert.notEqual(decisionStepIndex, -1);
  const decisionStep = gate.slice(decisionStepIndex);
  const scriptMarker = "          script: |\n";
  const scriptIndex = decisionStep.indexOf(scriptMarker);
  assert.notEqual(scriptIndex, -1);
  const script = decisionStep.slice(scriptIndex + scriptMarker.length)
    .split("\n")
    .map((line) => line.startsWith("            ") ? line.slice(12) : line)
    .join("\n");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction("github", "context", "core", script));

  const revocation = await read(".github/workflows/agent-review-revoke.yml");
  assert.match(revocation, /types: \[dismissed\]/);
  assert.match(revocation, /disablePullRequestAutoMerge/);
  assert.match(revocation, /Agent Review \/ Exact SHA/);
  assert.doesNotMatch(revocation, /concurrency:|openchamber|runs-on: \[self-hosted/);
});

test("local model agents deny unspecified and executable tools", async () => {
  const paths = [
    ".opencode/agents/pipeline-orchestrator.md",
    ".opencode/agents/pipeline-doctor.md",
    ".opencode/agents/pipeline-reviewer.md",
    ".opencode/agents/pipeline-risk-reviewer.md",
    ".opencode/agents/pipeline-scout.md",
    ".opencode/agents/pipeline-tester.md",
  ];
  for (const path of paths) {
    const agent = await read(path);
    assert.match(agent, /permission:\n  "\*": deny/);
    assert.match(agent, /"mcp:\*": deny/);
    assert.match(agent, /"\*\*\/\.local\/share\/opencode\/tool-output\/\*\*": deny/);
    assert.match(agent, /"\.git\/\*\*": deny/);
    assert.match(agent, /glob: deny/);
    assert.match(agent, /grep: deny/);
    assert.doesNotMatch(agent, /bash:\n|pty_|webfetch: allow|websearch: allow|lsp: allow/);
  }
  const orchestrator = await read(".opencode/agents/pipeline-orchestrator.md");
  for (const protectedPath of ["**/.git/**", "**/.github/**", "**/.opencode/**", "**/.pipeline/**", "**/opencode.json", "**/AGENTS.md"]) {
    assert.match(orchestrator, new RegExp(`"${protectedPath.replaceAll("*", "\\*")}": deny`));
  }
  const config = JSON.parse(await read("opencode.json"));
  assert.equal(config.permission["*"], "deny");
  assert.equal(config.lsp, false);
  assert.equal(config.formatter, false);
  assert.ok(Object.values(config.mcp).every((server) => server.enabled === false));
  assert.equal(config.plugin, undefined);
});

test("gate recovery waits while a dispatched gate run is still queued", async () => {
  const implementation = await read("scripts/agent-pipeline.mjs");
  const lane = implementation.slice(
    implementation.indexOf("const pendingGate"),
    implementation.indexOf("const recoveryPrefix"),
  );
  assert.match(lane, /"queued", "in_progress", "waiting", "pending", "requested"/);
  assert.match(lane, /pendingRuns\.data\.workflow_runs/);
  assert.doesNotMatch(lane, /ci\.yml/);
  assert.ok(
    implementation.indexOf("const pendingGate") < implementation.indexOf("gate-recovery-exhausted"),
    "the pending-gate check must run before any attempt is counted",
  );
});

test("durable reconciliation trusts bot markers and waits for deployed prerequisites", async () => {
  const implementation = await read("scripts/agent-pipeline.mjs");
  const task = await read(".github/workflows/agent-task.yml");
  const review = await read(".github/workflows/agent-review.yml");

  assert.match(implementation, /comment\.user\?\.id === AUTOMATION_USER_ID/);
  assert.match(implementation, /markerNumbers\(trustedAutomationComments\(comments\), "task-run"\)/);
  assert.match(implementation, /pipelineIssue \? labels\.has\("agent:deployed"\) : data\.state === "closed"/);
  assert.match(implementation, /listCommitStatusesForRef/);
  assert.doesNotMatch(implementation, /reviewChecks\.data\.check_runs/);
  assert.doesNotMatch(implementation, /workflow_id: "release\.yml", event: "push"/);
  assert.match(task, /agent-pipeline recovery-reset=\$\{context\.runId\}/);
  assert.match(task, /comment\.user\?\.id === 41898282\n\s+&& String\(comment\.body/);
  assert.match(review, /comments\.filter\(\(comment\) => comment\.user\?\.id === 41898282\)/);
});

test("trusted manual recovery PRs suppress retries without entering autonomous lanes", async () => {
  const implementation = await read("scripts/agent-pipeline.mjs");

  assert.match(implementation, /const pipelineOpenPulls = openPulls\.filter/);
  assert.match(implementation, /const issuesWithOpenPipelinePulls = new Set/);
  assert.match(implementation, /\|\| trustedManualPullProvenance\(pr, defaultBranch\)/);
  assert.match(implementation, /for \(const pr of pipelineOpenPulls\)/);
  assert.match(implementation, /if \(!issuesWithOpenPipelinePulls\.has\(issue\.number\)\) continue;/);
  assert.match(implementation, /manual-deployed=\$\{pr\.merge_commit_sha\}/);
  assert.match(implementation, /latestTaskRun\(comments\) === null/);
});

test("only a conflicting candidate returns to its saved implementation session", async () => {
  const reconcile = await read(".github/workflows/agent-reconcile.yml");
  const refresh = reconcile.slice(reconcile.indexOf("  refresh-candidates:"), reconcile.indexOf("  reconcile:"));

  // Deterministic and model-free: reconciliation dispatches but never invokes a model itself.
  assert.doesNotMatch(refresh, /openchamber|self-hosted/);

  // Only bot-authored pipeline candidates, and only genuine conflicts. Branch
  // protection is not strict, so a candidate that is merely behind main merges
  // cleanly; rewriting it would throw away a good review and a good CI run, and
  // since every merge moves main it would never reach a fixed point.
  assert.match(refresh, /select\(\.author\.login == "app\/github-actions"\)/);
  assert.match(refresh, /startswith\("opencode\/"\)/);
  assert.match(refresh, /select\(\.mergeable == "CONFLICTING"\)/);
  assert.doesNotMatch(refresh, /--json [^\n]*baseRefOid/);
  assert.doesNotMatch(refresh, /merge-base --is-ancestor/);

  // A conflicting tree cannot reuse its old exact-tree attestation.
  assert.match(refresh, /agent-pipeline task-run=/);
  assert.match(refresh, /Returning its saved patch to the existing implementation session/);
  assert.doesNotMatch(refresh, /git merge|ci\.yml|agent-review\.yml/);
  assert.match(refresh, /gh workflow run agent-task\.yml --ref "\$DEFAULT_BRANCH" -f issue="\$issue"/);
});

test("the review pins the head, tolerates base drift, and rejects conflicts", async () => {
  const review = await read(".github/workflows/agent-review.yml");
  const prepare = review.slice(review.indexOf("  prepare:"), review.indexOf("  reset-state:"));
  const gate = review.slice(review.indexOf("  gate:"), review.indexOf("  queue-merge:"));

  // The marker records the fork point the model built from. It is provenance,
  // not freshness: it must be a default-branch commit that the head descends
  // from, and it stays valid however far main moves ahead.
  assert.match(prepare, /base=\$\{marker\[3\]\}/);
  assert.doesNotMatch(prepare, /marker\[3\] !== pr\.base\.sha/);
  assert.match(prepare, /compare\/\$\{base_sha\}\.\.\.\$\{head_sha\}" --jq '\.status'\)" != "ahead"/);
  assert.match(prepare, /compare\/\$\{base_sha\}\.\.\.\$\{DEFAULT_BRANCH\}"/);

  // What was reviewed is exactly what merges.
  assert.match(gate, /pr\.head\.sha !== expectedHead/);

  // The base is deliberately unpinned: merging any candidate moves main, and
  // pinning it would invalidate every other in-flight review on every merge.
  assert.doesNotMatch(gate, /pr\.base\.sha !== expectedBase/);

  // Behind is acceptable, conflicting is not, and null means "still computing".
  assert.match(gate, /pr\.mergeable === null/);
  assert.match(gate, /pr\.mergeable === false/);
  assert.match(gate, /Conflicts with the default branch/);

  // The decision script reads pr.body before it records state. Declaring pr
  // after that read is a temporal dead zone: the step throws ReferenceError
  // before any verdict is written, so every gate fails and no candidate can
  // ever merge -- while the logs still show the expected text, because a
  // github-script block echoes its own source.
  const decision = gate.slice(gate.indexOf("Record exact-head decision"));
  const declared = decision.indexOf("let pr = ");
  const firstRead = decision.indexOf("const candidateRun = ");
  assert.ok(declared >= 0 && firstRead >= 0, "the decision script must fetch pr and read pr.body");
  assert.ok(declared < firstRead, "pr must be fetched before anything reads it");
});

test("the reviewer contract comes from trusted main, and a missing marker rejects", async () => {
  const review = await read(".github/workflows/agent-review.yml");

  // Agent contracts are control plane: a reviewer fix must reach candidates
  // that were built before it landed.
  assert.match(review, /git fetch --quiet origin \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(review, /rm -rf "\$model_dir\/\.opencode"/);
  assert.match(review, /git -C trusted archive FETCH_HEAD \.opencode/);
  assert.ok(
    review.indexOf('rm -rf "$model_dir/.opencode"') > review.indexOf('git -C trusted archive "${{ needs.prepare.outputs.base }}"'),
    "the trusted contract must overwrite the snapshot's, not precede it",
  );

  // A completed review without a marker is a rejection, not infrastructure.
  const gate = review.slice(review.indexOf("  gate:"), review.indexOf("  queue-merge:"));
  assert.match(gate, /const infrastructureFailure = process\.env\.RESET_RESULT !== "success"\n\s+\|\| process\.env\.REVIEW_RESULT !== "success";/);
  assert.doesNotMatch(gate, /infrastructureFailure = [\s\S]{0,200}decision\.exitStatus !== 0/);

  const reviewer = await read(".opencode/agents/pipeline-reviewer.md");
  assert.match(reviewer, /Write the marker first/);
  assert.match(reviewer, /There is no other contract to fetch/);
});

test("a starting implementation reports its own running state", async () => {
  const workflow = await read(".github/workflows/agent-task.yml");
  const implement = workflow.slice(workflow.indexOf("  implement:"), workflow.indexOf("  verify:"));

  // The runner reports state itself, so no observer timing can make the label
  // lag: no polling watcher, and no dependence on a reconciliation sweep.
  assert.match(implement, /Report that implementation started/);
  assert.match(implement, /"agent:running"/);
  assert.doesNotMatch(workflow, /mark-running/);
  assert.match(implement, /startable = new Set\(\["agent:inbox", "agent:triage", "agent:ready", "agent:queued"\]\)/);
  assert.match(implement, /if \(!current\.some\(\(label\) => startable\.has\(label\)\)\)/);
  assert.match(implement, /continue-on-error: true/);

  // The report step is the only write authority the model job holds, and the
  // model still never receives a token: no step passes one into OpenChamber.
  assert.match(implement, /issues: write/);
  assert.doesNotMatch(implement, /contents: write|pull-requests: write|actions: write/);
  const dispatch = implement.slice(implement.indexOf("Run local OAuth implementation lead"));
  assert.doesNotMatch(dispatch, /GITHUB_TOKEN|github\.token/);
});

test("failures retry immediately and only stopped recovery parks at agent:error", async () => {
  const task = await read(".github/workflows/agent-task.yml");
  const publish = task.slice(task.indexOf("  publish:"));
  assert.match(publish, /recoverFailedIssue\(\{ github, context \}, issueNumber\)/);
  assert.ok(
    publish.indexOf("run-failed=${context.runId}") < publish.indexOf("recoverFailedIssue"),
    "the failure must be durably recorded before the retry decision runs",
  );

  const reconcile = await read(".github/workflows/agent-reconcile.yml");
  assert.match(reconcile, /cron: "\*\/10 \* \* \* \*"/);
  // Cron is a backstop only: every completed pipeline run sweeps immediately.
  assert.match(reconcile, /workflow_run:/);
  assert.match(reconcile, /workflows: \[Agent Task, Agent Review, Release\]/);
  assert.match(reconcile, /types: \[in_progress, completed\]/);
  assert.match(reconcile, /github\.event_name == 'workflow_run'/);

  const implementation = await read("scripts/agent-pipeline.mjs");
  assert.match(implementation, /"agent:error",/);
  for (const marker of ["task-exhausted", "no-progress", "repeated-verification", "gate-recovery-exhausted", "orphan-exhausted", "stale-exhausted"]) {
    assert.match(implementation, new RegExp(marker));
  }
  const orchestrator = await read(".opencode/agents/pipeline-orchestrator.md");
  assert.match(orchestrator, /On a resumed attempt with verification evidence, do not launch specialists/);
  assert.match(orchestrator, /make the smallest repair that addresses the complete failure index/);

  const review = await read(".github/workflows/agent-review.yml");
  assert.match(review, /setIssueState\("agent:error"\);\n\s+await github\.rest\.issues\.createComment\(\{\n\s+owner, repo, issue_number: issueNumber,\n\s+body: `<!-- agent-pipeline review-exhausted/);

  // A James reply on an agent:question issue triggers an immediate resume.
  assert.match(task, /startsWith\(github\.event\.comment\.body, '\/oc'\) \|\| contains\(github\.event\.issue\.labels\.\*\.name, 'agent:question'\)/);
});

test("a blocked implementation can ask James and resume on his reply", async () => {
  const workflow = await read(".github/workflows/agent-task.yml");
  const implement = workflow.slice(workflow.indexOf("  implement:"), workflow.indexOf("  verify:"));
  const publish = workflow.slice(workflow.indexOf("  publish:"));
  const pipeline = await read("scripts/agent-pipeline.mjs");

  assert.match(implement, /classifyTaskResult/);
  assert.match(pipeline, /PIPELINE_TASK_QUESTION:\(\\d\+\)/);
  assert.match(pipeline, /PIPELINE_TASK_BLOCKED:\(\\d\+\(\?:,\\d\+\)\*\)/);
  assert.match(publish, /result\.decision\.type === "question"/);
  assert.match(publish, /agent:question/);
  assert.match(publish, /<!-- agent-pipeline question=\$\{context\.runId\} -->/);
  // Question text is model output: it may not forge durable markers, and the
  // question path must publish no candidate PR and dispatch no gates.
  assert.match(publish, /replaceAll\("<!--", "&lt;!--"\)/);
  const questionBranch = publish.slice(
    publish.indexOf('result.decision.type === "question"'),
    publish.indexOf("} else {", publish.indexOf('result.decision.type === "question"')),
  );
  assert.doesNotMatch(questionBranch, /pulls\.create|gh pr create|workflow run/);

  const reconciliation = await read("scripts/agent-pipeline.mjs");
  assert.match(reconciliation, /issuesWithLabel\("agent:question"\)/);
  assert.match(reconciliation, /questionAnswered\(comments\)/);

  // A duplicate dispatch must not clobber an unanswered question, and must
  // still let the answer through.
  const prepare = workflow.slice(workflow.indexOf("  prepare:"), workflow.indexOf("  implement:"));
  assert.match(prepare, /currentLabels\.includes\("agent:question"\)/);
  assert.match(prepare, /agent-pipeline question=/);
  assert.match(prepare, /Date\.parse\(comment\.created_at\) > Date\.parse\(lastQuestion\.created_at\)/);
  assert.match(prepare, /if \(!answered\) \{/);

  const orchestrator = await read(".opencode/agents/pipeline-orchestrator.md");
  assert.match(orchestrator, /PIPELINE_TASK_QUESTION:N/);
  assert.match(orchestrator, /finish every part of the implementation the answer does not affect/);
});

test("queued work is labeled queued until the model runner actually starts", async () => {
  const workflow = await read(".github/workflows/agent-task.yml");
  const prepare = workflow.slice(workflow.indexOf("  prepare:"), workflow.indexOf("  implement:"));
  const implement = workflow.slice(workflow.indexOf("  implement:"), workflow.indexOf("  verify:"));

  assert.match(prepare, /setState\(issue, "agent:queued"\)/);
  assert.doesNotMatch(prepare, /setState\(issue, "agent:running"\)/);
  assert.match(prepare, /!currentLabels\.includes\("agent:running"\)/);
  // The model job may report that it started (issues: write, nothing more) but
  // must never hand a credential to the model, and no per-run watcher job may
  // return: it cannot outlive a deep runner queue.
  assert.doesNotMatch(implement, /GITHUB_TOKEN:/);
  assert.doesNotMatch(implement, /contents: write|pull-requests: write|actions: write/);
  assert.doesNotMatch(workflow, /mark-running/);

  const reconciliation = await read("scripts/agent-pipeline.mjs");
  assert.match(reconciliation, /"agent:queued"/);
  assert.match(reconciliation, /implement\?\.status === "in_progress"\) await setState\(issue\.number, "agent:running"\)/);
  assert.match(reconciliation, /issuesWithLabel\("agent:queued"\), \.\.\.await issuesWithLabel\("agent:running"\)/);
});

test("an ordinary issue comment cannot cancel a queued implementation", async () => {
  const workflow = await read(".github/workflows/agent-task.yml");
  const concurrency = workflow.slice(workflow.indexOf("concurrency:"), workflow.indexOf("jobs:"));

  assert.match(concurrency, /github\.event_name == 'issue_comment'/);
  assert.match(concurrency, /startsWith\(github\.event\.comment\.body, '\/agent'\)/);
  assert.match(concurrency, /startsWith\(github\.event\.comment\.body, '\/oc'\)/);
  assert.match(concurrency, /quickducks-agent-comment-\{0\}', github\.run_id/);
  assert.match(concurrency, /quickducks-agent-issue-\{0\}', github\.event\.issue\.number \|\| inputs\.issue/);
  assert.match(concurrency, /cancel-in-progress: false/);
});

test("failed hosted verification feeds bounded untrusted evidence back to the next attempt", async () => {
  const workflow = await read(".github/workflows/agent-task.yml");
  const implement = workflow.slice(workflow.indexOf("  implement:"), workflow.indexOf("  verify:"));
  const verify = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  publish:"));
  const publish = workflow.slice(workflow.indexOf("  publish:"));

  assert.match(verify, /tee "\$RUNNER_TEMP\/agent-verify\/gate\.log"/);
  assert.match(verify, /cp scripts\/summarize-verification-failure\.mjs scripts\/e2e-redaction\.mjs "\$RUNNER_TEMP\/"/);
  assert.ok(
    verify.indexOf("cp scripts/summarize-verification-failure.mjs") < verify.indexOf("git apply --index task-artifact"),
    "the summarizer must be copied before the candidate patch is applied",
  );
  assert.match(verify, /node "\$RUNNER_TEMP\/summarize-verification-failure\.mjs"/);
  assert.match(verify, /name: agent-verify-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.doesNotMatch(verify, /issues: write|pull-requests: write|contents: write/);

  assert.match(publish, /Download verification failure evidence/);
  assert.match(publish, /verify-artifact\/verification-failure\.txt/);
  assert.match(publish, /<!-- agent-pipeline verification-failed=\$\{context\.runId\} -->/);
  assert.match(publish, /verification\.slice\(0, 30000\)/);
  assert.doesNotMatch(publish, /npm test|npm run test:e2e|opencode run/);

  assert.match(implement, /untrustedVerificationEvidence/);
  assert.match(implement, /includes\("<!-- agent-pipeline verification-failed="\)/);

  const orchestrator = await read(".opencode/agents/pipeline-orchestrator.md");
  assert.match(orchestrator, /untrustedVerificationEvidence/);
  assert.match(orchestrator, /"scripts\/summarize-verification-failure\.mjs": deny/);
});

test("pipeline comments hyperlink workflow runs instead of pasting bare URLs", async () => {
  const task = await read(".github/workflows/agent-task.yml");
  const taskLinks = task.split("\n").filter((line) => line.includes("actions/runs/${context.runId}")
    && !line.includes("details_url"));
  assert.ok(taskLinks.length > 0, "agent-task.yml posts no run links");
  for (const line of taskLinks) {
    assert.match(line, /\]\([^)]*\)/, `bare run URL in agent-task.yml: ${line.trim()}`);
  }

  const review = await read(".github/workflows/agent-review.yml");
  const reviewLinks = review.split("\n").filter((line) => line.includes("${runUrl}"));
  assert.ok(reviewLinks.length > 0, "agent-review.yml posts no run links");
  for (const line of reviewLinks) {
    assert.match(line, /\]\(\$\{runUrl\}\)/, `bare run URL in agent-review.yml: ${line.trim()}`);
  }

  assert.match(task, /\[Agent Task run\]\(\$\{context\.serverUrl\}\/\$\{owner\}\/\$\{repo\}\/actions\/runs\/\$\{context\.runId\}\)/);
  assert.match(task, /\[Agent Task failed\]\(\$\{context\.serverUrl\}\/\$\{owner\}\/\$\{repo\}\/actions\/runs\/\$\{context\.runId\}\)/);
  assert.doesNotMatch(task, /Agent Task (?:run|failed): \$\{context\.serverUrl\}/);
});

test("the exact-head gate is autonomous and keeps deployment human-approved", async () => {
  const review = await read(".github/workflows/agent-review.yml");
  const gate = review.slice(review.indexOf("  gate:"), review.indexOf("  queue-merge:"));
  const reconciliation = await read("scripts/agent-pipeline.mjs");

  assert.doesNotMatch(gate, /humanApproved|SENSITIVE/);
  assert.doesNotMatch(review, /outputs\.sensitive/);
  assert.doesNotMatch(reconciliation, /sensitivePullRequest|currentHumanApproval/);

  assert.match(gate, /decision\.sha === expectedHead/);
  assert.match(gate, /decision\.verdict === "approved"/);
  assert.match(gate, /VALIDATE_RESULT === "success"/);
  assert.match(gate, /!revokedAfterStart/);
  assert.match(gate, /context: "Validate"/);
  assert.ok(
    gate.indexOf('completeCheck("success"') < gate.indexOf('context: "Validate"'),
    "the Validate status is published only alongside an approved exact-head decision",
  );

  const release = await read(".github/workflows/release.yml");
  assert.match(release, /on:\n  workflow_dispatch:\n    inputs:/);
  assert.match(release, /\n  push:\n/);
  assert.match(release, /"\$EVENT_NAME" != "push" && "\$EVENT_NAME" != "workflow_dispatch"/);
  assert.match(release, /environment:/);
  assert.match(release, /production/);

  const policy = await read("scripts/validate-agent-patch.mjs");
  for (const control of ["\\.github", "\\.opencode", "opencode\\\\.json", "AGENTS\\\\.md"]) {
    assert.match(policy, new RegExp(control));
  }
});

test("model budgets let a full feature finish inside each job timeout", async () => {
  const task = await read(".github/workflows/agent-task.yml");
  const implement = task.slice(task.indexOf("  implement:"), task.indexOf("  verify:"));
  const implementMinutes = Number(implement.match(/timeout-minutes: (\d+)/)[1]);
  const implementPoll = Number(implement.match(/--timeout (\d+)/)[1]);
  assert.ok(implementPoll < implementMinutes * 60, "polling must fail before the runner kills the job");
  assert.ok(
    implementMinutes * 60 - implementPoll >= 600,
    "leave at least ten minutes for patch extraction and transactional cleanup",
  );

  const review = await read(".github/workflows/agent-review.yml");
  const independent = review.slice(review.indexOf("  independent-review:"), review.indexOf("  gate:"));
  const reviewMinutes = Number(independent.match(/timeout-minutes: (\d+)/)[1]);
  const reviewPoll = Number(independent.match(/--timeout (\d+)/)[1]);
  assert.ok(reviewPoll < reviewMinutes * 60, "review polling must fail before the runner kills the job");

  const orchestrator = await read(".opencode/agents/pipeline-orchestrator.md");
  const steps = Number(orchestrator.match(/^steps: (\d+)$/m)[1]);
  assert.ok(steps >= 300, `the implementation lead needs room to finish a feature, got ${steps}`);
  assert.match(orchestrator, /running out of steps discards the entire attempt/);
});

test("reconciliation is deterministic and model-free", async () => {
  const workflow = await read(".github/workflows/agent-reconcile.yml");
  const implementation = await read("scripts/agent-pipeline.mjs");
  // Model-free means it never invokes a model or claims the model runner;
  // the opencode/ branch prefix is candidate naming, not model execution.
  assert.doesNotMatch(workflow, /models: read|id-token: write/);
  assert.doesNotMatch(workflow, /openchamber|runs-on: \[self-hosted/);
  assert.match(workflow, /reconcileAgentPipeline/);
  assert.match(implementation, /run\.event !== "workflow_dispatch"/);
  assert.match(implementation, /basehead: `\$\{recordedBase\}\.\.\.\$\{run\.head_sha\}`/);
  assert.match(implementation, /getBranch\(\{ owner, repo, branch: pr\.base\.ref \}\)/);
  assert.match(implementation, /basehead: `\$\{run\.head_sha\}\.\.\.\$\{defaultRef\.data\.commit\.sha\}`/);
  assert.doesNotMatch(implementation, /workflow_id: "ci\.yml", ref: pr\.head\.ref/);
  assert.match(implementation, /workflow_id: "agent-review\.yml", ref: defaultBranch/);
  assert.match(implementation, /workflow_id: "release\.yml", ref: defaultBranch/);
  const queue = implementation.slice(implementation.indexOf("export async function queueNextApproved"));
  assert.ok(
    queue.indexOf("github.rest.pulls.merge") < queue.lastIndexOf('workflow_id: "release.yml"'),
    "the exact-head merge must complete before its release is dispatched",
  );
});

test("Pipeline Doctor isolates diagnosis from trusted publication", async () => {
  const workflow = await read(".github/workflows/pipeline-doctor.yml");
  const diagnose = workflow.slice(workflow.indexOf("  diagnose:"), workflow.indexOf("  verify:"));
  const verify = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  publish:"));
  const publish = workflow.slice(workflow.indexOf("  publish:"), workflow.indexOf("  metrics:"));

  assert.match(workflow, /workflow_run:\n\s+workflows: \[Agent Task, Agent Review, Agent Reconcile, Release\]/);
  assert.match(workflow, /schedule:\n\s+- cron:/);
  assert.match(workflow, /permissions: \{\}/);
  assert.match(workflow, /pipeline:incident/);
  assert.match(workflow, /doctorIncidentMarker/);
  assert.match(workflow, /attempts >= 2/);
  assert.match(diagnose, /runs-on: \[self-hosted, macOS, ARM64, quickducks-implement\]/);
  assert.match(diagnose, /openchamber session create/);
  assert.match(diagnose, /--agent pipeline-doctor/);
  assert.match(diagnose, /scripts\/validate-pipeline-repair\.mjs/);
  assert.doesNotMatch(diagnose, /contents: write|issues: write|pull-requests: write|actions: write|GITHUB_TOKEN:/);
  assert.match(verify, /rhysd\/actionlint@sha256:[0-9a-f]{64}/);
  assert.match(verify, /npm test/);
  assert.doesNotMatch(verify, /contents: write|issues: write|pull-requests: write/);
  assert.match(publish, /actions: write/);
  assert.match(publish, /contents: write/);
  assert.match(publish, /pull-requests: write/);
  assert.match(publish, /gh workflow run ci\.yml --ref "\$branch"/);
  assert.doesNotMatch(publish, /openchamber|runs-on: \[self-hosted/);

  const agent = await read(".opencode/agents/pipeline-doctor.md");
  assert.match(agent, /task:\n\s+"\*": deny/);
  assert.match(agent, /pipeline-doctor\.yml/);
  assert.match(agent, /Do not edit application code/);
  const validator = await read("scripts/validate-pipeline-repair.mjs");
  assert.doesNotMatch(validator, /pipeline-doctor\.yml",/);
  assert.match(validator, /1,500-line limit/);
});

test("every merge lane can dispatch the release it creates", async () => {
  const review = await read(".github/workflows/agent-review.yml");
  const reviewLane = review.slice(review.indexOf("  queue-merge:"), review.indexOf("  metrics:"));
  assert.match(reviewLane, /actions: write/);

  const reconcile = await read(".github/workflows/agent-reconcile.yml");
  const reconcileLane = reconcile.slice(reconcile.indexOf("  queue-next:"), reconcile.indexOf("  metrics:"));
  assert.match(reconcileLane, /actions: write/);

  const implementation = await read("scripts/agent-pipeline.mjs");
  const slotSettlement = implementation.slice(
    implementation.indexOf("if (!active && deployedRun)"),
    implementation.indexOf("} else if (!active && completed)"),
  );
  assert.match(slotSettlement, /state: "closed", state_reason: "completed"/);
});
