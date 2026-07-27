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
    tag,
    version,
    prerelease: semver.prerelease(version) !== null,
  };
};

const runGit = (args) => spawnSync("git", args, { encoding: "utf8" });

const gitOutput = (git, args, operation) => {
  const result = git(args);
  if (result?.error || result?.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(`Git could not ${operation}; refusing automatic release.`);
  }
  return result.stdout.trim();
};

export const selectAutomaticRelease = ({ sourceSha }, git = runGit) => {
  if (!/^[0-9a-f]{40}$/.test(sourceSha ?? "")) {
    throw new Error("Automatic release source must be a full lowercase Git commit SHA.");
  }

  const listed = gitOutput(
    git,
    ["tag", "--list", "v*.*.*"],
    "list release tags",
  ).split("\n").filter(Boolean);

  const stable = [];
  for (const tag of listed) {
    let parsed;
    try {
      parsed = parseReleaseTag(tag);
    } catch {
      continue; // Malformed and non-canonical matching tags never participate.
    }
    if (parsed.prerelease) continue; // Prereleases are never automatic stable bases.
    stable.push(parsed);
  }

  if (stable.length === 0) {
    throw new Error("Automatic release requires at least one stable canonical release tag.");
  }

  const highestVersion = stable.reduce(
    (left, right) => (semver.compare(left.version, right.version) >= 0 ? left : right),
  ).version;
  const highestTags = stable
    .filter(({ version }) => semver.compare(version, highestVersion) === 0)
    .sort((left, right) => {
      const buildRank = (entry) => (entry.tag === `v${semver.parse(entry.version).version}` ? 0 : 1);
      return (buildRank(left) - buildRank(right)) || (left.tag < right.tag ? -1 : 1);
    });

  for (const candidate of highestTags) {
    const commit = gitOutput(
      git,
      ["rev-parse", "--verify", `refs/tags/${candidate.tag}^{commit}`],
      `resolve highest stable release tag ${candidate.tag}`,
    );
    if (!/^[0-9a-f]{40}$/.test(commit)) {
      throw new Error(`Git did not resolve ${candidate.tag} to a full lowercase commit SHA.`);
    }
    if (commit === sourceSha) return candidate; // Same-source recovery reuses the recorded tag.
  }

  const version = semver.inc(highestVersion, "patch");
  if (version === null) {
    throw new Error(`Could not increment highest stable release v${highestVersion}.`);
  }
  return {
    tag: `v${version}`,
    version,
    prerelease: false,
  };
};

export const assessReleaseVersion = ({ currentVersion, currentCommit, incomingVersion, incomingCommit }, git = runGit) => {
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
    if (currentCommit === incomingCommit) return "recovery";
    // Forward recovery for a deployed-but-untagged predecessor: the recorded
    // version may move to a different source commit only when no release tag
    // ever published that version. Ancestry of the recorded commit is proved
    // separately by assertReleaseCommitAncestry.
    const tagged = git(["show-ref", "--verify", "--quiet", `refs/tags/v${current}`]);
    if (!tagged?.error && tagged?.status === 1) return "takeover";
    if (tagged?.error || tagged?.status !== 0) {
      throw new Error(`Git could not determine whether release tag v${current} exists; refusing release.`);
    }
    throw new Error(
      `Release version ${current} is already tagged; the same version may be rerun only for the commit already recorded on the stack.`,
    );
  }
  if (semver.compare(incoming, current) <= 0) {
    if (semver.prerelease(current) !== null && semver.prerelease(incoming) === null) {
      // A deployed explicit prerelease never joins the stable release train:
      // the next stable release may carry lower SemVer precedence.
      return "stable-after-prerelease";
    }
    throw new Error(`Incoming release ${incoming} must be greater than deployed release ${current}.`);
  }
  return "upgrade";
};

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
  const release = process.argv[2] === "--automatic"
    ? selectAutomaticRelease({ sourceSha: process.argv[3] })
    : parseReleaseTag(process.argv[2] ?? "");
  const { tag, version, prerelease } = release;
  const output = `tag=${tag}\nversion=${version}\nprerelease=${String(prerelease)}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
}
