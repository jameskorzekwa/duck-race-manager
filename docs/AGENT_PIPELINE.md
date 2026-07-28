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
Pull request -> CI Validate -> independent Agent Review
        |
        v
agent:approved -> one agent:merge-slot -> GitHub auto-merge
        |
        v
Release validation -> production approval -> deployment and smoke tests
        |
        v
Agent Reconcile -> agent:deployed or agent:failed -> next merge slot
```

OpenChamber is an optional local and mobile control surface. It can create
worktree sessions from issues and PRs, inspect Git state, and provide manual
recovery, but GitHub-hosted agent sessions do not appear as live local
OpenChamber sessions.

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
<!-- agent-pipeline canonical-issue=123 canonical-pr=456 -->
```

The marker lets reconciliation resume without depending on model memory.

## Trusted Intake

Use the `Agent feature or fix` issue form or create an issue with
`agent:inbox`. The repository runs issues automatically only when the actor is
`jameskorzekwa`. James can retry or refine an issue with a comment beginning
`/agent` or `/oc`.

The global OpenCode `orchestrator` agent is the preferred conversational intake
path. It converts a request into an issue with explicit acceptance criteria and
then returns immediately. New requests remain accepted while GitHub-hosted
workers are busy.

Public issue and PR text is untrusted. Never broaden the actor condition or use
`pull_request_target` to execute proposed code with write credentials.

## Execution And Review

`agent-task.yml` runs one OpenCode turn per issue at a time. The orchestrator
uses the pinned `@hueyexe/opencode-ensemble@0.16.0` plugin to coordinate a
bounded team. Implementers work in isolated worktrees; tests and risk reviews
are independent roles.

OpenCode is pinned to `1.18.8` in workflow installation steps. GitHub Models
uses `github-models/openai/gpt-5` and `gpt-5-mini` with the job's short-lived
`GITHUB_TOKEN` and `models: read`. No local OAuth credential or long-lived model
key is copied into GitHub.

Repository writes use the OpenCode GitHub App installation token obtained by
OIDC. This matters: branch and PR events created by a normal workflow
`GITHUB_TOKEN` do not recursively start CI, while GitHub App events do.

`agent-review.yml` clears stale approval whenever the PR head changes. Reviewers
must fix findings and let the resulting push trigger another review. They add
`agent:approved` only when the exact current head needs no edit and the full
release gate passes.

## Merge And Deployment

The merge decision is deterministic. A serialized job checks all of these:

1. The PR is still open and carries `agent:approved`.
2. No PR in any state carries `agent:merge-slot`.
3. No Release workflow run is queued, in progress, or waiting for approval.
4. GitHub branch protection still requires `Validate`.

It then adds `agent:merge-slot` and enables merge-commit auto-merge. GitHub waits
for required checks. The slot remains through production approval, deployment,
smoke tests, tag creation, and release publication.

The production environment requires James's approval and has no administrator
bypass. The deploy job refetches `main` after approval and fails if its validated
SHA is stale.

## Recovery

`agent-reconcile.yml` runs twice per hour and on demand. It:

- Settles successful or failed releases for the merge-slot PR.
- Dispatches grouped requirements only after the canonical branch is idle.
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
.opencode/agents/pipeline-*.md
.opencode/skills/github-agent-pipeline/SKILL.md
.github/ISSUE_TEMPLATE/agent-task.yml
.github/workflows/agent-task.yml
.github/workflows/agent-review.yml
.github/workflows/agent-reconcile.yml
```

Do not copy QuickDucks-specific prompts unchanged. Replace domain invariants,
test commands, risk areas, timeout budgets, trusted actor, concurrency prefixes,
model choices, and release workflow name.

### 3. Pin and authenticate OpenCode

Pin a tested OpenCode version and every third-party plugin version. For a
secretless GitHub-hosted setup, grant `models: read`, set
`GITHUB_TOKEN: ${{ github.token }}`, and use a `github-models/...` model.

Install the official OpenCode Agent GitHub App on the target repository. Keep
`USE_GITHUB_TOKEN=false` and grant `id-token: write` so repository writes use the
short-lived App installation token. Never upload a local OpenCode `auth.json` or
OAuth refresh token to Actions.

### 4. Create labels

Create every label from the Durable State table with clear descriptions. The
issue form references `agent:inbox`, so create labels before enabling the form.

### 5. Configure repository policy

- Enable auto-merge.
- Delete merged branches when appropriate.
- Protect the default branch and require pull requests.
- Require the deterministic CI check.
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
4. Install the OpenCode GitHub App and verify OIDC exchange.
5. Submit one documentation-only canary issue.
6. Confirm branch creation, PR CI, independent review, merge slot, environment
   approval, deployment, smoke tests, and final issue state.
7. Test a duplicate, a grouped update, a blocked issue, a failed test, and a
   reconciler retry before increasing concurrency.

## OpenChamber Setup

Install a version paired with the configured OpenCode release. OpenChamber
`1.17.0` pins OpenCode SDK `1.18.8`. Connect GitHub under **Settings -> Git** to
start manual worktree sessions from issues and PRs.

When enabling the OpenChamber startup service, snapshot only a minimal,
non-secret environment. Set an explicit `OPENCODE_BINARY` when OpenCode is not
on the service's default `PATH`. Never persist provider tokens in a service
definition.

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
```

Never use operational commands to bypass required CI, merge-slot serialization,
or production approval.
