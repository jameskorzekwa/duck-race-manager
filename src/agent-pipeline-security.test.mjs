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
  assert.match(implement, /runs-on: \[self-hosted, macOS, ARM64, quickducks-model\]/);
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
  assert.doesNotMatch(publish, /id-token: write/);
  assert.match(publish, /actions: write/);
  assert.match(publish, /contents: write/);
  assert.doesNotMatch(publish, /opencode run|npm test|npm run test:e2e/);
  assert.doesNotMatch(publish, /exchange_github_app_token|api\.opencode\.ai|id-token: write/);
  assert.match(publish, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(publish, /attempt-digest=\$\{attemptDigest\}/);
  assert.match(publish, /ATTEMPT_DIGEST: \$\{\{ needs\.implement\.outputs\.digest \}\}/);
  assert.match(publish, /base64 \| tr -d '\\n'/);
  assert.match(publish, /github-actions\[bot\]/);
  assert.match(publish, /gh workflow run ci\.yml --ref "\$branch"/);
  assert.match(publish, /gh workflow run agent-review\.yml/);
  assert.match(publish, /--ref "\$\{\{ github\.event\.repository\.default_branch \}\}"/);
  assert.match(publish, /scripts\/validate-agent-patch\.mjs/);
});

test("review publishes a candidate-SHA check without privileged candidate execution", async () => {
  const workflow = await read(".github/workflows/agent-review.yml");
  const validate = workflow.slice(workflow.indexOf("  validate-candidate:"), workflow.indexOf("  independent-review:"));
  const review = workflow.slice(workflow.indexOf("  independent-review:"), workflow.indexOf("  gate:"));
  const gate = workflow.slice(workflow.indexOf("  gate:"), workflow.indexOf("  queue-merge:"));

  assert.doesNotMatch(validate, /id-token: write|models: read|cache: npm/);
  assert.doesNotMatch(review, /models: read|OPENCODE_AUTH_CONTENT|GITHUB_TOKEN:/);
  assert.match(review, /runs-on: \[self-hosted, macOS, ARM64, quickducks-model\]/);
  assert.match(review, /openchamber session create/);
  assert.match(review, /vars\.AGENT_REVIEW_MODEL \|\| 'anthropic\/claude-opus-4-8'/);
  assert.match(review, /--model "\$PIPELINE_REVIEW_MODEL"/);
  assert.match(review, /wait-for-openchamber-session\.mjs/);
  assert.doesNotMatch(review, /openchamber session create[\s\S]*?--wait/);
  assert.match(review, /session-dispatch\.json" 2>&1 \|\| true/);
  assert.doesNotMatch(review, /quickducks-local-oauth-model/);
  assert.doesNotMatch(review, /REVIEW_CANDIDATE_PATH|--dir "\$GITHUB_WORKSPACE\/trusted"/);
  assert.match(review, /\.pipeline\/candidate\.patch/);
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
  assert.match(lane, /agent-review\.yml/);
  assert.match(lane, /run\.head_branch === pr\.head\.ref/);
  assert.ok(
    implementation.indexOf("const pendingGate") < implementation.indexOf("gate-recovery-exhausted"),
    "the pending-gate check must run before any attempt is counted",
  );
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
  assert.match(reconcile, /workflows: \[Agent Task, Agent Review PR, Release\]/);
  assert.match(reconcile, /types: \[completed\]/);
  assert.match(reconcile, /github\.event_name == 'workflow_run'/);

  const implementation = await read("scripts/agent-pipeline.mjs");
  assert.match(implementation, /"agent:error",/);
  for (const marker of ["task-exhausted", "no-progress", "gate-recovery-exhausted", "orphan-exhausted", "stale-exhausted"]) {
    assert.match(implementation, new RegExp(marker));
  }

  const review = await read(".github/workflows/agent-review.yml");
  assert.match(review, /setIssueState\("agent:error"\);\n\s+await github\.rest\.issues\.createComment\(\{\n\s+owner, repo, issue_number: issueNumber,\n\s+body: `<!-- agent-pipeline review-exhausted/);

  // A James reply on an agent:question issue triggers an immediate resume.
  assert.match(task, /startsWith\(github\.event\.comment\.body, '\/oc'\) \|\| contains\(github\.event\.issue\.labels\.\*\.name, 'agent:question'\)/);
});

test("a blocked implementation can ask James and resume on his reply", async () => {
  const workflow = await read(".github/workflows/agent-task.yml");
  const implement = workflow.slice(workflow.indexOf("  implement:"), workflow.indexOf("  verify:"));
  const publish = workflow.slice(workflow.indexOf("  publish:"));

  assert.match(implement, /PIPELINE_TASK_QUESTION:\(\\d\+\)/);
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
  // The model job itself must stay token-free, and no per-run watcher job may
  // return: it cannot outlive a deep runner queue.
  assert.doesNotMatch(implement, /GITHUB_TOKEN:|issues: write/);
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
  assert.doesNotMatch(workflow, /models: read|id-token: write|opencode/);
  assert.match(workflow, /reconcileAgentPipeline/);
  assert.match(implementation, /run\.event === "workflow_dispatch"/);
  assert.match(implementation, /workflow_id: "ci\.yml", ref: pr\.head\.ref/);
  assert.match(implementation, /workflow_id: "agent-review\.yml", ref: defaultBranch/);
});
