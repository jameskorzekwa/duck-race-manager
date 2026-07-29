import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const protectedPaths = [
  /(^|\/)\.git($|\/)/i,
  /(^|\/)\.gitattributes$/i,
  /(^|\/)\.gitmodules$/i,
  /(^|\/)AGENTS\.md$/i,
  /^\.github\/(?:actions|workflows)(?:\/|$)/i,
  /^\.opencode(?:\/|$)/i,
  /^opencode\.json$/i,
  /^scripts\/agent-pipeline\.mjs$/i,
  /^scripts\/cleanup-model-workspace\.mjs$/i,
  /^scripts\/validate-agent-patch\.mjs$/i,
  /^scripts\/wait-for-openchamber-session\.mjs$/i,
];

const gitControlPath = (candidate) => candidate.split("/").some((part) => part.toLowerCase() === ".git")
  || [".gitattributes", ".gitmodules"].includes(path.posix.basename(candidate).toLowerCase());

export function assertSafeChangedPaths(paths) {
  const blocked = paths.filter((candidate) => protectedPaths.some((pattern) => pattern.test(candidate)));
  if (blocked.length > 0) {
    throw new Error(`Autonomous patches may not change pipeline control paths:\n${blocked.join("\n")}`);
  }
}

export function assertSafeTreeEntries(entries) {
  const unsafe = entries.filter(({ mode }) => mode === "120000" || mode === "160000");
  if (unsafe.length > 0) {
    throw new Error(`Autonomous patches may not contain symlinks or gitlinks:\n${unsafe.map(({ path: entryPath }) => entryPath).join("\n")}`);
  }
  const gitControl = entries.filter(({ path: entryPath }) => gitControlPath(entryPath));
  if (gitControl.length > 0) {
    throw new Error(`Agent trees may not contain Git control files:\n${gitControl.map(({ path: entryPath }) => entryPath).join("\n")}`);
  }
}

export function validatePlainWorkspace(root) {
  const absoluteRoot = path.resolve(root);
  const rootStat = lstatSync(absoluteRoot);
  if (!rootStat.isDirectory()) throw new Error("Model workspace root must be a directory.");
  const caseFolded = new Map();

  const visit = (absoluteDirectory, relativeDirectory = "") => {
    for (const name of readdirSync(absoluteDirectory)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolutePath = path.join(absoluteDirectory, name);
      const folded = relativePath.normalize("NFC").toLowerCase();
      const existing = caseFolded.get(folded);
      if (existing && existing !== relativePath) {
        throw new Error(`Model workspace contains a case-folded path collision: ${existing} and ${relativePath}`);
      }
      caseFolded.set(folded, relativePath);
      if (gitControlPath(relativePath)) {
        throw new Error(`Model workspace contains a Git control path: ${relativePath}`);
      }

      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) throw new Error(`Model workspace contains a symlink: ${relativePath}`);
      if (stat.isDirectory()) {
        visit(absolutePath, relativePath);
      } else if (!stat.isFile()) {
        throw new Error(`Model workspace contains a non-regular file: ${relativePath}`);
      } else if (stat.nlink !== 1) {
        throw new Error(`Model workspace contains a hard-linked file: ${relativePath}`);
      }
    }
  };

  visit(absoluteRoot);
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  });
}

function nulFields(value) {
  return value.split("\0").filter(Boolean);
}

export function validateStagedPatch(cwd) {
  const changed = nulFields(git(cwd, ["diff", "--cached", "--no-renames", "--name-only", "-z", "HEAD"]));
  const entries = nulFields(git(cwd, ["ls-files", "-s", "-z"])).map((entry) => {
    const match = entry.match(/^(\d{6}) [0-9a-f]+ \d\t([\s\S]+)$/);
    if (!match) throw new Error(`Unable to parse staged tree entry: ${entry}`);
    return { mode: match[1], path: match[2] };
  });
  assertSafeChangedPaths(changed);
  assertSafeTreeEntries(entries);
}

export function validateCommitRange(cwd, base, head) {
  const changed = nulFields(git(cwd, ["diff", "--no-renames", "--name-only", "-z", base, head]));
  const entries = nulFields(git(cwd, ["ls-tree", "-r", "-z", head])).map((entry) => {
    const match = entry.match(/^(\d{6}) \w+ [0-9a-f]+\t([\s\S]+)$/);
    if (!match) throw new Error(`Unable to parse commit tree entry: ${entry}`);
    return { mode: match[1], path: match[2] };
  });
  assertSafeChangedPaths(changed);
  assertSafeTreeEntries(entries);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--source") {
    if (args.length !== 2) throw new Error("Provide exactly one model workspace for --source.");
    validatePlainWorkspace(args[1]);
    process.exit(0);
  }
  const [cwd = process.cwd(), base, head] = args;
  if ((base && !head) || (!base && head)) throw new Error("Provide both base and head, or neither.");
  if (base) validateCommitRange(cwd, base, head);
  else validateStagedPatch(cwd);
}
