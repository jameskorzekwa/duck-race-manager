# GitHub Agent Pipeline

## Purpose

QuickDucks uses OpenCode agents to triage trusted feature and fix requests,
implement independent work in parallel, test and review changes, admit one PR at
a time to the release lane, and reconcile interrupted work. GitHub, not an
agent process, is the durable source of truth.

This document is both the QuickDucks runbook and the reference installation
guide for adding the same framework to another repository.

## Architecture

```text
OpenCode or GitHub issue
        |
        v
Agent Task: triage -> grouped, blocked, duplicate, or implementation
        |
        v
OpenChamber + paid local models -> allowlisted specialists -> integrated patch
        |
        v
Pull request -> CI Validate + trusted candidate validation + read-only Agent Review
        |
        v
agent:approved -> one agent:merge-slot -> GitHub auto-merge
        |
        v
Release validation -> production approval -> deployment and smoke tests
        |
        v
deterministic Agent Reconcile -> agent:deployed or agent:failed -> next slot
```

OpenChamber is the local model control plane and the local/mobile observability
surface. The self-hosted runner submits implementation and review prompts to the
desktop-managed OpenCode server, so active and historical model sessions appear
in OpenChamber while GitHub retains the durable workflow state.

## Durable State

Pipeline state is represented by labels:

| Label | Meaning |
| --- | --- |
| `agent:inbox` | Accepted and waiting for triage |
| `agent:triage` | Classification is active |
| `agent:ready` | Independently releasable work is ready |
| `agent:queued` | Accepted for implementation, waiting for the single model runner |
| `agent:running` | The model runner has started this implementation or repair |
| `agent:grouped` | Requirements belong to a canonical active issue |
| `agent:blocked` | Explicit dependencies or input are outstanding |
| `agent:question` | Implementation is blocked on a question posted to the issue; any James reply resumes it automatically from the saved partial work |
| `agent:reviewing` | The single model runner is executing this candidate's independent review |
| `agent:review` | A PR is under deterministic CI or agent review |
| `agent:approved` | Independent review passed at the current head |
| `agent:merge-slot` | The single PR/release allowed in production lane |
| `agent:deployed` | Production release and smoke verification succeeded |
| `agent:error` | Automatic recovery stopped (retry budget, no progress, or review retries spent); a clarifying comment plus a rerun resumes it |
| `agent:failed` | Bounded recovery or human intervention is required |

Grouped issues also receive one marker:

```html
<!-- agent-pipeline canonical-issue=123 -->
```

Blocked issues similarly use one `<!-- agent-pipeline blocked-by=12,34 -->`
marker. These markers let reconciliation resume without depending on model memory.

## Trusted Intake

Use the `Agent feature or fix` issue form or create an issue with
`agent:inbox`. The repository runs issues automatically only when both the event
actor and issue author match James's immutable GitHub user ID. James can retry or
refine an issue with a comment beginning `/agent` or `/oc`. Before model execution,
the workflow excludes comments from untrusted accounts from the immutable snapshot.

The global OpenCode `orchestrator` agent is the preferred conversational intake
path. It converts a request into an issue with explicit acceptance criteria and
then returns immediately. New requests remain accepted while the local model
worker is busy.

Public issue and PR text is untrusted. Never broaden the actor condition. Agent
Review uses `pull_request_target` only for a trusted base-branch control plane:
candidate execution and model review have read-only repository authority, while
the later write-capable gate never checks out or executes candidate code.

## Execution And Review

`agent-task.yml` runs one OpenCode turn per issue at a time. Deterministic hosted
intake first records the run and builds an immutable actor-filtered snapshot. A
repository-scoped self-hosted runner then asks the local OpenChamber server to
create a visible session in a per-run plain-file snapshot of the trusted base.
The snapshot has no Git metadata and carries the immutable issue context in a
read-only `.pipeline` directory. The OpenChamber process, not the Actions job,
owns model authentication. The OpenAI implementation lead
may launch only the explicitly allowlisted, read-only scout, test reviewer, and
risk reviewer through OpenCode's built-in task tool. All local pipeline agents
deny shell, PTY, network, OpenChamber-control, MCP resources, Git metadata,
OpenCode tool-output storage, environment files, and unspecified tools by
default. Content grep and filename glob are disabled because current OpenCode
releases cannot reliably scope their target paths; the path-checked read tool
supports both repository directory listing and file reads.
Project configuration also disables LSP and formatter subprocesses.
Candidate code executes only in the hosted verification job.

The implementation lead and test/risk roles use James's local ChatGPT/Codex
OAuth with `openai/gpt-5.6-sol`. Scouting and independent semantic review use
Anthropic Pro/Max OAuth through the locally installed and pinned
`opencode-anthropic-oauth@0.4.7` plugin, routed to Sonnet 5 and Opus 4.8. OAuth
files, access tokens, and refresh tokens never enter the
runner environment, GitHub secrets, artifacts, logs, or repository.

The model emits a patch artifact. A second job executes and validates that patch
without write authority. Only after verification does a model-free publisher
apply the same digest-bound patch without executing it and use its short-lived,
repository-scoped `GITHUB_TOKEN` to create the branch and PR. Because workflow
token writes do not recursively trigger most workflows, the publisher explicitly
dispatches CI on the candidate branch and Agent Review from the trusted default
branch. No external token exchange or long-lived credential is involved.

Patch extraction occurs in a fresh trusted Git repository, never in the model's
workspace. Known ignored OpenCode runtime dependencies under `.opencode` are
removed first. Before the first post-model Git command, a trusted `lstat` walk rejects
case-folded Git metadata, symlinks, hardlinks, and non-regular files. A
case-insensitive deterministic policy then rejects gitlinks, agent
instructions, OpenCode configuration, local actions, workflows, and pipeline
state helpers before artifact upload, after hosted patch application, and before
publication. Pipeline control-plane changes therefore use the normal manual PR
path and cannot make an autonomous branch run code on the OAuth-bearing runner.

`agent-review.yml` is loaded from the trusted default branch and clears stale
approval whenever the PR head changes. One hosted read-only-token job runs the
exact candidate's release gate. A separate self-hosted job submits a read-only
OpenChamber review session from a plain trusted-base snapshot. It receives only
the candidate patch and trusted issue context as read-only data, not a candidate
filesystem, and cannot execute candidate code or follow candidate symlinks. Its SHA-bound
decision is uploaded as an artifact. A deterministic write-capable hosted job
rechecks the live head before adding
`agent:approved`. On rejection it closes the candidate and dispatches a fresh
implementation from current `main`, at most three times.

The gate also publishes `Agent Review / Exact SHA` directly on the candidate
commit. That check is fully autonomous: it passes on deterministic validation of
the exact candidate SHA plus an approving independent model review, and no
human PR approval is required to run or satisfy either required check. Candidate
CI is dispatched explicitly on the branch, so repository policy must not demand
manual approval to run workflows for pipeline-authored pull requests.

Autonomy stops at production. Merges are still serialized through the single
merge slot, and deployment still requires James's approval in the protected
production environment with no administrator bypass, so no autonomous change
reaches users unreviewed. Autonomous patches also still cannot touch workflows,
local actions, agent instructions, `opencode.json`, `AGENTS.md`, or pipeline
helpers; `validate-agent-patch.mjs` rejects those outright rather than routing
them to a human approval.

Any review-dismissal event runs a separate non-concurrent hosted workflow that
removes approval state, the merge slot, and auto-merge without launching a paid
model session. Because the merge decision no longer depends on a human review,
that revocation is a convenience control: close the PR or disable auto-merge
directly when an immediate stop is required.

## Merge And Deployment

The merge decision is deterministic. A serialized job checks all of these:

1. The PR is still open and carries current-head `agent:approved`.
2. No PR in any state carries `agent:merge-slot`.
3. No Release workflow run is queued, in progress, or waiting for approval.
4. GitHub branch protection still requires `CI / Validate` and candidate-head
   `Agent Review / Exact SHA`.

It then adds `agent:merge-slot` and enables merge-commit auto-merge. GitHub waits
for required checks. The slot remains through production approval, deployment,
smoke tests, tag creation, and release publication.

The production environment requires James's approval and has no administrator
bypass. The deploy job refetches `main` after approval and fails if its validated
SHA is stale.

## Recovery

`agent-reconcile.yml` runs twice per hour and on demand. It is deterministic and
does not call a model. It:

- Settles successful or failed releases for the merge-slot PR.
- Dispatches grouped requirements only after the canonical issue is deployed.
- Releases issues whose blockers are closed.
- Retries stale work with bounded machine-readable attempts.
- Repairs labels when PR, workflow, and deployment state proves the transition.
- Advances the oldest approved PR after the production lane is free.

An interrupted model turn is restarted from issue, branch, PR, and check state;
it is never resumed as if a provider call were exactly-once.

When hosted verification rejects a patch, the unprivileged gate captures its own
output, and the model-free publisher posts a bounded, credential-redacted
excerpt under a `verification-failed` marker. The next attempt receives it as
`untrustedVerificationEvidence`, so a retry repairs the named failure instead of
reimplementing blind. The excerpt is data, never instructions: pipeline markers
inside it are neutralized before it is posted, so candidate output cannot forge
durable state.

The runner records each active model directory outside the Actions workspace.
Every later model job checks that record and fails closed while any prior
OpenChamber parent or child session remains busy. Workspaces are unique per run
and are deleted only after all matching sessions report `idle`, so a timed-out
turn cannot race a later checkout or contaminate another patch.

## Install In Another Repository

### 1. Establish deterministic gates

Create or identify CI with a stable required-check name. It must run repository
tests, lint/type checks, builds, migration validation, and security checks
appropriate to that project. Deployment must be downstream of successful
validation.

### 2. Copy the framework files

Copy and review:

```text
opencode.json
.opencode/agents/pipeline-*.md
.opencode/skills/github-agent-pipeline/SKILL.md
.github/ISSUE_TEMPLATE/agent-task.yml
.github/workflows/agent-task.yml
.github/workflows/agent-review.yml
.github/workflows/agent-review-revoke.yml
.github/workflows/agent-reconcile.yml
scripts/agent-pipeline.mjs
scripts/cleanup-model-workspace.mjs
scripts/summarize-verification-failure.mjs
scripts/validate-agent-patch.mjs
scripts/wait-for-openchamber-session.mjs
```

Do not copy QuickDucks-specific prompts unchanged. Replace domain invariants,
test commands, risk areas, timeout budgets, trusted actor, concurrency prefixes,
model choices, and release workflow name.

### 3. Configure the local model worker

Pin a tested OpenCode/OpenChamber pairing and every local authentication plugin
version in the model machine's OpenCode package lock. Install a repository-scoped
self-hosted Actions runner on that machine. Give the runner a unique label and
target only model jobs with it. A single runner serializes top-level OAuth
sessions; the implementation lead may parallelize only the allowlisted read-only
specialists through OpenCode's built-in task tool.

Do not expose the sensitive runner to autonomous workflow changes. Preserve the
plain snapshot, protected-path policy, symlink/gitlink rejection, persistent
active-session record, and fail-closed idle checks. If the runner platform offers
workflow-ref restrictions, restrict it to the trusted default-branch task and
review workflows as an additional defense.

Authenticate paid providers only in the local OpenCode/OpenChamber runtime. Do
not copy `auth.json`, `OPENCODE_AUTH_CONTENT`, access tokens, or refresh tokens to
GitHub. Verify the local OpenChamber model list before enabling intake. The
self-hosted job should dispatch with `openchamber session create` and then poll
authoritative directory-scoped session status with a bounded trusted helper.
Require every session in the unique per-run directory to be idle and the parent
session to end on a completed terminal marker before handling model output.

Treat the dispatch call's own exit status as advisory. A long `--wait` request
can be ended by an intermediary while the session keeps running, and the CLI
aborts non-blocking control calls after a fixed short HTTP timeout even though
the server still creates the session and runs the model. Because the model
directory is unique per run, the parent session inside it is the authoritative
dispatch record; discover it by polling instead of trusting the response.

The job must not load provider credentials into the Actions process.

Grant `contents: write`, `pull-requests: write`, and `actions: write` only to a
deterministic publisher that never executes candidate code or invokes a model.
Use its short-lived repository-scoped `GITHUB_TOKEN` to publish, then explicitly
dispatch candidate CI and the trusted default-branch review workflow. Enable the
repository's bundled "Allow GitHub Actions to create and approve pull requests"
setting, but do not implement automated review approval. Never upload a local
OpenCode `auth.json`, OAuth refresh token, or long-lived PAT to Actions.

### 4. Create labels

Create every label from the Durable State table with clear descriptions. The
issue form references `agent:inbox`, so create labels before enabling the form.

### 5. Configure repository policy

- Enable auto-merge.
- Delete merged branches when appropriate.
- Protect the default branch and require pull requests.
- Require `CI / Validate` and candidate-head `Agent Review / Exact SHA`.
- Permit only the intended merge method.
- Keep workflow token defaults read-only.
- Although GitHub bundles PR creation and review approval in one Actions setting,
  do not implement automated review approval unless the design explicitly needs it.

### 6. Configure deployment

Use a protected GitHub environment for production. Keep deployment credentials
there, require the intended reviewer, disable administrator bypass, restrict
deployment refs, serialize releases, and perform post-deploy verification.

If the repository does not deploy, replace release settlement with a merge-only
terminal state and remove production-lane checks from reconciliation.

### 7. Update project instructions

Document agent boundaries, mandatory tests, migrations, security invariants,
merge policy, deployment order, rollback, and the rule that GitHub state is
authoritative. Add this guide to the repository's main documentation index.

### 8. Validate before enabling intake

1. Validate JSON, YAML, agent frontmatter, and workflow syntax.
2. Run all deterministic tests locally.
3. Push a setup branch and let ordinary CI pass.
4. Verify the self-hosted runner is online, OpenChamber is running, and both paid
   provider model families are visible.
5. Enable workflow-token PR creation and verify native-token publication plus
   explicit candidate CI and trusted review dispatch.
6. Submit one documentation-only canary issue.
7. Confirm local OpenChamber sessions, branch creation, PR CI, independent review,
   merge slot, environment approval, deployment, smoke tests, and final issue state.
8. Test a duplicate, a grouped update, a blocked issue, a failed test, and a
   reconciler retry before increasing concurrency.

## Choosing Models

The paid models are selected by repository Actions variables, so changing them
never requires a commit and takes effect on the next run:

| Variable | Role | Default |
| --- | --- | --- |
| `AGENT_IMPLEMENT_MODEL` | Implementation lead session | `openai/gpt-5.6-sol` |
| `AGENT_IMPLEMENT_VARIANT` | Implementation reasoning variant | `xhigh` |
| `AGENT_REVIEW_MODEL` | Independent review session | `anthropic/claude-opus-4-8` |

Set them in Settings -> Secrets and variables -> Actions -> Variables, or:

```sh
gh variable set AGENT_IMPLEMENT_MODEL --body "anthropic/claude-sonnet-5"
gh variable set AGENT_IMPLEMENT_VARIANT --body "default"
gh variable set AGENT_REVIEW_MODEL --body "openai/gpt-5.6-sol"
gh variable delete AGENT_IMPLEMENT_MODEL   # return to the default
```

Only repository administrators can set variables, the workflows validate the
`provider/model` format before use, and the model must be available in the local
OpenChamber runtime or dispatch fails closed. Keep implementation and review on
different model families so the reviewer does not share the author's blind
spots. The read-only scout, tester, and risk subagent models remain pinned in
`.opencode/agents/pipeline-*.md` and change through a normal pull request.

## OpenChamber Setup

Install a version paired with the configured OpenCode release. OpenChamber
`1.17.0` pins OpenCode SDK `1.18.8`. Connect GitHub under **Settings -> Git** and
keep the desktop-managed runtime available while the self-hosted runner is
online. Automated sessions use the issue or PR number in their title.

When enabling the OpenChamber startup service, snapshot only a minimal,
non-secret environment. Set an explicit `OPENCODE_BINARY` when OpenCode is not
on the service's default `PATH`. Never persist provider tokens in a service
definition.

The QuickDucks model runner is named `james-mac-quickducks-model` and carries the
custom `quickducks-model` label. If the Mac or OpenChamber is unavailable, model
jobs remain queued or fail closed; hosted validation, merge, and deployment jobs
never fall back to weaker models.

## Operational Commands

```sh
gh issue list --label agent:inbox
gh issue list --label agent:failed
gh pr list --label agent:approved
gh pr list --state all --label agent:merge-slot
gh run list --workflow agent-task.yml
gh run list --workflow agent-review.yml
gh run list --workflow agent-reconcile.yml
gh run list --workflow release.yml
gh workflow run agent-reconcile.yml
gh api repos/jameskorzekwa/duck-race-manager/actions/runners
openchamber status
openchamber session list --dir <runner-workspace> --with-status
```

Never use operational commands to bypass required CI, merge-slot serialization,
or production approval.
