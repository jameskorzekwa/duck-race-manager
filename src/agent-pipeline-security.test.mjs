import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("implementation keeps models and candidate execution outside OIDC publication", async () => {
  const workflow = await read(".github/workflows/agent-task.yml");
  const implement = workflow.slice(workflow.indexOf("  implement:"), workflow.indexOf("  verify:"));
  const verify = workflow.slice(workflow.indexOf("  verify:"), workflow.indexOf("  publish:"));
  const publish = workflow.slice(workflow.indexOf("  publish:"));

  assert.doesNotMatch(implement, /id-token: write/);
  assert.match(implement, /models: read/);
  assert.doesNotMatch(verify, /id-token: write|models: read/);
  assert.match(publish, /id-token: write/);
  assert.doesNotMatch(publish, /opencode run|npm test|npm run test:e2e/);
  assert.match(publish, /exchange_github_app_token/);
});

test("review publishes a candidate-SHA check without privileged candidate execution", async () => {
  const workflow = await read(".github/workflows/agent-review.yml");
  const validate = workflow.slice(workflow.indexOf("  validate-candidate:"), workflow.indexOf("  independent-review:"));
  const review = workflow.slice(workflow.indexOf("  independent-review:"), workflow.indexOf("  gate:"));
  const gate = workflow.slice(workflow.indexOf("  gate:"), workflow.indexOf("  queue-merge:"));

  assert.doesNotMatch(validate, /id-token: write|models: read|cache: npm/);
  assert.match(review, /models: read/);
  assert.doesNotMatch(review, /id-token: write|issues: write|pull-requests: write/);
  assert.match(gate, /Agent Review \/ Exact SHA/);
  assert.doesNotMatch(gate, /actions\/checkout|npm test|opencode run/);
});

test("reconciliation is deterministic and model-free", async () => {
  const workflow = await read(".github/workflows/agent-reconcile.yml");
  assert.doesNotMatch(workflow, /models: read|id-token: write|opencode/);
  assert.match(workflow, /reconcileAgentPipeline/);
});
