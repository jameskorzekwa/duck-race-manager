---
name: github-agent-pipeline
description: Use for QuickDucks GitHub agent-pipeline triage, implementation, review, merge admission, and deployment-state work.
---

# GitHub Agent Pipeline

GitHub is the durable workflow ledger. Agent memory, local worktrees, and an active model turn are never authoritative.

## States

An issue or PR may carry one current pipeline state:

- `agent:inbox`: accepted but not triaged.
- `agent:triage`: classification in progress.
- `agent:ready`: independently releasable and ready to run.
- `agent:running`: an implementation or repair run is active.
- `agent:grouped`: requirements belong to a canonical active issue.
- `agent:blocked`: waiting on explicit dependencies or input.
- `agent:review`: implementation has a PR under test or review.
- `agent:approved`: independent agent review passed at the current head SHA.
- `agent:merge-slot`: the only change allowed to merge or deploy.
- `agent:deployed`: production release and smoke verification succeeded.
- `agent:failed`: intervention or bounded retry is required.

General labels such as `bug`, `enhancement`, `documentation`, and `duplicate` may coexist with one pipeline state.

## Invariants

1. Only requests created or explicitly commanded by `jameskorzekwa` enter automation.
2. New work is isolated by issue, runner, branch, and PR.
3. Semantic grouping is conservative and recorded with `<!-- agent-pipeline canonical-issue=N -->`.
4. Grouped updates never race canonical work; deterministic reconciliation dispatches them only after the canonical issue is deployed.
5. Implementers never push to `main`.
6. Every behavior change has appropriate real-handler or Playwright integration coverage.
7. `CI / Validate`, candidate-head `Agent Review / Exact SHA`, current-head approval, and the merge slot must all pass before auto-merge.
8. Only one `agent:merge-slot` exists. It remains until production succeeds or a failure is resolved.
9. Production credentials remain solely in the `production` GitHub environment.
10. Reconciliation is deterministic, idempotent, bounded, and based on current GitHub state; it never calls a model.

## GitHub Operations

Use `gh` only for the current repository. Never print authentication state or token values. Before mutating a label or dispatching work, query current state and make the operation idempotent.

Never execute candidate code or load candidate OpenCode configuration in a job with write authority. The trusted `pull_request_target` workflow isolates candidate validation and model review in read-only-token jobs; only a later deterministic job can mutate labels or dispatch retries. Do not weaken required checks, bypass environment approval, or enable a merge while another merge slot or non-completed Release run exists.

## Verification

The release gate is:

```sh
npm test
npm run test:e2e
npm run check
npm audit --audit-level=high
npm run db:migrate:local  # when migrations changed
```

CI and the Release workflow remain authoritative even when agents have run the same commands locally.
