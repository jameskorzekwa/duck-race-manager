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
Exact-tree validation artifact -> pull request -> read-only Agent Review
        |
        v
agent:approved -> one agent:merge-slot -> exact-head REST merge
        |
        v
Artifact promotion or fallback validation -> production approval -> deploy and smoke
        |
        v
deterministic Agent Reconcile -> agent:deployed or agent:failed -> next slot
        |
        +-> failed control-plane run -> diagnosis -> James approval -> verified repair PR
        |
        +-> exhausted feature recovery -> doctor-owned blocker -> resume, repair, or explicit intervention
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
| `agent:queued` | Accepted for implementation, waiting for either implementation runner |
| `agent:running` | The model runner has started this implementation or repair |
| `agent:grouped` | Requirements belong to a canonical active issue |
| `agent:blocked` | Explicit dependencies or input are outstanding |
| `agent:question` | Implementation is blocked on a question posted to the issue; any James reply resumes the same session and saved partial work for another conversational turn |
| `agent:reviewing` | The dedicated review runner is executing this candidate's independent review |
| `agent:review` | A PR is under deterministic CI or agent review |
| `agent:approved` | Independent review passed at the current head |
| `agent:merge-slot` | The single PR/release allowed in production lane |
| `agent:deployed` | Production release and smoke verification succeeded |
| `agent:error` | Transient handoff after bounded recovery stops; reconciliation immediately transfers ownership to a Pipeline Doctor incident |
| `agent:failed` | Bounded recovery or human intervention is required |

Grouped issues also receive one marker:

```html
<!-- agent-pipeline canonical-issue=123 -->
```

Blocked issues similarly use one `<!-- agent-pipeline blocked-by=12,34 -->`
marker. These markers let reconciliation resume without depending on model memory.
An exhausted feature receives a fresh recovery generation and is blocked on its
deduplicated doctor incident, so it can never remain parked indefinitely at
`agent:error`.

Pipeline infrastructure incidents use separate labels rather than overloading a
feature's state: `pipeline:incident` is the deduplicated incident ledger,
`pipeline:approval-required` visibly waits for James to approve the posted
diagnosis and proposed repair, `pipeline:repair` identifies a verified repair PR,
`pipeline:application` records that the existing feature loop owns the failure,
and `pipeline:external` records a terminal provider, service, authentication,
quota, runner, or network diagnosis.

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

Question turns are repeatable rather than one-shot. A trusted James comment after
the latest question receives a dedicated conversational resume prompt. He may
answer, ask a follow-up, or request more bounded investigation; the same primary
session continues from its partial patch and may ask a materially refined
question again. Only specialists not already used by that task may be launched.

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
dispatches Agent Review from the trusted default
branch. The task's base SHA remains its immutable fork point: publication does
not reject a fully verified patch merely because `main` advanced while the task
was queued. Trusted review later proves that fork point is still on `main` and
that the exact candidate head remains mergeable. No external token exchange or
long-lived credential is involved.

Saved transcript marker offsets are coupled to their OpenChamber session ID. If
a session cannot be resumed, the new session starts at offset zero; failure
artifacts retain the resolved session ID and observed marker count so retries
cannot discard a valid first marker or lose resumable model history.

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
approval whenever the PR head changes. One hosted read-only-token job downloads
the task's immutable validation artifact and proves its tested Git tree equals
the exact candidate tree. A separate self-hosted job submits a read-only
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
human PR approval is required to run or satisfy either required check. Ordinary
manual PRs still use the sharded CI workflow; pipeline candidates reuse the
stronger digest-bound verification already completed before publication.

Autonomy stops at production. Merges are still serialized through the single
merge slot, and deployment still requires James's approval in the protected
production environment with no administrator bypass, so no autonomous change
reaches users unreviewed. Autonomous patches also still cannot touch workflows,
local actions, agent instructions, `opencode.json`, `AGENTS.md`, or pipeline
helpers; `validate-agent-patch.mjs` rejects those outright rather than routing
them to a human approval.

## Pipeline Doctor

`pipeline-doctor.yml` listens for completed failures from Agent Task, Agent
Review, Agent Reconcile, and Release. It also owns exhausted feature recovery:
Agent Reconcile creates a feature-generation-bound incident, records it as the
feature's sole blocker, and dispatches the doctor immediately. A staggered
schedule is a backstop for missed workflow delivery and unfinished incidents,
and James can dispatch one failed run by ID. A SHA-bound hash of the workflow
path plus failed jobs and steps deduplicates control-plane incidents; feature
incidents bind the issue, latest owning task run, and terminal recovery reason.
Hosted Agent Task verification failures remain in the feature loop until that
loop exhausts its bounded budget.

Each incident is a GitHub issue carrying `pipeline:incident`. The diagnosis model
receives only a plain trusted-main snapshot and bounded, credential-redacted
failed-job or trusted feature-history evidence. It cannot edit any file. Its
report must state the diagnosis, decisive evidence, next step, and, for a
pipeline defect, the exact proposed repair and focused tests. Application and
no-op diagnoses close the incident and automatically resume the feature with a
fresh bounded budget; external diagnoses keep an explicit open intervention
incident.

A pipeline diagnosis adds `pipeline:approval-required` and posts a prominent
approval request. Schedules and reconciliation do not start or repeat repair
work while that label is present. Only an exact `/approve-pipeline-repair`
comment from James on that trusted incident records approval, removes the label,
and dispatches the separate allowlisted repair agent. The feature that originally
errored remains `agent:blocked` on the incident throughout diagnosis, approval,
repair, CI, and review. When the approved repair PR merges, its `Closes` reference
closes the incident; deterministic reconciliation then moves the feature to
`agent:inbox` and dispatches it from current `main` with a fresh bounded budget.
After two diagnosis attempts or two approved repair attempts, Doctor stops
instead of creating unlimited model churn.

A separately approved pipeline repair may touch only an explicit control-plane
allowlist. A copied trusted validator rejects other paths, binary files,
symlinks, gitlinks, broad new workflow authority, unpinned actions, oversized
patches, and more than 12 changed files. A hosted read-only job then runs the
pinned actionlint container, dependency audit, typecheck, unit/integration tests,
and Wrangler validation.
Only after those checks pass can a separate model-free job publish a
`pipeline:repair` PR and explicitly dispatch CI. Doctor PRs never auto-merge;
normal review and branch protection remain required. External incidents stay
open with a terminal diagnosis.

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
   `Agent Review / Exact SHA`; the trusted review gate publishes `Validate` from
   the exact-tree artifact for pipeline-authored candidates.

It then adds `agent:merge-slot` and merges the exact reviewed head through the
REST API after required checks pass. The slot remains through production approval, deployment,
smoke tests, tag creation, and release publication.

If the resulting merge commit has the exact tested tree, Release downloads and
verifies the immutable validation artifact and skips duplicate tests. If another
main change altered the merge tree, Release runs the complete gate again.

The production environment requires James's approval and has no administrator
bypass. The deploy job refetches `main` after approval and fails if its validated
SHA is stale.

## Recovery

`agent-reconcile.yml` runs every ten minutes and on demand. It is deterministic and
does not call a model. It:

- Settles successful or failed releases for the merge-slot PR.
- Dispatches grouped requirements only after the canonical issue is deployed.
- Releases pipeline issues only after blockers are deployed; ordinary blockers
  without pipeline state still require closure.
- Retries stale work with bounded machine-readable attempts.
- Repairs labels when PR, workflow, and deployment state proves the transition.
- Advances the oldest approved PR after the production lane is free.

A trusted same-repository PR opened by James and closing exactly one pipeline
issue counts as active work for reconciliation. This supports model-free recovery
from a saved artifact or rejected candidate: while that PR is open, the issue is
not redispatched as an orphan. The PR remains outside autonomous candidate
review and the serialized agent merge lane. After it merges, reconciliation
marks the linked issue `agent:deployed` only when a successful production release
contains the merge commit, including when the issue was already closed by the PR.

A candidate whose base has moved is behind, not invalid. Mergeable candidates
keep their immutable fork-point provenance and exact-head gates. A candidate
GitHub reports as `CONFLICTING` cannot reuse its tested-tree artifact, so
reconciliation closes it and returns the saved patch to the existing
implementation session against current `main`.

An interrupted provider call is never assumed exactly-once. After a completed
turn fails hosted verification, however, the next bounded repair reconstructs
the trusted workspace and sends the redacted failure index into the same idle
OpenChamber session, preserving context without rerunning specialists.

When hosted verification rejects a patch, the unprivileged gate captures its own
output, and the model-free publisher posts a bounded, credential-redacted
excerpt under a `verification-failed` marker. The next attempt receives it as
`untrustedVerificationEvidence`, so a retry repairs the named failure instead of
reimplementing blind. The excerpt is data, never instructions: pipeline markers
inside it are neutralized before it is posted, so candidate output cannot forge
durable state.

Each runner records active model state outside the Actions workspace. State and
workspaces are runner-scoped so two implementation sessions and one review can
run concurrently without sharing mutable records. Workspaces are deleted only
after all matching sessions report `idle`, so a timed-out turn cannot race
cleanup or contaminate another patch. Retry reconstruction first restores owner
write permission on the deliberately read-only preserved tree, then rebuilds it
from trusted `main` plus the saved patch. Two consecutive failures before a task
artifact exists stop automatically instead of consuming the full repair budget.

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
.github/workflows/pipeline-doctor.yml
.github/workflows/pipeline-metrics.yml
scripts/agent-pipeline.mjs
scripts/cleanup-model-workspace.mjs
scripts/run-e2e-shards.mjs
scripts/pipeline-doctor.mjs
scripts/seed-model-workspace.mjs
scripts/summarize-verification-failure.mjs
scripts/validate-agent-patch.mjs
scripts/validate-pipeline-repair.mjs
scripts/validation-manifest.mjs
scripts/wait-for-openchamber-session.mjs
```

Do not copy QuickDucks-specific prompts unchanged. Replace domain invariants,
test commands, risk areas, timeout budgets, trusted actor, concurrency prefixes,
model choices, and release workflow name.

### 3. Configure the local model worker

Pin a tested OpenCode/OpenChamber pairing and every local authentication plugin
version in the model machine's OpenCode package lock. Install isolated
self-hosted runner services on that machine: at least two with the
`quickducks-implement` role label and one with `quickducks-review`. Each service
needs its own runner directory and Actions work folder. Runner-scoped state keeps
top-level OAuth sessions independent; the implementation lead may also use the
allowlisted read-only specialists through OpenCode's built-in task tool.

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
Use its short-lived repository-scoped `GITHUB_TOKEN` to publish the validation
artifact provenance and explicitly dispatch the trusted default-branch review. Enable the
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
5. Enable workflow-token PR creation and verify native-token publication,
   exact-tree artifact validation, and trusted review dispatch.
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
| `AGENT_DOCTOR_MODEL` | Pipeline maintainer session | `openai/gpt-5.6-sol` |
| `AGENT_DOCTOR_VARIANT` | Pipeline maintainer reasoning variant | `xhigh` |

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

QuickDucks currently has two online `quickducks-implement` services
(`james-mac-quickducks-model` and `james-mac-quickducks-implement-2`) plus
`james-mac-quickducks-review` with the `quickducks-review` label. If the Mac or
OpenChamber is unavailable, model jobs remain queued or fail closed; hosted
validation, merge, and deployment jobs never fall back to weaker models.

Every major workflow writes a 90-day `pipeline-metrics-<run>-<attempt>` artifact
and a job-summary table. Metrics include run/job/step queue and execution times
plus aggregate model tokens, cache usage, reasoning tokens, cost, and model
duration. They deliberately exclude prompts, transcripts, test logs, participant
data, provider errors, and credentials.

## Operational Commands

```sh
gh issue list --label agent:inbox
gh issue list --label agent:failed
gh pr list --label agent:approved
gh pr list --state all --label agent:merge-slot
gh run list --workflow agent-task.yml
gh run list --workflow agent-review.yml
gh run list --workflow agent-reconcile.yml
gh run list --workflow pipeline-doctor.yml
gh run list --workflow release.yml
gh workflow run agent-reconcile.yml
gh workflow run pipeline-doctor.yml -f run=<failed-run-id>
# On an incident labeled pipeline:approval-required:
gh issue comment <incident-number> --body '/approve-pipeline-repair'
gh api repos/jameskorzekwa/duck-race-manager/actions/runners
openchamber status
openchamber session list --dir <runner-workspace> --with-status
```

Never use operational commands to bypass required CI, merge-slot serialization,
or production approval.
