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
  assert.match(implement, /openai\/gpt-5\.6-sol/);
  assert.doesNotMatch(implement, /quickducks-local-oauth-model/);
  assert.doesNotMatch(implement, /OPENCODE_ENSEMBLE_TIMEOUT|--dir "\$GITHUB_WORKSPACE"/);
  assert.match(implement, /timeout-minutes: 105/);
  assert.match(implement, /untrustedReviewEvidence/);
  assert.match(implement, /git archive "\$EXPECTED_BASE"/);
  assert.match(implement, /validate-agent-patch\.mjs" --source "\$PIPELINE_MODEL_DIR"/);
  for (const runtimePath of ["node_modules", "package.json", "package-lock.json", "bun.lock"]) {
    assert.match(implement, new RegExp(`\\.opencode/${runtimePath.replace(".", "\\.")}`));
  }
  assert.ok(implement.indexOf(".opencode/node_modules") < implement.indexOf("validate-agent-patch.mjs\" --source"));
  assert.ok(implement.indexOf("validate-agent-patch.mjs\" --source") < implement.indexOf("rsync -a"));
  assert.match(implement, /cleanup-model-workspace\.mjs/);
  assert.doesNotMatch(implement, /rm -rf "\$RUNNER_TEMP\/agent-task"/);
  assert.match(implement, /scripts\/validate-agent-patch\.mjs/);
  assert.match(implement, /session list --dir "\$PIPELINE_MODEL_DIR" --with-status/);
  assert.doesNotMatch(verify, /id-token: write|models: read/);
  assert.match(verify, /scripts\/validate-agent-patch\.mjs/);
  assert.doesNotMatch(publish, /id-token: write/);
  assert.match(publish, /actions: write/);
  assert.match(publish, /contents: write/);
  assert.doesNotMatch(publish, /opencode run|npm test|npm run test:e2e/);
  assert.doesNotMatch(publish, /exchange_github_app_token|api\.opencode\.ai|id-token: write/);
  assert.match(publish, /GH_TOKEN: \$\{\{ github\.token \}\}/);
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
  assert.match(review, /anthropic\/claude-opus-4-8/);
  assert.doesNotMatch(review, /quickducks-local-oauth-model/);
  assert.doesNotMatch(review, /REVIEW_CANDIDATE_PATH|--dir "\$GITHUB_WORKSPACE\/trusted"/);
  assert.match(review, /\.pipeline\/candidate\.patch/);
  assert.match(review, /git -C trusted archive/);
  assert.match(review, /session list --dir "\$PIPELINE_MODEL_DIR" --with-status/);
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

test("reconciliation is deterministic and model-free", async () => {
  const workflow = await read(".github/workflows/agent-reconcile.yml");
  const implementation = await read("scripts/agent-pipeline.mjs");
  assert.doesNotMatch(workflow, /models: read|id-token: write|opencode/);
  assert.match(workflow, /reconcileAgentPipeline/);
  assert.match(implementation, /run\.event === "workflow_dispatch"/);
  assert.match(implementation, /workflow_id: "ci\.yml", ref: pr\.head\.ref/);
  assert.match(implementation, /workflow_id: "agent-review\.yml", ref: defaultBranch/);
});
