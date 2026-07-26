import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import semver from "semver";

const canonicalVersion = (value, label) => {
  const parsed = semver.parse(value);
  const normalized = parsed === null
    ? null
    : `${parsed.version}${parsed.build.length > 0 ? `+${parsed.build.join(".")}` : ""}`;
  if (normalized === null || normalized !== value) {
    throw new Error(`${label} must be a canonical semantic version; received ${value || "<empty>"}.`);
  }
  return normalized;
};

export const parseReleaseTag = (tag) => {
  if (!tag.startsWith("v")) {
    throw new Error(`Release tag must have a v prefix; received ${tag || "<empty>"}.`);
  }

  const version = canonicalVersion(tag.slice(1), "Release tag version");
  return {
    version,
    prerelease: semver.prerelease(version) !== null,
  };
};

export const assessReleaseVersion = ({ currentVersion, currentCommit, incomingVersion, incomingCommit }) => {
  const incoming = canonicalVersion(incomingVersion, "Incoming release version");
  if (!incomingCommit) throw new Error("Incoming release commit is required.");

  if (currentVersion === undefined) {
    if (currentCommit !== undefined) {
      throw new Error("CloudFormation has a Commit tag but no Version tag; refusing to treat this as a first release.");
    }
    return "first";
  }

  const current = canonicalVersion(currentVersion, "CloudFormation Version tag");
  if (!currentCommit) {
    throw new Error("CloudFormation has a Version tag but no Commit tag; refusing release.");
  }
  if (incoming === current) {
    if (currentCommit !== incomingCommit) {
      throw new Error("The same release version may be rerun only for the commit already recorded on the stack.");
    }
    return "recovery";
  }
  if (semver.compare(incoming, current) <= 0) {
    throw new Error(`Incoming release ${incoming} must be greater than deployed release ${current}.`);
  }
  return "upgrade";
};

const runGit = (args) => spawnSync("git", args, { encoding: "utf8" });

export const assertReleaseCommitAncestry = ({ currentCommit, incomingCommit }, git = runGit) => {
  if (currentCommit === undefined) return;
  for (const [label, commit] of [["recorded", currentCommit], ["incoming", incomingCommit]]) {
    if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
      throw new Error(`The ${label} release commit is not a full lowercase Git commit SHA.`);
    }
    const available = git(["cat-file", "-e", `${commit}^{commit}`]);
    if (available.status !== 0) {
      throw new Error(`The ${label} release commit ${commit} is unavailable in the checkout; refusing release.`);
    }
  }

  const ancestry = git(["merge-base", "--is-ancestor", currentCommit, incomingCommit]);
  if (ancestry.status === 1) {
    throw new Error(`Incoming release commit ${incomingCommit} does not descend from recorded commit ${currentCommit}.`);
  }
  if (ancestry.status !== 0) {
    throw new Error("Git could not verify release commit ancestry; refusing release.");
  }
};

const isMain = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const { version, prerelease } = parseReleaseTag(process.argv[2] ?? "");
  const output = `version=${version}\nprerelease=${String(prerelease)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
