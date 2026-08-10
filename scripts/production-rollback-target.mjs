// Chooses the Worker version to restore when post-deploy verification fails.
//
// Production deploys are automatic, so nothing human stands between a bad
// Worker and race-day traffic. Post-deploy verification already detects a bad
// deploy, but detection alone left the broken Worker serving until someone
// noticed. This picks the version that was live immediately before the deploy,
// read from `wrangler deployments status --json`.
//
// It fails closed. A rollback aims real traffic at a specific Worker version,
// so an unrecognised, empty, or ambiguous deployment shape must stop the
// rollback and escalate rather than guess a version.

const VERSION_ID = /^[0-9a-f-]{8,}$/i;

export function selectRollbackTarget(status) {
  if (status === null || typeof status !== "object" || Array.isArray(status)) {
    throw new Error("Wrangler deployment status was not an object.");
  }

  const versions = status.versions ?? status.deployment?.versions;
  if (!Array.isArray(versions) || versions.length === 0) {
    throw new Error("Wrangler deployment status listed no Worker versions.");
  }

  const entries = versions.map((entry) => {
    const id = typeof entry === "string" ? entry : entry?.version_id ?? entry?.id;
    if (typeof id !== "string" || !VERSION_ID.test(id)) {
      throw new Error("Wrangler deployment status contained an unusable Worker version id.");
    }
    // A version with no explicit split is the whole deployment.
    const share = typeof entry === "string" ? 100 : entry.percentage ?? entry.share ?? 100;
    if (typeof share !== "number" || !Number.isFinite(share)) {
      throw new Error(`Worker version ${id} reported a non-numeric traffic share.`);
    }
    return { id, share };
  });

  // A gradual deployment splits traffic across versions, so "the previous
  // production Worker" is not a single version. Restoring one of them would be
  // a guess about which half was correct; stop and let a human decide.
  const serving = entries.filter(({ share }) => share > 0);
  if (serving.length !== 1) {
    throw new Error(
      `Expected exactly one Worker version serving traffic, found ${serving.length}. `
      + "Roll back manually: a split deployment has no single previous version.",
    );
  }
  return serving[0].id;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const raw = await new Promise((resolve, reject) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => resolve(body));
    process.stdin.on("error", reject);
  });
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Wrangler deployment status was not valid JSON.");
  }
  process.stdout.write(selectRollbackTarget(parsed));
}
