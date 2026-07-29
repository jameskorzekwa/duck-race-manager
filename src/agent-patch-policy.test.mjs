import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, link, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { cleanupModelWorkspace } from "../scripts/cleanup-model-workspace.mjs";
import {
  assertSafeChangedPaths,
  assertSafeTreeEntries,
  validateCommitRange,
  validatePlainWorkspace,
  validateStagedPatch,
} from "../scripts/validate-agent-patch.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });

test("agent patches may change application and test files", () => {
  assert.doesNotThrow(() => assertSafeChangedPaths([
    "src/api.ts",
    "src/api.test.mjs",
    "docs/PROJECT_PLAN.md",
  ]));
});

test("agent patches cannot change executable pipeline control", () => {
  for (const candidate of [
    ".github/workflows/ci.yml",
    ".github/actions/publish/action.yml",
    ".opencode/agents/pipeline-orchestrator.md",
    "opencode.json",
    "AGENTS.md",
    "src/AGENTS.md",
    ".gitattributes",
    "scripts/agent-pipeline.mjs",
    "scripts/cleanup-model-workspace.mjs",
    "scripts/validate-agent-patch.mjs",
    "scripts/wait-for-openchamber-session.mjs",
    ".git/config",
    ".Git/config",
    ".Gitattributes",
    ".GitHub/Workflows/ci.yml",
    ".OpenCode/agents/reviewer.md",
    "OpenCode.JSON",
  ]) {
    assert.throws(() => assertSafeChangedPaths([candidate]), /pipeline control paths/);
  }
});

test("agent patches cannot introduce symlinks or gitlinks", () => {
  assert.throws(
    () => assertSafeTreeEntries([{ mode: "120000", path: "credential-link" }]),
    /symlinks or gitlinks/,
  );
  assert.throws(
    () => assertSafeTreeEntries([{ mode: "160000", path: "nested-repository" }]),
    /symlinks or gitlinks/,
  );
  assert.throws(
    () => assertSafeTreeEntries([{ mode: "100644", path: ".Git/config" }]),
    /Git control files/,
  );
  assert.doesNotThrow(() => assertSafeTreeEntries([{ mode: "100644", path: "src/api.ts" }]));
});

test("plain model workspace validation rejects filesystem escapes", async () => {
  const safe = await mkdtemp(path.join(os.tmpdir(), "quickducks-model-source-safe-"));
  await mkdir(path.join(safe, "src"));
  await writeFile(path.join(safe, "src", "app.ts"), "export {};\n");
  assert.doesNotThrow(() => validatePlainWorkspace(safe));

  const gitControl = await mkdtemp(path.join(os.tmpdir(), "quickducks-model-source-git-"));
  await mkdir(path.join(gitControl, ".Git"));
  await writeFile(path.join(gitControl, ".Git", "config"), "unsafe\n");
  assert.throws(() => validatePlainWorkspace(gitControl), /Git control path/);

  const linked = await mkdtemp(path.join(os.tmpdir(), "quickducks-model-source-link-"));
  await writeFile(path.join(linked, "target"), "safe\n");
  await symlink("target", path.join(linked, "symbolic"));
  assert.throws(() => validatePlainWorkspace(linked), /symlink/);

  const hardLinked = await mkdtemp(path.join(os.tmpdir(), "quickducks-model-source-hardlink-"));
  await writeFile(path.join(hardLinked, "first"), "safe\n");
  await link(path.join(hardLinked, "first"), path.join(hardLinked, "second"));
  assert.throws(() => validatePlainWorkspace(hardLinked), /hard-linked file/);
});

test("model workspace cleanup is transactional for read-only trees", async () => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "quickducks-model-state-"));
  const workspaceRoot = path.join(stateRoot, "workspaces");
  const workspace = path.join(workspaceRoot, "review-1");
  const nested = path.join(workspace, "nested");
  const statePath = path.join(stateRoot, "active.json");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "result.txt"), "done\n");
  await writeFile(statePath, JSON.stringify({ directory: workspace }));
  await chmod(path.join(nested, "result.txt"), 0o400);
  await chmod(nested, 0o500);
  await chmod(workspace, 0o500);

  cleanupModelWorkspace(statePath, workspaceRoot, workspace);
  assert.equal(existsSync(workspace), false);
  assert.equal(existsSync(statePath), false);

  const other = path.join(workspaceRoot, "task-2");
  await mkdir(other, { recursive: true });
  await writeFile(statePath, JSON.stringify({ directory: path.join(workspaceRoot, "busy") }));
  cleanupModelWorkspace(statePath, workspaceRoot, other);
  assert.equal(existsSync(other), false);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).directory, path.join(workspaceRoot, "busy"));
  assert.throws(
    () => cleanupModelWorkspace(statePath, workspaceRoot, path.join(stateRoot, "outside")),
    /outside the persistent workspace root/,
  );
});

test("staged patch validation reads the actual Git index", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quickducks-agent-patch-"));
  git(directory, "init", "--quiet");
  git(directory, "config", "user.name", "Patch Policy Test");
  git(directory, "config", "user.email", "patch-policy@example.invalid");
  await mkdir(path.join(directory, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(directory, "app.txt"), "base\n");
  await writeFile(path.join(directory, ".github", "workflows", "ci.yml"), "name: trusted\n");
  git(directory, "add", "app.txt", ".github/workflows/ci.yml");
  git(directory, "commit", "--quiet", "-m", "base");

  await writeFile(path.join(directory, "app.txt"), "safe change\n");
  git(directory, "add", "app.txt");
  assert.doesNotThrow(() => validateStagedPatch(directory));
  git(directory, "reset", "--quiet", "--hard", "HEAD");

  await mkdir(path.join(directory, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(directory, ".github", "workflows", "host.yml"), "name: unsafe\n");
  git(directory, "add", ".github/workflows/host.yml");
  assert.throws(() => validateStagedPatch(directory), /pipeline control paths/);
  git(directory, "reset", "--quiet", "--hard", "HEAD");

  await mkdir(path.join(directory, "docs"), { recursive: true });
  git(directory, "mv", ".github/workflows/ci.yml", "docs/renamed-workflow.yml");
  assert.throws(() => validateStagedPatch(directory), /pipeline control paths/);
  git(directory, "reset", "--quiet", "--hard", "HEAD");

  await symlink("app.txt", path.join(directory, "credential-link"));
  git(directory, "add", "credential-link");
  assert.throws(() => validateStagedPatch(directory), /symlinks or gitlinks/);
  git(directory, "reset", "--quiet", "--hard", "HEAD");

  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  await writeFile(path.join(directory, ".github", "workflows", "ci.yml"), "name: changed\n");
  git(directory, "add", ".github/workflows/ci.yml");
  git(directory, "commit", "--quiet", "-m", "unsafe workflow change");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  assert.throws(() => validateCommitRange(directory, base, head), /pipeline control paths/);
});
