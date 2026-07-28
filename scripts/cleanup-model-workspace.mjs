import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function makeOwnerWritable(directory) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(directory, (stat.mode & 0o777) | 0o700);
    for (const name of readdirSync(directory)) makeOwnerWritable(path.join(directory, name));
  } else {
    chmodSync(directory, (stat.mode & 0o777) | 0o600);
  }
}

export function cleanupModelWorkspace(statePath, workspaceRoot, directory) {
  const root = path.resolve(workspaceRoot) + path.sep;
  const target = path.resolve(directory);
  if (!target.startsWith(root)) throw new Error("Model workspace is outside the persistent workspace root.");

  if (existsSync(target)) {
    makeOwnerWritable(target);
    rmSync(target, { recursive: true, force: true });
    if (existsSync(target)) throw new Error(`Model workspace still exists after cleanup: ${target}`);
  }

  if (!existsSync(statePath)) return;
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (path.resolve(String(state.directory ?? "")) === target) rmSync(statePath);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [statePath, workspaceRoot, directory] = process.argv.slice(2);
  if (!statePath || !workspaceRoot || !directory) {
    throw new Error("Usage: cleanup-model-workspace.mjs <state-path> <workspace-root> <directory>");
  }
  cleanupModelWorkspace(statePath, workspaceRoot, directory);
}
