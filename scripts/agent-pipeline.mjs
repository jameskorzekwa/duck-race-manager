import { createHash } from "node:crypto";

const STATE_LABELS = [
  "agent:inbox",
  "agent:triage",
  "agent:ready",
  "agent:queued",
  "agent:running",
  "agent:grouped",
  "agent:blocked",
  "agent:question",
  "agent:review",
  "agent:reviewing",
  "agent:approved",
  "agent:deployed",
  "agent:failed",
  "agent:error",
];
const AUTOMATION_USER_ID = 41898282;

function trustedAutomationComments(comments) {
  return comments.filter((comment) => comment.user?.id === AUTOMATION_USER_ID);
}

function commentsAfterLatestMarker(comments, name) {
  const trusted = trustedAutomationComments(comments);
  const marker = `<!-- agent-pipeline ${name}=`;
  const index = trusted.findLastIndex((comment) => String(comment.body ?? "").includes(marker));
  return index < 0 ? trusted : trusted.slice(index + 1);
}

export function closingIssueNumbers(body) {
  const matches = [...String(body ?? "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi)];
  return [...new Set(matches.map((match) => Number(match[1])))];
}

// A merged candidate is deployed as soon as any successful production release
// contains its merge commit, even if that release was triggered by a later
// merge. Exact-SHA matching stranded features at agent:approved forever.
export async function firstDeployedRelease(github, owner, repo, releaseRuns, mergeSha) {
  const successes = releaseRuns
    .filter((run) => run.status === "completed" && run.conclusion === "success")
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at));
  for (const run of successes) {
    if (run.head_sha === mergeSha) return run;
    try {
      const comparison = await github.rest.repos.compareCommitsWithBasehead({
        owner, repo, basehead: `${mergeSha}...${run.head_sha}`,
      });
      if (["identical", "ahead"].includes(comparison.data.status)) return run;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }
  return null;
}

// Durable state has exactly one owner: the newest Agent Task run that claimed
// the issue. Overlapping runs otherwise clobber each other - an old run's
// publish step writing agent:failed after a newer run's prepare already queued
// it, leaving a live implementation labelled failed. Every state write from a
// run therefore proves it is still the current owner first.
export function latestTaskRun(comments) {
  const runs = markerNumbers(trustedAutomationComments(comments), "task-run");
  return runs.length > 0 ? runs.at(-1) : null;
}

export async function writeIssueStateIfCurrent({ github, context }, issueNumber, state, ownerRunId) {
  const { owner, repo } = context.repo;
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: issueNumber, per_page: 100,
  });
  const current = latestTaskRun(comments);
  if (current !== null && ownerRunId !== undefined && Number(current) !== Number(ownerRunId)) {
    return false;
  }
  const issue = (await github.rest.issues.get({ owner, repo, issue_number: issueNumber })).data;
  const labels = [...labelNames(issue)].filter((label) => !STATE_LABELS.includes(label));
  await github.rest.issues.setLabels({
    owner, repo, issue_number: issueNumber, labels: [...labels, state],
  });
  return true;
}

export const TASK_RETRY_LIMIT = 5;

export function classifyTaskResult({ issue, marker, patchLength, exitStatus }) {
  const failed = { type: "failed", numbers: [] };
  if (exitStatus !== 0) return failed;

  let match;
  if ((match = marker.match(/^PIPELINE_TASK_READY:(\d+)$/))
      && Number(match[1]) === issue && patchLength > 0) {
    return { type: "ready", numbers: [issue] };
  }
  if ((match = marker.match(/^PIPELINE_TASK_GROUPED:(\d+)$/))
      && Number(match[1]) !== issue && patchLength === 0) {
    return { type: "grouped", numbers: [Number(match[1])] };
  }
  if ((match = marker.match(/^PIPELINE_TASK_BLOCKED:(\d+(?:,\d+)*)$/)) && patchLength === 0) {
    const [blockedIssue, ...blockers] = match[1].split(",").map(Number);
    if (blockedIssue === issue && blockers.length > 0
        && !blockers.includes(issue) && new Set(blockers).size === blockers.length) {
      return { type: "blocked", numbers: blockers };
    }
  }
  if ((match = marker.match(/^PIPELINE_TASK_DUPLICATE:(\d+)$/))
      && Number(match[1]) !== issue && patchLength === 0) {
    return { type: "duplicate", numbers: [Number(match[1])] };
  }
  if ((match = marker.match(/^PIPELINE_TASK_QUESTION:(\d+)$/)) && Number(match[1]) === issue) {
    return { type: "question", numbers: [issue] };
  }
  return failed;
}

// An agent:question issue resumes when James replies after the latest posted
// question. Automation comments never count as an answer.
export function questionAnswered(comments, trustedUserId = 38769771) {
  const lastQuestion = comments.findLast(
    (comment) => String(comment.body ?? "").includes("<!-- agent-pipeline question="),
  );
  if (!lastQuestion) return false;
  return comments.some(
    (comment) => comment.user?.id === trustedUserId
      && Date.parse(comment.created_at) > Date.parse(lastQuestion.created_at),
  );
}

export function attemptDigests(comments) {
  return comments.flatMap(({ body }) => [...String(body ?? "")
    .matchAll(/<!-- agent-pipeline attempt-digest=([0-9a-f]{64}) -->/g)]
    .map((match) => match[1]));
}

export function verificationFailureSignature(summary) {
  const identities = [...new Set(String(summary ?? "").split(/\r?\n/)
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean))]
    .sort();
  if (identities.length === 0) return null;
  return createHash("sha256").update(identities.join("\n")).digest("hex");
}

export function verificationSignatures(comments) {
  return comments.flatMap(({ body }) => [...String(body ?? "")
    .matchAll(/<!-- agent-pipeline verification-signature=([0-9a-f]{64}) -->/g)]
    .map((match) => match[1]));
}

export function infrastructureFailures(comments) {
  return comments.flatMap(({ body }) => [...String(body ?? "")
    .matchAll(/<!-- agent-pipeline infrastructure-failure=([a-z-]+) -->/g)]
    .map((match) => match[1]));
}

export function markerNumbers(comments, name) {
  return markerGroups(comments, name).flat();
}

export function markerGroups(comments, name) {
  const pattern = new RegExp(`<!-- agent-pipeline ${name}=([0-9]+(?:,[0-9]+)*) -->`, "g");
  return comments.flatMap(({ body }) => [...String(body ?? "").matchAll(pattern)]
    .map((match) => match[1].split(",").map(Number)));
}

function labelNames(item) {
  return new Set((item.labels ?? []).map((label) => typeof label === "string" ? label : label.name));
}

function pipelinePullProvenance(pr, defaultBranch) {
  const branch = pr.head.ref.match(/^opencode\/issue(\d+)-run(\d+)$/);
  const marker = (pr.body ?? "").match(/<!-- agent-pipeline task-run=(\d+) issue=(\d+) base=([0-9a-f]{40}) -->/);
  const linked = closingIssueNumbers(pr.body);
  return pr.user?.id === 41898282
    && pr.base.ref === defaultBranch
    && pr.head.repo?.id === pr.base.repo?.id
    && branch !== null
    && marker !== null
    && linked.length === 1
    && Number(branch[1]) === linked[0]
    && marker[1] === branch[2]
    && marker[2] === branch[1];
}

export function pipelineValidationProvenance(pr) {
  const task = (pr.body ?? "").match(/<!-- agent-pipeline task-run=(\d+) issue=(\d+) base=([0-9a-f]{40}) -->/);
  const validation = (pr.body ?? "").match(
    /<!-- agent-pipeline validation-run=(\d+) attempt=(\d+) artifact=(\d+) digest=([0-9a-f]{64}) tree=([0-9a-f]{40}) -->/,
  );
  if (!task || !validation || task[1] !== validation[1]) return null;
  return {
    runId: Number(validation[1]),
    runAttempt: Number(validation[2]),
    artifactId: Number(validation[3]),
    artifactDigest: validation[4],
    treeSha: validation[5],
  };
}

// A trusted same-repository PR may recover a saved artifact or repair a rejected
// candidate without another model run. It owns the linked issue while open, but
// it is not a pipeline candidate: it never enters autonomous review or the merge
// lane. Limiting this exception to James, the default branch, the same repository,
// and exactly one closing reference prevents an unrelated or forked PR from
// suppressing recovery.
export function trustedManualPullProvenance(pr, defaultBranch, trustedUserId = 38769771) {
  return pr.user?.id === trustedUserId
    && pr.base.ref === defaultBranch
    && pr.head.repo?.id === pr.base.repo?.id
    && closingIssueNumbers(pr.body).length === 1;
}

export async function validExactCheck(github, owner, repo, pr) {
  const recordedBase = (pr.body ?? "").match(
    /<!-- agent-pipeline task-run=\d+ issue=\d+ base=([0-9a-f]{40}) -->/,
  )?.[1];
  if (!recordedBase) return false;
  // The gate publishes a commit status, not a check run: statuses bind purely
  // to the SHA, so the merge box counts them for workflow-token-created PRs
  // that never receive an associated pull_request_target check suite.
  const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
    owner, repo, ref: pr.head.sha, per_page: 100,
  });
  const check = statuses
    .filter((status) => status.context === "Agent Review / Exact SHA")
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))[0];
  const match = check?.description?.match(new RegExp(`^agent-review:${recordedBase}:(\\d+)\\b`));
  if (check?.state !== "success" || check.creator?.id !== 41898282 || !match) return false;
  try {
    const run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: Number(match[1]) })).data;
    if (run.path !== ".github/workflows/agent-review.yml") return false;
    if (["pull_request_target", "pull_request_review"].includes(run.event)) return true;
    if (run.event !== "workflow_dispatch" || run.head_branch !== pr.base.ref) return false;
    const defaultRef = await github.rest.repos.getBranch({ owner, repo, branch: pr.base.ref });
    const [forkToReview, reviewToCurrent] = await Promise.all([
      github.rest.repos.compareCommitsWithBasehead({
        owner, repo, basehead: `${recordedBase}...${run.head_sha}`,
      }),
      github.rest.repos.compareCommitsWithBasehead({
        owner, repo, basehead: `${run.head_sha}...${defaultRef.data.commit.sha}`,
      }),
    ]);
    return [forkToReview.data.status, reviewToCurrent.data.status]
      .every((status) => ["identical", "ahead"].includes(status));
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

// Applies the bounded retry policy to one agent:failed issue, immediately.
// Called by the publish job the moment a failure is recorded, and by
// reconciliation as the sweeper for anything that slipped through. Retries
// resume from the saved patch; stopping parks the issue at agent:error.
export async function recoverFailedIssue({ github, context }, issueNumber) {
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload.repository.default_branch;
  const setState = async (state) => {
    const issue = (await github.rest.issues.get({ owner, repo, issue_number: issueNumber })).data;
    const labels = [...labelNames(issue)].filter((label) => !STATE_LABELS.includes(label));
    await github.rest.issues.setLabels({
      owner, repo, issue_number: issueNumber, labels: [...labels, state],
    });
  };
  const comments = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: issueNumber, per_page: 100,
  });
  const commentOnce = async (marker, body) => {
    if (trustedAutomationComments(comments).some((comment) => comment.body?.includes(marker))) return;
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: `${marker}\n${body}` });
  };

  const recoveryComments = commentsAfterLatestMarker(comments, "recovery-reset");
  const retries = markerNumbers(recoveryComments, "task-retry").length;
  if (retries >= TASK_RETRY_LIMIT) {
    await commentOnce(
      "<!-- agent-pipeline task-exhausted -->",
      `Agent Task recovery used all ${TASK_RETRY_LIMIT} retries. Add a clarifying comment and rerun Agent Task to resume.`,
    );
    await setState("agent:error");
    return "error";
  }
  const digests = attemptDigests(recoveryComments);
  if (digests.length >= 2 && digests.at(-1) === digests.at(-2)) {
    await commentOnce(
      `<!-- agent-pipeline no-progress=${digests.at(-1).slice(0, 12)} -->`,
      "Two consecutive attempts produced an identical patch, so automatic retries stopped. Add a clarifying comment and rerun Agent Task to resume.",
    );
    await setState("agent:error");
    return "error";
  }
  const verification = verificationSignatures(recoveryComments);
  if (verification.length >= 2 && verification.at(-1) === verification.at(-2)) {
    await commentOnce(
      `<!-- agent-pipeline repeated-verification=${verification.at(-1).slice(0, 12)} -->`,
      "Two consecutive repairs produced the same hosted verification failures, so automatic retries stopped.",
    );
    await setState("agent:error");
    return "error";
  }
  const infrastructure = infrastructureFailures(recoveryComments);
  if (infrastructure.length >= 2 && infrastructure.at(-1) === infrastructure.at(-2)) {
    await commentOnce(
      `<!-- agent-pipeline repeated-infrastructure=${infrastructure.at(-1)} -->`,
      "Two consecutive attempts failed before producing a task artifact, so automatic retries stopped.",
    );
    await setState("agent:error");
    return "error";
  }
  await github.rest.issues.createComment({
    owner, repo, issue_number: issueNumber,
    body: `<!-- agent-pipeline task-retry=${retries + 1} -->\nRetrying the failed Agent Task from current main.`,
  });
  await setState("agent:inbox");
  await github.rest.actions.createWorkflowDispatch({
    owner, repo, workflow_id: "agent-task.yml", ref: defaultBranch,
    inputs: { issue: String(issueNumber) },
  });
  return "retried";
}

export async function reconcileAgentPipeline({ github, context, core }) {
  const { owner, repo } = context.repo;
  const defaultBranch = context.payload.repository.default_branch;

  const removeLabel = async (issueNumber, name) => {
    try {
      await github.rest.issues.removeLabel({ owner, repo, issue_number: issueNumber, name });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  };
  const setState = async (issueNumber, state) => {
    const issue = (await github.rest.issues.get({ owner, repo, issue_number: issueNumber })).data;
    const labels = [...labelNames(issue)].filter((label) => !STATE_LABELS.includes(label));
    await github.rest.issues.setLabels({
      owner, repo, issue_number: issueNumber, labels: [...labels, state],
    });
  };
  const commentsFor = (issueNumber) => github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number: issueNumber, per_page: 100,
  });
  const commentOnce = async (issueNumber, marker, body) => {
    const comments = await commentsFor(issueNumber);
    if (trustedAutomationComments(comments).some((comment) => comment.body?.includes(marker))) return;
    await github.rest.issues.createComment({ owner, repo, issue_number: issueNumber, body: `${marker}\n${body}` });
  };
  const dispatch = (issueNumber) => github.rest.actions.createWorkflowDispatch({
    owner,
    repo,
    workflow_id: "agent-task.yml",
    ref: defaultBranch,
    inputs: { issue: String(issueNumber) },
  });
  const issuesWithLabel = async (label) => (await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, state: "open", labels: label, per_page: 100,
  })).filter((issue) => !issue.pull_request);

  const slots = await github.paginate(github.rest.search.issuesAndPullRequests, {
    q: `repo:${owner}/${repo} is:pr label:agent:merge-slot`, sort: "created", order: "asc", per_page: 100,
  });
  if (slots.length > 1) {
    core.warning(`Found ${slots.length} merge slots; retaining only PR #${slots[0].number}.`);
    for (const extra of slots.slice(1)) await removeLabel(extra.number, "agent:merge-slot");
  }
  if (slots[0]) {
    const pr = (await github.rest.pulls.get({ owner, repo, pull_number: slots[0].number })).data;
    const linkedIssues = closingIssueNumbers(pr.body);
    const issueNumber = linkedIssues.length === 1 ? linkedIssues[0] : undefined;
    if (issueNumber === undefined || !pipelinePullProvenance(pr, defaultBranch)) {
      await removeLabel(pr.number, "agent:merge-slot");
      await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: ["agent:failed"] });
      await commentOnce(
        pr.number,
        `<!-- agent-pipeline invalid-slot=${pr.number} -->`,
        "Merge slot released because the PR does not close exactly one issue.",
      );
    } else if (pr.state === "open") {
      if (!labelNames(pr).has("agent:approved")) {
        await removeLabel(pr.number, "agent:merge-slot");
      } else {
        const exactCheckValid = await validExactCheck(github, owner, repo, pr);
        if (!exactCheckValid) {
          try {
            await github.graphql(`
              mutation($pullRequestId: ID!) {
                disablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId }) {
                  pullRequest { number }
                }
              }
            `, { pullRequestId: pr.node_id });
          } catch (error) {
            core.warning(`Unable to disable auto-merge for stale PR #${pr.number}: ${error.message}`);
          }
          await removeLabel(pr.number, "agent:merge-slot");
          await removeLabel(pr.number, "agent:approved");
          await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: ["agent:failed"] });
          await setState(issueNumber, "agent:failed");
          await commentOnce(
            issueNumber,
            `<!-- agent-pipeline stale-approval=${pr.head.sha} -->`,
            `PR #${pr.number} lost exact-head/provenance approval and was removed from the merge lane.`,
          );
        }
      }
    } else if (!pr.merged_at) {
      await removeLabel(pr.number, "agent:merge-slot");
      await setState(issueNumber, "agent:failed");
      await commentOnce(
        issueNumber,
        `<!-- agent-pipeline slot-closed=${pr.number} -->`,
        `PR #${pr.number} closed without merging; the merge slot was released.`,
      );
    } else {
      const releaseRuns = await github.rest.actions.listWorkflowRuns({
        owner,
        repo,
        workflow_id: "release.yml",
        per_page: 100,
      });
      const runs = releaseRuns.data.workflow_runs
        .filter((run) => run.head_sha === pr.merge_commit_sha)
        .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
      const active = releaseRuns.data.workflow_runs.find((run) => run.status !== "completed");
      const completed = runs.find((run) => run.status === "completed");
      const deployedRun = await firstDeployedRelease(
        github, owner, repo, releaseRuns.data.workflow_runs, pr.merge_commit_sha,
      );
      if (!active && deployedRun) {
        await removeLabel(pr.number, "agent:merge-slot");
        await setState(issueNumber, "agent:deployed");
        await commentOnce(
          issueNumber,
          `<!-- agent-pipeline deployed=${pr.merge_commit_sha} -->`,
          `Production release succeeded for PR #${pr.number} at \`${pr.merge_commit_sha}\`.`,
        );
        await github.rest.issues.update({
          owner, repo, issue_number: issueNumber, state: "closed", state_reason: "completed",
        });
      } else if (!active && completed) {
        await setState(issueNumber, "agent:failed");
        await commentOnce(
          issueNumber,
          `<!-- agent-pipeline release-failed=${completed.id} -->`,
          `Production release failed for PR #${pr.number}. The merge slot remains locked: ${completed.html_url}`,
        );
      } else if (!active && runs.length === 0 && Date.now() - Date.parse(pr.merged_at) > 30 * 60 * 1000) {
        await setState(issueNumber, "agent:failed");
        await commentOnce(
          issueNumber,
          `<!-- agent-pipeline release-missing=${pr.merge_commit_sha} -->`,
          `No Release run appeared for merged PR #${pr.number}; the merge slot remains locked.`,
        );
      }
    }
  }

  for (const issue of await issuesWithLabel("agent:grouped")) {
    const comments = await commentsFor(issue.number);
    const canonical = markerNumbers(trustedAutomationComments(comments), "canonical-issue");
    if (canonical.length !== 1) {
      await setState(issue.number, "agent:failed");
      await commentOnce(
        issue.number,
        "<!-- agent-pipeline invalid-group-marker -->",
        "Grouped work must contain exactly one canonical-issue marker.",
      );
      continue;
    }
    const canonicalIssue = (await github.rest.issues.get({ owner, repo, issue_number: canonical[0] })).data;
    if (!labelNames(canonicalIssue).has("agent:deployed")) continue;
    await setState(issue.number, "agent:inbox");
    await commentOnce(
      issue.number,
      `<!-- agent-pipeline group-released=${canonical[0]} -->`,
      `Canonical issue #${canonical[0]} deployed; this bounded follow-up is released.`,
    );
    await dispatch(issue.number);
  }

  for (const issue of await issuesWithLabel("agent:blocked")) {
    const comments = await commentsFor(issue.number);
    const blockerGroups = markerGroups(trustedAutomationComments(comments), "blocked-by");
    const blockers = blockerGroups.at(-1) ?? [];
    if (blockers.length === 0 || new Set(blockers).size !== blockers.length) {
      await setState(issue.number, "agent:failed");
      await commentOnce(
        issue.number,
        "<!-- agent-pipeline invalid-blocker-marker -->",
        "Blocked work must contain one marker listing unique blocker issue numbers.",
      );
      continue;
    }
    const blockerIssues = await Promise.all(blockers.map((number) => github.rest.issues.get({
      owner, repo, issue_number: number,
    })));
    const ready = blockerIssues.every(({ data }) => {
      const labels = labelNames(data);
      const pipelineIssue = [...labels].some((label) => label.startsWith("agent:"));
      return pipelineIssue ? labels.has("agent:deployed") : data.state === "closed";
    });
    if (!ready) continue;
    await setState(issue.number, "agent:inbox");
    await commentOnce(
      issue.number,
      `<!-- agent-pipeline blockers-cleared=${blockers.join(",")} -->`,
      `All blockers (${blockers.map((number) => `#${number}`).join(", ")}) are deployed or closed; work is released.`,
    );
    await dispatch(issue.number);
  }

  const openPulls = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: "open", per_page: 100,
  });
  const pipelineOpenPulls = openPulls.filter((pr) => pipelinePullProvenance(pr, defaultBranch));
  const issuesWithOpenPipelinePulls = new Set(pipelineOpenPulls.flatMap((pr) => closingIssueNumbers(pr.body)));
  const issuesWithOpenPulls = new Set(openPulls
    .filter((pr) => pipelinePullProvenance(pr, defaultBranch)
      || trustedManualPullProvenance(pr, defaultBranch))
    .flatMap((pr) => closingIssueNumbers(pr.body)));
  for (const pr of pipelineOpenPulls) {
    const [issueNumber] = closingIssueNumbers(pr.body);
    const issue = (await github.rest.issues.get({ owner, repo, issue_number: issueNumber })).data;
    if (!labelNames(issue).has("agent:review")) continue;

    const reviewStatuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
      owner, repo, ref: pr.head.sha, per_page: 100,
    });
    const reviewRuns = await github.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: "agent-review.yml", event: "workflow_dispatch", branch: defaultBranch, per_page: 100,
    });
    const reviewTitle = `Agent Review PR #${pr.number}`;
    const activeReview = reviewRuns.data.workflow_runs.some((run) => run.display_title === reviewTitle
      && run.head_branch === defaultBranch && run.head_sha === pr.base.sha && run.status !== "completed");
    const decidedReview = reviewStatuses.some((status) => status.context === "Agent Review / Exact SHA"
      && status.state === "success");
    const needsReview = !activeReview && !decidedReview;
    if (!needsReview) continue;

    const comments = await commentsFor(issueNumber);
    // A gate that is still waiting for the single model runner has not failed.
    // Counting sweeps as attempts while reviews queue behind implementations
    // parked healthy PRs at agent:error, so wait patiently while any dispatched
    // gate run is queued or in progress.
    const pendingRuns = await github.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: "agent-review.yml", per_page: 50,
    });
    const pendingGate = pendingRuns.data.workflow_runs.some(
      (run) => ["queued", "in_progress", "waiting", "pending", "requested"].includes(run.status),
    );
    if (pendingGate) continue;

    const recoveryPrefix = `<!-- agent-pipeline gate-recovery=${pr.number}-${pr.head.sha}-`;
    const attempts = comments.filter((comment) => comment.user?.id === 41898282
      && comment.body?.includes(recoveryPrefix)).length;
    if (attempts >= 3) {
      await setState(issueNumber, "agent:error");
      await commentOnce(
        issueNumber,
        `<!-- agent-pipeline gate-recovery-exhausted=${pr.number}-${pr.head.sha} -->`,
        `Gate-dispatch recovery exhausted three attempts for PR #${pr.number} at \`${pr.head.sha}\`.`,
      );
      continue;
    }
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body: `${recoveryPrefix}${attempts + 1} -->\nRecovery attempt ${attempts + 1} is dispatching missing gates for PR #${pr.number} at \`${pr.head.sha}\`.`,
    });
    if (needsReview) {
      await github.rest.actions.createWorkflowDispatch({
        owner, repo, workflow_id: "agent-review.yml", ref: defaultBranch,
        inputs: { pr: String(pr.number) },
      });
    }
  }
  const closedPulls = await github.paginate(github.rest.pulls.list, {
    owner, repo, state: "closed", sort: "updated", direction: "desc", per_page: 100,
  });
  let releaseRuns;
  for (const pr of closedPulls.filter((candidate) => candidate.merged_at
    && trustedManualPullProvenance(candidate, defaultBranch))) {
    const [issueNumber] = closingIssueNumbers(pr.body);
    const issue = (await github.rest.issues.get({ owner, repo, issue_number: issueNumber })).data;
    if (labelNames(issue).has("agent:deployed")) continue;
    const comments = await commentsFor(issueNumber);
    if (!STATE_LABELS.some((label) => labelNames(issue).has(label)) && latestTaskRun(comments) === null) continue;
    releaseRuns ??= (await github.rest.actions.listWorkflowRuns({
      owner, repo, workflow_id: "release.yml", per_page: 100,
    })).data.workflow_runs;
    const deployedRun = await firstDeployedRelease(github, owner, repo, releaseRuns, pr.merge_commit_sha);
    if (!deployedRun) continue;
    await setState(issueNumber, "agent:deployed");
    await commentOnce(
      issueNumber,
      `<!-- agent-pipeline manual-deployed=${pr.merge_commit_sha} -->`,
      `Trusted manual recovery PR #${pr.number} was released to production by run ${deployedRun.id}.`,
    );
  }
  for (const state of ["agent:review", "agent:approved"]) {
    for (const issue of await issuesWithLabel(state)) {
      if (issuesWithOpenPulls.has(issue.number)) continue;
      const latest = closedPulls.find((pr) => closingIssueNumbers(pr.body).includes(issue.number));
      if (latest?.merged_at) {
        const releaseRuns = await github.rest.actions.listWorkflowRuns({
          owner, repo, workflow_id: "release.yml", per_page: 100,
        });
        // Settle by ancestry, not by an exact SHA match. When another merge
        // lands moments later, this PR's own release aborts on the freshness
        // guard and the *next* release carries its commit to production. The
        // feature is deployed either way, so the state must follow the code.
        const deployedRun = await firstDeployedRelease(
          github, owner, repo, releaseRuns.data.workflow_runs, latest.merge_commit_sha,
        );
        const runs = releaseRuns.data.workflow_runs
          .filter((run) => run.head_sha === latest.merge_commit_sha)
          .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at));
        if (!deployedRun && runs.some((run) => run.status !== "completed")) continue;
        const completed = runs.find((run) => run.status === "completed");
        if (deployedRun) {
          await setState(issue.number, "agent:deployed");
          await commentOnce(
            issue.number,
            `<!-- agent-pipeline deployed=${latest.merge_commit_sha} -->`,
            `Released to production by run ${deployedRun.id} (${deployedRun.head_sha.slice(0, 12)}), which carries PR #${latest.number}.`,
          );
          try {
            await github.rest.issues.update({
              owner, repo, issue_number: issue.number, state: "closed", state_reason: "completed",
            });
          } catch (error) {
            if (error.status !== 404) throw error;
          }
        } else if (completed || Date.now() - Date.parse(latest.merged_at) > 30 * 60 * 1000) {
          await setState(issue.number, "agent:failed");
          await commentOnce(
            issue.number,
            `<!-- agent-pipeline orphan-merge=${latest.number} -->`,
            `PR #${latest.number} merged outside the durable merge slot and its exact release did not succeed.`,
          );
        }
        continue;
      }
      const comments = await commentsFor(issue.number);
    const retries = markerNumbers(commentsAfterLatestMarker(comments, "recovery-reset"), "orphan-retry").length;
      if (retries >= 3) {
        await setState(issue.number, "agent:error");
        await commentOnce(
          issue.number,
          "<!-- agent-pipeline orphan-exhausted -->",
          "Recovery exhausted three retries after candidate PRs closed without merging.",
        );
        continue;
      }
      await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: `<!-- agent-pipeline orphan-retry=${retries + 1} -->\nNo open candidate PR remains; retrying from current main.`,
      });
      await setState(issue.number, "agent:inbox");
      await dispatch(issue.number);
    }
  }

  // The queued -> running flip lives here rather than in a per-run watcher
  // job: a hosted watcher cannot outlive a deep runner queue, and this sweep
  // now runs on every completed pipeline run as well as the cron backstop.
  for (const issue of await issuesWithLabel("agent:queued")) {
    const comments = await commentsFor(issue.number);
    const taskRuns = markerNumbers(trustedAutomationComments(comments), "task-run");
    if (taskRuns.length === 0) continue;
    try {
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
        owner, repo, run_id: taskRuns.at(-1), per_page: 100,
      });
      const implement = jobs.find((job) => job.name === "implement");
      if (implement?.status === "in_progress") await setState(issue.number, "agent:running");
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  // Surface review work the same way implementation work is surfaced: while the
  // single runner executes an independent review, the board otherwise looks
  // idle even though the pipeline is busy.
  const reviewRuns = await github.rest.actions.listWorkflowRuns({
    owner, repo, workflow_id: "agent-review.yml", per_page: 30,
  });
  const reviewActive = reviewRuns.data.workflow_runs.some(
    (run) => run.status === "in_progress" || run.status === "queued",
  );
  for (const issue of await issuesWithLabel("agent:review")) {
    if (!issuesWithOpenPipelinePulls.has(issue.number)) continue;
    if (reviewActive) await setState(issue.number, "agent:reviewing");
  }
  if (!reviewActive) {
    for (const issue of await issuesWithLabel("agent:reviewing")) {
      await setState(issue.number, "agent:review");
    }
  }

  for (const issue of await issuesWithLabel("agent:question")) {
    if (issuesWithOpenPulls.has(issue.number)) continue;
    const comments = await commentsFor(issue.number);
    if (!questionAnswered(comments)) continue;
    await setState(issue.number, "agent:inbox");
    await dispatch(issue.number);
  }

  for (const issue of [...await issuesWithLabel("agent:queued"), ...await issuesWithLabel("agent:running")]) {
    if (Date.now() - Date.parse(issue.updated_at) <= 90 * 60 * 1000 || issuesWithOpenPulls.has(issue.number)) continue;
    const comments = await commentsFor(issue.number);
    const taskRuns = markerNumbers(trustedAutomationComments(comments), "task-run");
    if (taskRuns.length > 0) {
      try {
        const run = (await github.rest.actions.getWorkflowRun({ owner, repo, run_id: taskRuns.at(-1) })).data;
        if (run.status !== "completed") continue;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    const retries = markerNumbers(commentsAfterLatestMarker(comments, "recovery-reset"), "stale-retry").length;
    if (retries >= 3) {
      await setState(issue.number, "agent:error");
      await commentOnce(
        issue.number,
        "<!-- agent-pipeline stale-exhausted -->",
        "Stale implementation recovery exhausted three retries.",
      );
      continue;
    }
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: issue.number,
      body: `<!-- agent-pipeline stale-retry=${retries + 1} -->\nNo active Agent Task run or open PR remains; retrying from current main.`,
    });
    await setState(issue.number, "agent:inbox");
    await dispatch(issue.number);
  }

  for (const issue of await issuesWithLabel("agent:failed")) {
    if (issuesWithOpenPulls.has(issue.number)) continue;
    const comments = await commentsFor(issue.number);
    const latestFailure = comments.findLast((comment) => comment.body?.includes("<!-- agent-pipeline run-failed="));
    const latestTerminal = comments.findLast((comment) => /<!-- agent-pipeline (?:run-failed|review-exhausted)=/.test(comment.body ?? ""));
    if (!latestFailure || latestFailure.id !== latestTerminal?.id) continue;
    await recoverFailedIssue({ github, context }, issue.number);
  }
}

export async function queueNextApproved({ github, context, core }) {
  const { owner, repo } = context.repo;
  const slot = await github.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:pr label:agent:merge-slot`, per_page: 1,
  });
  const releases = await github.rest.actions.listWorkflowRuns({
    owner, repo, workflow_id: "release.yml", per_page: 20,
  });
  const releaseActive = releases.data.workflow_runs.some(({ status }) => status !== "completed");
  if (slot.data.total_count > 0 || releaseActive) {
    core.info(`Merge lane busy: slot=${slot.data.total_count}, activeRelease=${releaseActive}.`);
    return;
  }

  const approved = await github.rest.search.issuesAndPullRequests({
    q: `repo:${owner}/${repo} is:pr is:open label:agent:approved`,
    sort: "created",
    order: "asc",
    per_page: 1,
  });
  const candidate = approved.data.items[0];
  if (!candidate) {
    core.info("No approved PR is waiting for the merge lane.");
    return;
  }
  const pr = (await github.rest.pulls.get({ owner, repo, pull_number: candidate.number })).data;
  const defaultBranch = context.payload.repository.default_branch;
  const exactCheckValid = await validExactCheck(github, owner, repo, pr);
  const provenanceValid = pipelinePullProvenance(pr, defaultBranch);
  const validation = pipelineValidationProvenance(pr);
  if (!provenanceValid || !validation || !exactCheckValid) {
    try {
      await github.rest.issues.removeLabel({
        owner, repo, issue_number: pr.number, name: "agent:approved",
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: ["agent:failed"] });
    const linked = closingIssueNumbers(pr.body);
    if (linked.length === 1) {
      const issue = (await github.rest.issues.get({ owner, repo, issue_number: linked[0] })).data;
      const labels = [...labelNames(issue)].filter((label) => !STATE_LABELS.includes(label));
      await github.rest.issues.setLabels({
        owner, repo, issue_number: linked[0], labels: [...labels, "agent:failed"],
      });
    }
    core.warning(`PR #${pr.number} lost exact-head/provenance approval and was not queued.`);
    return;
  }
  await github.rest.issues.addLabels({ owner, repo, issue_number: pr.number, labels: ["agent:merge-slot"] });
  let merged = false;
  try {
    // The workflow token may not arm native auto-merge (FORBIDDEN), and both
    // required contexts are already green statuses by the time a PR is
    // admitted here, so merge directly at the exact reviewed head. Branch
    // protection still applies: an unsatisfied requirement fails the merge and
    // releases the slot for the next reconciliation pass.
    const result = await github.rest.pulls.merge({
      owner, repo, pull_number: pr.number,
      merge_method: "merge",
      sha: pr.head.sha,
    });
    if (!result.data.merged) throw new Error(`GitHub did not merge PR #${pr.number}: ${result.data.message}`);
    merged = true;
    const mergeCommit = await github.rest.git.getCommit({ owner, repo, commit_sha: result.data.sha });
    const promotionInputs = mergeCommit.data.tree.sha === validation.treeSha ? {
      validation_run: String(validation.runId),
      validation_attempt: String(validation.runAttempt),
      validation_artifact: String(validation.artifactId),
      validation_digest: validation.artifactDigest,
      validation_tree: validation.treeSha,
    } : {};
    // GITHUB_TOKEN-authored merges intentionally do not trigger push workflows.
    // Dispatch the release explicitly while the merge slot remains locked.
    await github.rest.actions.createWorkflowDispatch({
      owner, repo, workflow_id: "release.yml", ref: defaultBranch,
      inputs: promotionInputs,
    });
  } catch (error) {
    if (!merged) {
      try {
        await github.rest.issues.removeLabel({
          owner, repo, issue_number: pr.number, name: "agent:merge-slot",
        });
      } catch (removeError) {
        if (removeError.status !== 404) throw removeError;
      }
    }
    throw error;
  }
}
