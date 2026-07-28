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
OpenCode + Ensemble -> isolated worktrees -> integrated issue branch
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
| `agent:running` | An implementation or repair run is active |
| `agent:grouped` | Requirements belong to a canonical active issue |
| `agent:blocked` | Explicit dependencies or input are outstanding |
| `agent:review` | A PR is under deterministic CI or agent review |
| `agent:approved` | Independent review passed at the current head |
| `agent:merge-slot` | The single PR/release allowed in production lane |
| `agent:deployed` | Production release and smoke verification succeeded |
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
create a visible session in the exact trusted checkout. The OpenChamber process,
not the Actions job, owns model authentication. The orchestrator
uses the pinned `@hueyexe/opencode-ensemble@0.16.0` plugin to coordinate a
bounded team. Its isolated `.opencode/ensemble-package/package-lock.json` avoids
changing application toolchain resolution. Implementers work in isolated
worktrees; tests and risk reviews are independent roles.

The implementation lead and tester/risk roles use James's local ChatGPT/Codex
OAuth with `openai/gpt-5.6-sol`. Implementation and scouting use Anthropic
Pro/Max OAuth through the locally installed `opencode-anthropic-oauth@0.4.7`
plugin, routed to Claude Opus 4.8 and Sonnet 5. Independent semantic review uses
Claude Opus 4.8. OAuth files, access tokens, and refresh tokens never enter the
runner environment, GitHub secrets, artifacts, logs, or repository.

The model emits a patch artifact. A second job executes and validates that patch
without write or OIDC authority. Only after verification does a model-free
publisher exchange OIDC for the OpenCode GitHub App installation token, apply the
same digest-bound patch without executing it, and create the branch and PR. App
events trigger CI; normal workflow `GITHUB_TOKEN` writes do not recursively
trigger most workflows.

`agent-review.yml` is loaded from the trusted default branch and clears stale
approval whenever the PR head changes. One hosted read-only-token job runs the
exact candidate's release gate. A separate self-hosted job submits a read-only
OpenChamber review session from the trusted base checkout, treats the candidate
checkout as read-only data, and cannot execute candidate code. Its SHA-bound
decision is uploaded as an artifact. A deterministic write-capable hosted job
rechecks the live head before adding
`agent:approved`. On rejection it closes the candidate and dispatches a fresh
implementation from current `main`, at most three times.

The gate also publishes `Agent Review / Exact SHA` directly on the candidate
commit. Control-plane, dependency, migration, and infrastructure changes require
James's GitHub approval on that exact head in addition to model review.

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
.opencode/ensemble.json
.opencode/ensemble-package/package.json
.opencode/ensemble-package/package-lock.json
.opencode/agents/pipeline-*.md
.opencode/skills/github-agent-pipeline/SKILL.md
.github/ISSUE_TEMPLATE/agent-task.yml
.github/workflows/agent-task.yml
.github/workflows/agent-review.yml
.github/workflows/agent-reconcile.yml
scripts/agent-pipeline.mjs
```

Do not copy QuickDucks-specific prompts unchanged. Replace domain invariants,
test commands, risk areas, timeout budgets, trusted actor, concurrency prefixes,
model choices, and release workflow name.

### 3. Configure the local model worker

Pin a tested OpenCode version and every third-party plugin version in the lockfile;
load repository plugins from the locked local package, never a floating package
spec. Install OpenChamber and a repository-scoped self-hosted Actions runner on
the model machine. Give that runner a unique label and target only model jobs
with it. Serialize top-level OAuth sessions; Ensemble may still parallelize
roles inside one OpenCode session.

Authenticate paid providers only in the local OpenCode/OpenChamber runtime. Do
not copy `auth.json`, `OPENCODE_AUTH_CONTENT`, access tokens, or refresh tokens to
GitHub. Verify the local OpenChamber model list before enabling intake. The
self-hosted job should call `openchamber session create --wait`; it must not load
provider credentials into the Actions process.

Install the official OpenCode Agent GitHub App on the target repository. Grant
`id-token: write` only to a deterministic publisher that never executes candidate
code or invokes a model. Exchange OIDC for the short-lived App installation token
there. Never upload a local OpenCode `auth.json` or OAuth refresh token to Actions.

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
- Do not allow Actions to approve reviews unless the design explicitly needs it.

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
5. Install the OpenCode GitHub App and verify the model-free OIDC publisher.
6. Submit one documentation-only canary issue.
7. Confirm local OpenChamber sessions, branch creation, PR CI, independent review,
   merge slot, environment approval, deployment, smoke tests, and final issue state.
8. Test a duplicate, a grouped update, a blocked issue, a failed test, and a
   reconciler retry before increasing concurrency.

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
