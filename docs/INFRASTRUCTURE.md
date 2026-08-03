# QuickDucks Infrastructure, Deployment, and Releases

## Production Services

| Service | Resource | Management path |
| --- | --- | --- |
| Source and releases | `jameskorzekwa/duck-race-manager` | GitHub |
| Canonical origin | `https://quickducks.com` | Cloudflare DNS and Worker Custom Domain |
| Redirect origin | `https://www.quickducks.com` | Worker Custom Domain; application returns `308` |
| Web and API | Cloudflare Worker `quickducks` | `wrangler.jsonc` and merge-driven production releases |
| Database | Cloudflare D1 `quickducks-prod` | Wrangler and `db/migrations` |
| Live refresh fan-out | Durable Object class `RaceUpdates`, binding `RACE_UPDATES` | Wrangler class migration and Worker deployment |
| Public search limit | Workers binding `PUBLIC_SEARCH_RATE_LIMITER` | `wrangler.jsonc` |
| Email queue | Cloudflare Queue `quickducks-email` | Wrangler producer/consumer and `EMAIL_QUEUE` binding |
| Email dead-letter queue | Cloudflare Queue `quickducks-email-dlq` | Wrangler consumer retry exhaustion |
| Staff identity | Cognito user pool `quickducks-staff` in `us-east-1` | CloudFormation |
| Transactional email identity | Amazon SES identity `quickducks.com` in `us-east-1` | CloudFormation plus DNS |
| Transactional SMS | AWS End User Messaging SMS registered toll-free identity and opt-out list in `us-east-1` | AWS registration plus encrypted Worker configuration |
| Worker AWS identity | IAM user `quickducks-worker-ses` | Application CloudFormation stack; bootstrap-owned permissions boundary; key stored as Worker secrets |
| Registration challenge | Cloudflare Turnstile widget for `quickducks.com` | Cloudflare dashboard plus Worker variable/secret |

Porkbun remains the registrar. Cloudflare becomes the authoritative DNS
provider after the registrar uses the nameservers assigned to the Cloudflare
zone. The Worker, Durable Object namespace, D1 database, queues, zone, Turnstile widget, and AWS account
are production resources. Do not create substitutes during a release.

## Security Boundaries

- Pull-request and branch CI receives no production credentials.
- The release validation job receives no production credentials.
- The `production` GitHub environment gates the deployment job and its
  `CLOUDFLARE_API_TOKEN` secret.
- AWS uses GitHub OIDC and short-lived credentials. The GitHub role controls
  one stack's change sets, while a separate CloudFormation execution role
  controls the resources in that stack. No AWS deployment access key is stored
  in GitHub.
- The bootstrap stack is the sole manager of
  `quickducks-worker-ses-boundary`. The application stack can attach only that
  boundary to the exact Worker user; it cannot create or alter boundary policy
  versions or remove the boundary. The boundary fixes effective email sending
  to the `quickducks.com` identity, provider suppression reads, and staff
  administration to the production Cognito pool. SMS access is absent by
  default; after carrier registration, separate conditional statements scope
  sending and STOP-list reads to the exact configured origination and opt-out
  list ARNs.
- The Worker's runtime AWS key pair and both Turnstile keys exist only as
  encrypted Cloudflare Worker secrets. They are not GitHub Actions secrets and
  the release does not replace them.
- All third-party actions are pinned to full commit SHAs. The adjacent version
  comment is informational; review and repin the SHA when upgrading an action.
- Workflow permissions are job-scoped. Only the deployment job can request an
  OIDC token and only the final job can write a GitHub release.
- Production releases use one concurrency group with `queue: max`. Up to 100
  `main` and version-tag runs wait in one FIFO queue, execute one at a time, and
  are not canceled in progress.
- Before any AWS, D1, or Worker mutation, the release lists encrypted Worker
  secret names and requires the complete documented set. Secret values are
  never requested or printed.

Automatic Workers invocation logs are disabled in `wrangler.jsonc` because
fetch-event logs include request URLs. QuickDucks private status credentials are
URL path segments and must not be persisted. Application and deployment logs
must also exclude request bodies, names, contact details, private tokens, lookup
codes, tag tokens, AWS keys, Turnstile secrets, and Cloudflare API tokens.

## Continuous Integration

`.github/workflows/ci.yml` runs for every pull request and every branch push. It
uses the repository's Node.js 24 CI baseline (the locked Wrangler version
requires Node.js 22 or later), then runs these commands in order:

```sh
npm ci
npm audit --audit-level=high
npm run typecheck
npm test
npx playwright install --with-deps chromium
npm run test:e2e
npm run wrangler:validate
npm run db:migrate:local
```

`npm ci` installs exactly `package-lock.json`; the audit fails on high or
critical known vulnerabilities. The TypeScript command performs a no-emit
strict check. The test command runs every `src/*.test.mjs` file. The Wrangler
validation script discovers every non-example `wrangler*.json`,
`wrangler*.jsonc`, or `wrangler*.toml` outside generated directories and
dry-runs each entry without uploading it; the production and isolated local
configurations both match. The D1 command applies
every migration to a fresh local D1 database, which catches SQL ordering and
schema errors without contacting production.

The tests also cover exact-origin Durable Object routing, connection caps,
client-frame policy closure, best-effort mutation publication, public-board
privacy/current assignments against freshly migrated SQLite, fake-timer polling
and refresh coalescing, station role/state gates, overlapping heat boundaries,
serialized NFC/URL/number selection, stale response rejection, contextual iPhone
handoff, ACTIVE result eligibility, and the complete round-one/final/completed
workflow with refresh signals.

Configure the `Validate` job as a required status check on the protected default
branch. Do not replace `pull_request` with `pull_request_target`; untrusted pull
request code must never run in a privileged context.

## GitHub Agent Pipeline

The OpenCode agent pipeline uses GitHub issues, labels, branches, pull requests,
checks, workflow runs, and deployments as its durable ledger. OpenChamber/OpenCode
sessions are execution contexts only; interrupted turns are
recovered from GitHub state rather than treated as durable jobs.

- `.github/workflows/agent-task.yml` accepts trusted `agent:inbox` issues,
  serializes work per issue, and runs the implementation orchestrator.
- `.github/workflows/agent-review.yml` validates candidate code with read-only
  authority, reviews it from a trusted checkout, and records an exact-SHA gate.
- `.github/workflows/agent-reconcile.yml` deterministically repairs stale state,
  releases grouped work, settles releases, and advances the next PR without a model.
- `.opencode/agents/` contains a least-privilege implementation lead and
  allowlisted read-only scout, test-review, risk-review, and independent-review roles.
- `docs/AGENT_PIPELINE.md` is the operating and reusable installation guide.

Only issues created by James with `agent:inbox`, explicit James `/agent` or
`/oc` issue comments, and trusted workflow dispatches run code agents. Public
issue or PR content never receives an automatic privileged execution path.
Implementation jobs run on two repository-scoped `quickducks-implement` runners;
independent review uses a dedicated `quickducks-review` runner. They submit
sessions to James's local OpenChamber runtime, which already owns the paid
OpenAI and Anthropic OAuth credentials. Those credentials are never copied into
GitHub secrets or the Actions environment. A model-free publisher uses its
short-lived repository-scoped `GITHUB_TOKEN`, then explicitly dispatches the
trusted-default-branch review because workflow-token writes do not recursively
trigger most workflows. The verified task base remains immutable
fork-point provenance, so publication continues when unrelated commits reach
`main`; trusted review validates that ancestry and the exact candidate's
mergeability. Agent jobs do not receive production credentials.

Local models receive unique plain-file snapshots with no `.git` directory.
Deny-by-default agents cannot use shell, PTY, network/MCP tools, LSP, formatters,
environment files, OpenCode tool-output storage, or external paths. Patch
extraction uses a separate trusted Git repository after a pre-copy `lstat`
quarantine rejects case-folded Git metadata, symlinks, hardlinks, and non-regular
files. A case-insensitive policy rejects gitlinks and pipeline control-plane paths
before any autonomous branch is published. Runner-scoped state records isolate
concurrent sessions. Failed hosted verification reconstructs the saved workspace
and sends evidence into the same OpenChamber session; completed workspaces are
deleted transactionally only after all matching sessions are idle.

Agent Review uses `pull_request_target` only as a trusted control plane. Candidate
tests and local OpenChamber model review run in separate jobs with read-only
repository authority; the model loads agents and plugins from the trusted base
snapshot and receives the candidate only as a patch. Candidate code is not
executed or exposed as a symlink-capable filesystem in the model job, and the write-capable
hosted gate never checks out or executes candidate code. The gate rechecks the
current PR head before mutation.

The merge lane is deliberately narrower than implementation concurrency. One PR
holds `agent:merge-slot` until its exact merge commit completes the Release
workflow and production smoke tests. Other implementation and review runs may
continue, but no second PR is admitted while a merge slot or non-completed
Release run exists.

## GitHub Production Configuration

Create a GitHub environment named exactly `production`. Configure:

- Require James as the production deployment reviewer. Code may auto-merge only
  after required CI and agent review, but production credentials remain locked
  until this explicit environment approval.
- No administrator bypass.
- Selected deployment branches and tags allowing exactly the `main` branch and
  `v*` tags. The workflow narrows tags further to `v*.*.*` and validates strict
  canonical SemVer before credentials become available.
- An environment URL of `https://quickducks.com` if desired; the workflow also
  publishes this URL from `PRODUCTION_URL`.

Store this one secret under the `production` environment, not as plaintext in a
workflow, repository variable, shell profile, or committed file:

| Secret | Value | Used for |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Scoped Cloudflare API token | Remote D1 migrations and Worker/custom-domain deployment |

Create these as repository Actions variables so both the deployment and release
jobs can read non-secret deployment metadata:

| Variable | Production value or source |
| --- | --- |
| `AWS_ACCOUNT_ID` | `106298360125`; non-secret |
| `AWS_DEPLOY_ROLE_ARN` | Bootstrap output `GitHubDeploymentRoleArn` |
| `AWS_CLOUDFORMATION_ROLE_ARN` | Bootstrap output `CloudFormationExecutionRoleArn` |
| `AWS_REGION` | `us-east-1` |
| `AWS_STACK_NAME` | `quickducks-production` |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID containing Worker, D1, queues, and zone; non-secret |
| `PRODUCTION_URL` | `https://quickducks.com` with no trailing slash |
| `WWW_URL` | `https://www.quickducks.com` with no trailing slash |

`GITHUB_TOKEN` is issued automatically for each job and is not a manually
configured secret. It receives `contents: write` only in the release job.

The one-time setup order is:

1. Create and protect the exact GitHub `production` environment, initially
   keeping the release workflow disabled until every remaining gate is ready.
2. Deploy and review the AWS bootstrap stack.
3. Set both role-output variables and the remaining repository variables.
4. Deploy or update `quickducks-production` with the execution-role output.
5. Copy the application outputs into the committed Worker configuration.
6. Complete the Cloudflare, D1, queue, DNS, SES, Turnstile, and Worker-secret
   gates below.
7. Confirm the environment requires James's review, allows only `main` and `v*`,
   and retains no-admin-bypass, then enable merge-driven releases.

Protect semantic-version tags with a repository ruleset. Limit tag creation and
updates to the final release workflow and release maintainers, block force
updates and deletion, and require review of intentional maintainer-created tags.
The final workflow job must be allowed to create automatic lightweight patch
tags with its job-scoped `GITHUB_TOKEN`; a blanket signed-tag requirement must
not block that automation. Maintainers should sign intentional major, minor, and
prerelease tags. The workflow fetches full history and tags and independently
requires every explicit tag's peeled commit to be an ancestor of the repository
default branch. Tag signatures and tag-rule enforcement remain repository and
release-maintainer controls; the workflow does not claim to verify signature
trust.

## AWS Bootstrap

`infra/aws/github-actions-bootstrap.yaml` is the reproducible source of the
GitHub OIDC provider, both deployment roles, and the Worker permissions
boundary. An AWS administrator must deploy
it before the first application stack or automated release. The provider has
only the `sts.amazonaws.com` audience. `ThumbprintList` is intentionally omitted
so IAM retrieves the top intermediate CA thumbprint.

The fixed `quickducks-github-deploy` role trusts only this exact audience and
the default environment subject. GitHub repositories created after July 15,
2026 include immutable owner and repository IDs in `sub`; do not replace them
with the older name-only format:

```text
repo:jameskorzekwa@38769771/duck-race-manager@1312323923:environment:production
```

The repository and environment are parameters so another exact repository or
environment can use the template, but the trust policy never introduces a
repository, branch, ref, or subject wildcard. The release workflow requires the
committed production defaults and exact fixed output ARN.

### Bootstrap Stack Deployment

From a trusted administrator workstation with a browser-authenticated AWS CLI
session, deploy the bootstrap stack. This creates IAM trust and permission
resources, so review the template and change set before approval:

```sh
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name quickducks-github-actions-bootstrap \
  --template-file infra/aws/github-actions-bootstrap.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    GitHubRepositorySubject=jameskorzekwa@38769771/duck-race-manager@1312323923 \
    GitHubEnvironment=production \
    ApplicationStackName=quickducks-production \
    StaffUserPoolId=us-east-1_QuEKwmLhI \
  --tags Project=quickducks Environment=production
```

Use the same reviewed command to update the bootstrap stack after changing its
template. It updates the existing named stack; it does not rotate credentials
because OIDC has no stored AWS credential.

During a controlled bootstrap, the administrator path may need CloudFormation
change-set permissions for only `quickducks-github-actions-bootstrap`, plus IAM
create/read/tag/update permissions for the exact
`token.actions.githubusercontent.com` provider, the two fixed role ARNs, and
`arn:aws:iam::106298360125:policy/quickducks-worker-ses-boundary`.
Role-policy writes must be limited to those roles. Do not solve an access denial
by attaching `AdministratorAccess` to either generated role. Organization SCPs,
permission boundaries, or the administrator's session policy must be adjusted
separately and only for the denied bootstrap action, then restored after the
reviewed stack succeeds.

Read both authoritative role outputs:

```sh
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name quickducks-github-actions-bootstrap \
  --query 'Stacks[0].Outputs[].[OutputKey,OutputValue]' \
  --output table
```

Set the repository variables directly from those outputs:

```sh
gh variable set AWS_ACCOUNT_ID --body 106298360125
gh variable set AWS_REGION --body us-east-1
gh variable set AWS_STACK_NAME --body quickducks-production
gh variable set AWS_DEPLOY_ROLE_ARN --body "$(aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name quickducks-github-actions-bootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='GitHubDeploymentRoleArn'].OutputValue | [0]" \
  --output text)"
gh variable set AWS_CLOUDFORMATION_ROLE_ARN --body "$(aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name quickducks-github-actions-bootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFormationExecutionRoleArn'].OutputValue | [0]" \
  --output text)"
gh variable set PRODUCTION_URL --body https://quickducks.com
gh variable set WWW_URL --body https://www.quickducks.com
gh variable set CLOUDFLARE_ACCOUNT_ID --body '<cloudflare-account-id>'
```

`CLOUDFLARE_ACCOUNT_ID` must be replaced with the non-secret production account
ID. Create the `production` environment and its review rules before setting the
environment secret. `gh secret set --env production CLOUDFLARE_API_TOKEN`
prompts for the token without placing it in the command or this repository.

### Separation Of Duties

The GitHub role can validate local templates and create only AWS CLI-named
change sets for `quickducks-production` with the exact execution role and
controlled tags. CloudFormation does not expose `ChangeSetName` as an IAM
condition for describe, execute, or delete, so those calls are instead limited
to the exact stack ARN and its `Project=quickducks` and
`Environment=production` resource tags. The role can read only that stack and
pass only `quickducks-cloudformation-execution` to CloudFormation.
`GetTemplateSummary` is included because `aws cloudformation deploy` calls it
for an existing stack.
The role has no direct `TagResource` or `UntagResource` permission and cannot
call Cognito, SES, or IAM resource APIs directly.

The fixed execution role trusts only `cloudformation.amazonaws.com`. It can
create a Cognito user pool only with the `Project=quickducks` and
`Environment=production` request tags, then manage user-pool clients, the
prefix domain, and managed branding only through a correspondingly tagged pool.
`DescribeUserPoolDomain` remains on `*` because that API has no resource-level
authorization. SES permissions use only the exact `quickducks.com` identity ARN,
which includes its `mail.quickducks.com` MAIL FROM configuration. IAM write
permissions use only the exact `quickducks-worker-ses` user ARN and its inline
policy. It can put the exact bootstrap boundary on that tagged user, but cannot
remove it or create, edit, attach, detach, or delete managed policies. A release
that attempts to remove the boundary or delete the user fails closed. The role
can list that user's attached state and access-key metadata for safe
CloudFormation reads, but it cannot create, update, or delete access keys, login
profiles, groups, managed policies, roles, or unrelated users.

Neither role has `AdministratorAccess`. Resource create calls require the fixed
project/environment request tags; later calls require those resource tags.
Only release metadata tags can be removed. Changes to
`infra/aws/quickducks.yaml` that add a resource type, name, or provider API must
update and re-review the execution policy before release.

### Initial Application Stack

If `quickducks-worker-ses` already exists in the application stack, its tags and
boundary must be established through the administrator session before the first
update that switches the stack to the restricted execution role. Run these
exact one-time commands only after the reviewed bootstrap update has created the
boundary:

```sh
aws iam tag-user \
  --user-name quickducks-worker-ses \
  --tags Key=Project,Value=quickducks Key=Environment,Value=production

aws iam put-user-permissions-boundary \
  --user-name quickducks-worker-ses \
  --permissions-boundary arn:aws:iam::106298360125:policy/quickducks-worker-ses-boundary
```

Verify `PermissionsBoundary.PermissionsBoundaryArn` and both tags with
`aws iam get-user --user-name quickducks-worker-ses`, then perform the
service-role application update below. Do not temporarily grant untagged-user,
wildcard-user, or managed-policy administration to the execution role. These
commands prepare an existing stack-managed user; they do not import an unrelated
same-named user into CloudFormation.

Read the execution role ARN and use it for the initial application deployment.
CloudFormation permanently records a service role once one is associated with a
stack, so every create and update command must pass this role rather than falling
back to the administrator or GitHub caller's permissions:

```sh
AWS_CLOUDFORMATION_ROLE_ARN="$(aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name quickducks-github-actions-bootstrap \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFormationExecutionRoleArn'].OutputValue | [0]" \
  --output text)"

aws cloudformation deploy \
  --region us-east-1 \
  --stack-name quickducks-production \
  --template-file infra/aws/quickducks.yaml \
  --role-arn "$AWS_CLOUDFORMATION_ROLE_ARN" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AppOrigin=https://quickducks.com \
  --tags Project=quickducks Environment=production
```

This command also adopts the execution role for an existing
`quickducks-production` stack that was originally created without a service
role. The administrator running it needs CloudFormation change-set access to
that exact stack and `iam:PassRole` for only the execution-role output. The
execution role, not the administrator session, performs the Cognito, SES, and
worker-user operations.

The template creates or updates:

- A deletion-protected, invite-only Cognito user pool with password and email
  OTP authentication factors.
- A public OAuth client using authorization code, PKCE in the application, and
  the committed callback/logout origins.
- A Cognito managed-login domain and default branding.
- The `quickducks.com` SES identity with Easy DKIM and custom MAIL FROM.
- The `quickducks-worker-ses` IAM user and an inline policy limited to sending
  from the QuickDucks SES identity and managing staff identities in this user
  pool, capped by the independently bootstrap-managed permissions boundary.

The stack deliberately does not create an IAM access key. The user pool and
managed-login branding have retain policies, and the pool has deletion
protection. Never delete the stack as a rollback procedure.

Read the stack outputs after the first deployment:

```sh
aws cloudformation describe-stacks \
  --region us-east-1 \
  --stack-name quickducks-production \
  --query 'Stacks[0].Outputs' \
  --output table
```

Copy `UserPoolId`, `UserPoolClientId`, and `CognitoDomain` into the matching
non-secret `wrangler.jsonc` variables and commit that configuration. The release
workflow requires this exact named stack to exist and fails before mutation if
these committed values, `AppOrigin`, or `AWS_REGION` do not match. It will not
turn a misspelled stack name into a new stack.

The manually bootstrapped stack has no automated-release `Version` or `Commit`
tag. The first automated release may add both. Every later release must have
greater SemVer precedence than the stack's normalized `Version`, with two
deliberate forward-recovery exceptions. First, an exact same version is
permitted when `Commit` is also the same verified source commit, for a
same-source recovery rerun, and additionally when that recorded version was
deployed but never published as a release tag: a later default-branch commit may
then claim the still-untagged version instead of deadlocking, because no tag
ever fixed it to the earlier commit. Second, a stable release may follow a
deployed explicit prerelease even with lower SemVer precedence, because
prereleases never join the stable release train. A lower stable version over a
deployed stable version, an equal-precedence version with different build
metadata, a same version whose tag exists at another commit, or a stack with
`Commit` but no `Version` is rejected before CloudFormation deployment.
For every release with a recorded predecessor, the recorded commit must also
exist in the full checkout and be an ancestor of the incoming source commit. A
missing recorded object, shallow/incomplete history, older source commit,
divergent history, or Git ancestry error fails closed. Only the first release,
where both stack tags are absent, has no prior ancestry to prove.

### Cognito and SES Gates

Public Cognito sign-up remains disabled. The application verifies the access
token and requires a matching active `staff_profiles` row; a Cognito identity
alone has no staff authorization. Establish the first system administrator
through a reviewed, audited bootstrap procedure before relying on the protected
staff UI for subsequent grants. Do not weaken the matching-profile check or
temporarily enable public sign-up.

Publish the three Easy DKIM CNAME records from `SesDkimName1` through
`SesDkimValue3`. Configure the `mail.quickducks.com` custom MAIL FROM MX and SPF
records shown by SES, and publish the organization's DMARC policy at
`_dmarc.quickducks.com`. Wait for SES to report the identity and DKIM as
verified. New SES accounts are region-specific sandboxes; request production
access in `us-east-1` and complete a controlled send, bounce, and complaint
test before enabling race notifications.

## Cloudflare Bootstrap

### Account, Zone, and Deployment Token

Add `quickducks.com` to the intended Cloudflare account, change the registrar to
the assigned Cloudflare nameservers, wait for the zone to become active, then
enable DNSSEC through Cloudflare and publish the instructed DS record at the
registrar.

Create a dedicated Cloudflare deployment token scoped to only this account and
the `quickducks.com` zone. Start from **Edit Cloudflare Workers**, remove
unrelated KV/R2 permissions, and grant the current permission names needed by
this repository:

- Account: Workers Scripts Write.
- Account: D1 Write, for `quickducks-prod` migrations.
- Account: Account Settings Read, if Wrangler requires account discovery.
- Zone `quickducks.com`: Workers Routes Write, for both Custom Domains.

Cloudflare accepts Workers Scripts Write for the existing Queue producer binding,
so no separate Queues permission is required by this release workflow. If a
future workflow creates, deletes, or changes Queue resources directly, add the
then-current Queues write permission separately rather than broadening this
deployment token in advance.

Workers Scripts Write must permit the deployment to apply the declared Durable
Object class migration. No separate Durable Object credential, secret, or
namespace identifier is committed.

Use the narrowest resource scopes available. Put the token only in the GitHub
`production` environment as `CLOUDFLARE_API_TOKEN`. Put the non-secret account
ID in `CLOUDFLARE_ACCOUNT_ID`. Do not use a Global API Key.

### D1 and Queues

With a browser-authenticated local Wrangler session, create the named resources
once if they do not already exist:

```sh
npx wrangler d1 create quickducks-prod
npx wrangler queues create quickducks-email
npx wrangler queues create quickducks-email-dlq
```

Put the returned D1 database ID in `wrangler.jsonc` and commit it. The committed
binding must remain named `DB`, the database must remain `quickducks-prod`, and
`migrations_dir` must remain `db/migrations`; the package scripts deliberately
use the database name to avoid applying a migration to a renamed binding.

Migration `0012_staff_role_assignments.sql` adds normalized, constrained staff
role assignments and role-set revisions. It creates no assignment rows for
legacy regular profiles and never infers seven-role access. Immediately before
any production mutation, the release first discovers whether
`staff_role_assignments` exists, then performs a read-only query appropriate to
that schema state. It blocks whenever an active non-administrator profile has
zero active role assignments, both before migration and when the role table
already exists after a partial deployment. That case requires a separately
reviewed, explicit per-profile role mapping and controlled migration before the
normal release can continue; do not bypass it with a broad seed or deploy the
new Worker with unmapped regular staff. No expected production profile count is
encoded, inactive staff do not require assignments, and no roles are granted
automatically. After `0012` exists, the preflight passes only when each active
regular account has at least one non-revoked assignment; future regular accounts
receive explicit roles through the normal access workflow. Apply this migration before Worker code that queries
`staff_role_assignments`; the release sequence already applies D1 migrations
before the Worker deployment.

Migration `0016_locked_final_winner_correction.sql` replaces the locked-roster
update trigger with an otherwise identical trigger that permits one narrow
exception: a `CORRECT_HEAT_RESULT` command may replace its exact promoted final
entry while the final heat is `LOADING`. It remains backward compatible with the
previous Worker, which never attempts that update in `LOADING`; generic roster
updates, changes to the entry identity or creation timestamp, and every
correction at `READY` or later still abort. The migration must remain ahead of
the Worker release that exposes the extended correction window.

Migration `0019_round_one_walk_up_admission.sql` replaces only the heat-entry
insert trigger. Its default remains the existing unlocked-`PLANNED` rule. The
new exception requires a matching `ASSIGN_DUCK` command and assignment in the
same transaction, a capacity-bounded Round One slot, event status `ROUND_ONE`,
and a `LOADING`, `READY`, or `CALLING` heat with no historical `START_HEAT`
command. It is backward compatible with the previous Worker, which never tries
to add a new racer after Round One starts. Rollback is Worker-only: retain the
migration and any admitted roster entries; the previous Worker reads and races
them normally but offers no further Round One walk-ups.

Migration `0024_duck_intake_photos.sql` adds `duck_photos` and the exact composite
indexes needed to associate a private JPEG with one duck, event reservation,
admitting staff profile, and confirmed provisioning command. It backfills
nothing. Pending and complete row shapes are CHECK-constrained, JPEG bytes are
capped at 1,000,000 bytes, and upload command/fingerprint fields become complete
together. Cascades keep the migration compatible during the migrations-before-
Worker window: the previously deployed Worker's duck and event deletion order
still removes a photo when it deletes the reservation or provisioning command.
The new Worker deletes `duck_photos` explicitly before those parents.

Photos are stored as private D1 BLOBs; this release adds no R2 bucket, binding,
secret, queue, or public object URL. They therefore follow D1 backup, Time Travel,
regional storage, and complete-event deletion behavior. Invocation logs remain
disabled, and application logs and audit details must never contain JPEG bytes,
digests, request bodies, or a protected photo URL. Capacity planning must include
up to 1 MB per Android-NFC-admitted duck plus row/index overhead.

The Worker sends only opaque notification IDs to `quickducks-email` through the
`EMAIL_QUEUE` producer binding. The same Worker consumes batches of at most ten,
with five bounded queue attempts and `quickducks-email-dlq` attached. A one-minute
cron republishes durable `PENDING` work and queue-publication failures, closing
the D1-commit/queue-publication gap without putting email delivery inside a race
control request. Queue duplicates are expected and safe: a D1 claim and the
logical-message unique index prevent an ordinary duplicate delivery from
sending twice. Migration `0021_email_delivery_claim.sql` adds the nullable,
unique token used to own an active delivery claim; it remains compatible with
the previous Worker. A stale claim is terminally recorded as
`DELIVERY_OUTCOME_UNKNOWN` and is not automatically or manually retried, because
it may represent SES acceptance followed by a failed D1 finalization. This
at-most-once recovery policy can miss a reminder after a pre-send Worker stop,
but cannot duplicate a message whose post-send persistence was ambiguous.

The consumer signs a structured SES v2 `SendEmail` request or AWS JSON 1.0
`PinpointSMSVoiceV2.SendTextMessage` request with the Worker's encrypted AWS
key. SMS submissions have a five-minute provider TTL so a delayed carrier
handoff cannot surface a race update hours later. `EMAIL_FROM_ADDRESS` is the non-secret committed sender
`race@quickducks.com`; it remains under the verified `quickducks.com` identity.
Current consent, address, assignment, and heat state are loaded only after the
opaque ID is received. Migration `0020_email_notification_assignment.sql` adds
a nullable assignment reference so the previous Worker remains deployable; new
notifications pin their originating assignment, while null legacy work and any
replacement mismatch are cancelled instead of being rendered with a different
duck. Automatic invocation logs remain disabled, and raw SES responses,
recipient addresses, rendered bodies, and credentials must not be logged or
persisted as errors. Provider acceptance is recorded honestly as `SENT`;
delivery/bounce/complaint callbacks are not currently implemented.

SMS defaults off for every event. Production needs a registered toll-free
origination identity, its AWS opt-out list, and the three encrypted notification
configuration values below before an administrator can enable SMS in Event
Details. Disabling the event switch cancels pending SMS work and stops message
usage charges without affecting email. The registered number may remain leased
year-round at approximately $2/month; turning the event switch off does not end
that lease.

Until registration and sandbox exit are confirmed, leave the production
environment variables `SMS_ORIGINATION_IDENTITY_ARN` and
`SMS_OPT_OUT_LIST_ARN` empty; both CloudFormation templates then grant no SMS
runtime action. After AWS provisions the resources, update the bootstrap stack
with both exact ARNs, set the same two GitHub production environment variables,
and review the application change set before release. Configure
`SMS_ORIGINATION_IDENTITY` and `SMS_OPT_OUT_LIST_NAME` Worker secrets with those
same full ARNs. Never use `Resource: "*"` for `SendTextMessage` or
`DescribeOptedOutNumbers`, and never grant the unused `DescribeOptOutLists`
action.

To release the number, disable event SMS, confirm no SMS row remains sendable,
release the origination identity through AWS End User Messaging SMS, and remove
`SMS_ORIGINATION_IDENTITY` from Worker secrets. Using SMS again then requires a
new identity and completed carrier registration before restoring the secret and
enabling an event. Never substitute an unregistered identity.

After deployment, use a synthetic controlled registration to opt into email,
pair it, and advance its heat through authoritative race progression. Confirm the support view reaches `SENT` for the
assignment and upcoming notification and that the controlled mailbox receives
the expected text. Do not use participant data for this canary. Inspect the main
queue and DLQ metrics for retries. If sending misbehaves, pause the queue
consumer first (or remove its consumer binding in a reviewed Worker rollback),
then revoke the Worker SES key if containment requires it. Retain D1 notification
and attempt history plus queue/DLQ messages for diagnosis; already accepted
email cannot be recalled, and replaying a DLQ must pass the same current-state
checks as ordinary delivery.

### Durable Object Live Refresh

Both `wrangler.jsonc` and `wrangler.example.jsonc` declare the
`RACE_UPDATES` binding to exported class `RaceUpdates` and migration tag `v1`
with `new_sqlite_classes: ["RaceUpdates"]`. The class migration is applied as
part of Worker deployment; there is no separate `wrangler` create command and
no resource ID to copy into configuration. Do not rename the binding, class, or
recorded migration tag after deployment.

All clients connect to same-origin `/api/v1/live`, which requires the exact
`APP_ORIGIN` Origin and routes to one named object instance. The object uses the
hibernatable WebSocket API and caps itself at 1,000 simultaneous connections,
well below the platform maximum so one race fan-out retains CPU and memory
headroom. Over-cap upgrades receive `503`; any client-sent text or binary frame
is closed with policy code `1008` because the channel is server-to-client signal
only. Do not add client network identifiers to admission, socket metadata,
signals, or logs.

The object broadcasts only a validated bounded
`{type:"refresh", domains:[...], version:<random UUID>}` signal. Domains come
from the fixed `all`, `event`, `participants`, `ducks`, `heats`, `staff`, and
`support` allowlist. The frame contains no authoritative race data,
IDs, names, contact details, event/participant/duck labels, lookup codes, tokens,
tag URLs, commands, mutation payloads, client network identifiers, or durable
application state.

Successful mutating routes are classified after their handler returns from its
committed D1/API work. Publication is scheduled with
`ExecutionContext.waitUntil`; failures are isolated from the committed response.
Read-only POST operations such as heat-plan preview and tag classification are
explicitly excluded. Clients use domains only to choose authoritative D1-backed
API refetches. They poll approximately every five seconds while WebSocket is
unavailable/disconnected and use an approximately 30-second integrity refresh
while connected. Hidden tabs pause polling/rendering, reconnects use jitter and
refetch immediately, and concurrent refresh triggers are coalesced.
An authoritative empty race-board poll returns an already-open `/race` document
to the Preparing home page even if it missed the event-deletion signal. All
unversioned application JavaScript is served `no-store`: the classic page
clients and shared live runtime publish and roll back as one compatible unit.

The shared browser hub defers ordinary refreshes while a form, scan, NFC write,
result selection, or command is dirty/in flight. Event deletion's `all` signal
clears rendered main content and server-reloads without deferral. A `staff` signal calls
the PII-free `/api/v1/staff/session` projection; deactivation or reduced access
clears protected rendering and navigates/reloads immediately. These behaviors
are application safety rules, not WebSocket authorization; every API refetch
still authenticates and authorizes independently.

Operator smoke checks after deployment:

1. Load `/` and confirm the live board resolves its stage chip, event name, and
   summary even when no event or heat exists, and that no freshness text appears.
2. Confirm an ordinary non-upgrade `GET /api/v1/live` returns `426`.
3. In browser developer tools, confirm the same-origin live connection upgrades;
   then perform a controlled non-production mutation and verify another open
   public page and another signed-in staff device refetch their matching APIs.
4. Interrupt the live connection and confirm the page reports no connection
   status, reconnects with bounded jitter, and still refreshes through
   five-second polling. Restore the connection and confirm polling slows to the
   30-second integrity interval.
5. Send a client frame in a controlled browser test and confirm the socket closes
   with code `1008`; ordinary clients never send frames.
6. With an unsaved non-destructive form on one device, mutate matching data on a
   second device and confirm the first device defers its queued refresh until the
   form is saved/reset. Separately verify staff deactivation and test-event
   deletion clear protected/participant rendering immediately instead of deferring.
7. On a browser with no saved registrations, search a controlled test
   participant by exact name, use **Add to My Ducks**, and confirm the action
   confirms in place and the **My Ducks** navigation appears. Then open
   `/my-ducks` and confirm the followed card shows the **Following** tag and the
   event's public display name with no staff lookup code, and that any group
   with no participants hides its whole section instead of showing an empty
   state.

Failure of this channel is degraded freshness, not lost race data. Operators may
continue only after the station's authoritative mutation response and refreshed
state are visible; the refresh signal itself is never proof of a saved command.

### Turnstile

Create a Turnstile widget restricted to `quickducks.com`. Although the site key
is public by Turnstile design, current production intentionally stores it as an
encrypted Worker secret alongside the secret key. Do not commit or print either
current value. Store both interactively so neither appears in a command argument:

```sh
npx wrangler secret put TURNSTILE_SITE_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
```

The registration page remains disabled if either value is absent, and the API
performs mandatory server-side Siteverify validation. Test a real successful
challenge and a rejected invalid token on the production hostname.

### Worker Runtime Secrets

The Worker needs the required encrypted secrets below. The two SMS secrets are
an optional pair: omit both while SMS is unprovisioned, or configure both with
the matching exact ARNs after registration and IAM setup.

| Worker secret | Source |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | Access key created for CloudFormation output `SesIamUser` |
| `AWS_SECRET_ACCESS_KEY` | Matching secret access key, available only at creation |
| `NOTIFICATION_HMAC_SECRET` | Independent random secret of at least 32 bytes for destination HMACs and unsubscribe capabilities |
| `SMS_ORIGINATION_IDENTITY` | Optional; full ARN of the registered AWS End User Messaging SMS toll-free identity |
| `SMS_OPT_OUT_LIST_NAME` | Optional; full ARN of the exact AWS-managed opt-out list associated with that identity |
| `TURNSTILE_SECRET_KEY` | Turnstile widget secret |
| `TURNSTILE_SITE_KEY` | Turnstile widget site key; intentionally encrypted in current production |

Create the IAM key only when the Worker integration is ready. On a trusted
workstation with `jq`, transfer the pair directly from AWS to Wrangler without
printing it or writing it to disk:

```sh
(
  set -euo pipefail
  credentials="$(aws iam create-access-key \
    --user-name quickducks-worker-ses \
    --output json)"
  trap 'unset credentials' EXIT
  printf '%s' "$credentials" | jq '{
    AWS_ACCESS_KEY_ID: .AccessKey.AccessKeyId,
    AWS_SECRET_ACCESS_KEY: .AccessKey.SecretAccessKey
  }' | npx wrangler secret bulk
)
```

If the bulk operation fails, immediately list and delete the newly created IAM
key before retrying; AWS will never show its secret value again. Never place
these runtime keys in `wrangler.jsonc`, `.dev.vars`, GitHub, logs, issues, or
release notes. Set the three notification values interactively with
`npx wrangler secret put`; never place them in a command argument. Confirm all
seven secrets with `npx wrangler secret list`, which
shows names but not values. Every release performs this name-only check before
CloudFormation, D1, or Worker mutation.

### DNS and Custom Domains

`wrangler.jsonc` declares Custom Domains for both `quickducks.com` and
`www.quickducks.com`. A Worker deployment creates their Cloudflare DNS records
and certificates when there are no conflicting records. The application treats
`APP_ORIGIN` as canonical and returns a permanent `308` from `www` while
preserving the path and query. Do not add an independent redirect rule that can
disagree with this behavior.

The Cloudflare zone must also contain the SES DKIM, MAIL FROM, SPF, and DMARC
records described above. Wait for both Custom Domain certificates to become
active. Follow the permanent-domain and NFC pre-provisioning gate in
[DOMAIN_SETUP.md](DOMAIN_SETUP.md) before writing any physical tag.

## Historical First Bootstrap

These checks were required before enabling continuous deployment. They are
historical bootstrap gates, not approval steps to repeat for every merge:

- The GitHub `production` environment allows only `main` and `v*`, disables
  administrator bypass, and contains the secret and repository variables
  described above. The original unattended bootstrap later gained James as the
  required deployment reviewer when the agent merge pipeline was enabled.
- Both configured role ARNs exactly match the bootstrap stack outputs.
- The AWS OIDC role trusts only this repository's `production` environment,
  the GitHub role controls only the named stack, and that stack records the
  dedicated CloudFormation execution role.
- The CloudFormation outputs match committed Wrangler variables.
- SES identity, DKIM, MAIL FROM, production access, and test delivery are ready.
- The D1 database and email queues exist in `CLOUDFLARE_ACCOUNT_ID`.
- The account supports Durable Objects and the deployment token can apply the
  committed `RaceUpdates` class migration.
- All existing migrations pass locally and production contains no manually
  modified schema that is absent from `db/migrations`.
- The Worker's seven encrypted runtime secret names exist.
- Both custom hostnames are active and Turnstile allows the production host.
- The reviewed change enabling `RaceUpdates` migration `v1` records that there
  is no rollback path to a pre-migration Worker and has a forward-fix recovery
  plan ready.

Run the credential-free release checks locally:

```sh
cfn-lint infra/aws/github-actions-bootstrap.yaml infra/aws/quickducks.yaml
actionlint
npm ci
npm audit --audit-level=high
npm run typecheck
npm test
npx playwright install chromium
npm run test:e2e
npm run wrangler:validate
npm run db:migrate:local
```

Do not use `npm run db:migrate:remote` or `npm run deploy` for a normal release;
the protected workflow owns those production operations.

## Continuous Deployment

Every protected merge to `main` is a production release. Ordinary versions need
no manual tag, but deployment requires production-environment approval:

1. A pull request passes the required credential-free `Validate` CI job. Review
   every D1 migration for compatibility with the old and new Worker, every
   Durable Object migration as a one-way declaration, and every CloudFormation
   change together with required manual platform work.
2. The reviewed pull request merges to `main`. Its push starts the release
   workflow directly; the workflow does not use `workflow_run` or inherit trust
   from the separate CI run.
3. The release checks out the exact 40-character event SHA with full history and
   tags and no persisted checkout credential. It requires a `push`, branch ref
   type, ref name exactly equal to the repository default branch, and checked-out
   HEAD equal to both the event SHA and the fetched default-branch tip. A stale
   queued `main` run fails rather than deploying an older source.
4. The version selector derives the automatic version strictly from existing
   tags. Among tags matching `v*.*.*`, malformed and noncanonical tags are
   ignored rather than trusted, valid prereleases are never automatic bases, and
   stable tags with build metadata contribute precedence only. If a
   highest-precedence stable tag already points to the source commit, it is
   reused for recovery; otherwise the highest stable version's patch is
   incremented exactly once. For example, the first new merge after `v1.1.0`
   releases as `v1.1.1`, even if a `v1.2.0-rc.1` prerelease was deployed in
   between. Missing stable tags, malformed SHAs, and Git errors fail closed. It
   does not use dates or run numbers and does not modify `package.json`.
5. Still without production credentials, the workflow repeats `npm ci`, the
   high-severity audit, TypeScript check, full tests, every Wrangler-config
   dry-run, and fresh local D1 migration validation. Only that successful job can
   unlock the `production` deployment job.
6. After James approves the `production` environment, the deployment refetches
   the default branch and fails if the validated SHA is no longer its current
   tip. It then verifies the exact account, region, stack and bootstrap role ARN
   shapes, all four Worker secret names, D1 legacy-role safety, the existing
   named CloudFormation stack, current Cognito outputs and `AppOrigin`, monotonic
   stack version, and source ancestry. It validates both templates, deploys
   CloudFormation with the dedicated execution role, verifies the result,
   applies D1 migrations, and deploys the Worker.
7. The workflow checks the D1-backed apex `/health` endpoint, exact `308` `www`
   redirect, and a real same-origin WebSocket connection under bounded timeouts.
8. Only after every deploy and smoke gate succeeds does the final job receive
   `contents: write`. It fails if the selected tag resolves to another commit,
   creates a missing automatic lightweight tag at the exact source SHA with the
   job-scoped `GITHUB_TOKEN` Git ref API, re-resolves it, and creates or updates
   the GitHub release. Generated notes target that exact SHA.

Tags created with the workflow's repository `GITHUB_TOKEN` do not start new
workflow runs under GitHub's current recursive-workflow prevention behavior, so
the automatic `v*.*.*` tag does not cause a second tag deployment. No tag is
created before deployment. The final writer rechecks the default-branch tip: if
another merge wins the narrow race after the post-approval deployment preflight,
the older run records that it was superseded without attempting a stale tag, and
the newer serialized run owns tag and release publication. If deployment fails first, rerunning validation sees
the unchanged previous stable tag and derives the same patch. If deployment
succeeds but tag creation or release publication is rejected, the final job
fails loudly and the state is forward-recoverable: a rerun of the same source
derives the same patch, passes the stack gate as a same-commit recovery, and
completes the missing tag and release idempotently, while the next merged
commit instead derives the same still-untagged patch, is allowed to claim it
because no tag ever published that version, and tags it at its own commit. The
skipped commit simply remains untagged; no release tag is ever moved.

### Intentional Major, Minor, and Prerelease Versions

An intentional major or minor release remains a reviewed protected tag on a
commit already in the default branch. The explicit tag may also be a canonical
prerelease or contain build metadata, for example `v2.0.0`, `v1.2.0`, or
`v2.0.0-rc.1`:

```sh
git tag -s v2.0.0 <reviewed-default-branch-commit>
git push origin v2.0.0
```

The tag push runs the same complete validation, deployment, ancestry, smoke, and
release gates but uses the explicit version and prerelease state. The single
FIFO production concurrency group serializes manual tag runs with automatic
`main` runs. Protect and review intentional major/minor tags; do not create a
manual patch tag for each ordinary merge. An explicit prerelease deployment
never joins the stable release train: automatic selection ignores prerelease
tags, and the next merge to `main` still derives one patch above the highest
stable tag and deploys even though its SemVer precedence is below the deployed
prerelease.

Do not pre-publish a release when GitHub immutable releases are enabled. Let the
workflow publish only after deployment; a published immutable release cannot be
updated on a rerun.

## Failure and Rollback

The production order is intentional:

1. CloudFormation update.
2. D1 migrations.
3. Worker deployment, including any new Durable Object class migration.
4. Apex, redirect, and WebSocket smoke tests.
5. Automatic tag creation when needed, then GitHub release publication.

If validation or environment configuration fails, production is unchanged. If
CloudFormation fails, AWS rolls back the stack update by default and D1 is
untouched. Inspect stack events before retrying; do not delete the retained,
deletion-protected identity resources.

If D1 migration fails, Wrangler rolls back the failing migration while retaining
previous migrations that completed successfully. The old Worker remains active,
but the AWS update and any earlier migrations may already be live. Fix forward
through a reviewed pull request and merge; never edit or renumber a migration
that production recorded.

If Worker deployment fails, the migrated database remains live with the old
Worker. This is why migrations must be backward compatible. Correct the Worker
or add a forward migration and release a new version.

After any `duck_photos` row has been created, do not roll back to a Worker from
before the required-photo workflow: that code can read the compatible schema and
delete rows through cascades, but it does not enforce the photo interlock or
render recovery. Use a forward fix. A pre-photo Worker is an acceptable rollback
target only when production inspection proves the table is empty and no intake
is in progress; retain migration `0024` either way.

If smoke tests fail after Worker deployment, stop normal releases and assess the
application before changing data. The first release that applies `RaceUpdates`
Durable Object migration `v1` cannot roll back to a Worker from before that
migration: no bridge deployment is implemented, and a pre-migration Worker does
not preserve the required exported class lifecycle. Recover that initial release
only by deploying a forward fix that retains the binding, class export, and
recorded migration.

After that lifecycle boundary, a compatible prior Worker version may be restored
from the Cloudflare dashboard's deployment history or, from an authenticated
administrator workstation:

```sh
npx wrangler rollback <known-good-worker-version-id>
```

A Worker rollback does not roll back D1, Durable Object class migrations,
queues, bindings, secrets, DNS, Cognito, IAM, or SES. Every rollback target must
therefore be from a deployment at or after `RaceUpdates` migration `v1`, retain
the recorded class lifecycle, and operate correctly with the current D1 schema.
While the email consumer and cron bindings are active, the target must also
export compatible `queue` and `scheduled` handlers; do not roll directly to a
pre-email Worker. Pause or remove the consumer through a reviewed deployment
before selecting such a target, then restore it only after a compatible forward
release. If no compatible target exists, fix forward. Never select code that
cannot operate on the current schemas and bindings.

If live updates fail while HTTP and D1 remain healthy, do not restore D1 or
alter race rows. Disconnected clients continue their five-second polling
fallback. Diagnose
the `RACE_UPDATES` binding, class export, `/api/v1/live` upgrade, and deployment
version, then deploy a compatible fix. Rolling back Worker code does not remove
the Durable Object migration.

D1 Time Travel is the emergency point-in-time recovery mechanism for production
databases on the supported backend. Record the incident timestamp and inspect a
bookmark first:

```sh
npx wrangler d1 time-travel info quickducks-prod --timestamp="<RFC3339-UTC>"
```

`time-travel restore` overwrites production and can discard legitimate writes
after the chosen time. It requires explicit incident approval, a recorded
bookmark, stopped writes where practical, and post-restore validation. It is
not part of an automatic release rollback.

To reverse an AWS configuration change, revert the template change, review the
resulting CloudFormation change set, and deploy a new version. Preserve Cognito
and SES identities unless an AWS incident procedure explicitly requires their
replacement. DNS, Turnstile, queue, and SES-account changes are manual platform
changes and must be rolled back through their platform audit history.

If only automatic tag or GitHub release publication fails after successful smoke
tests, production is already deployed and the failure is forward-recoverable.
When the default branch advanced during deployment and no exact tag exists, the
final writer exits successfully as superseded instead of requesting workflow
permission to tag the older workflow tree; the newer queued run owns publication.
Rerun the failed job or complete workflow while the source is still the
default-branch tip; it derives the same patch, and if the tag was already
created it must resolve to the same source and is reused. If a fix or ordinary
merge lands first instead, its run derives the same still-unpublished patch
version, the stack gate permits the deployed-but-untagged version to move to
that descendant commit, and the new run tags its own commit; the earlier commit
simply remains untagged. The stack version gate otherwise permits an exact
version only when its recorded commit also matches. D1 migrations are
idempotently skipped once recorded, and the release metadata block is updated
rather than duplicated. A release tag that resolves to another commit fails
closed and requires incident review, not tag movement.

For any failed production mutation or smoke test, stop merges and disable the
release workflow if more pushes may arrive. Record which CloudFormation, D1,
Worker, smoke, tag, and release stages completed before choosing a compatible
forward fix. Do not bypass validation, weaken the environment allowlist, move a
release tag, or enable administrator bypass to clear the queue.

## Credential Rotation and Recovery

- Rotate `CLOUDFLARE_API_TOKEN` by creating a new equally scoped token, replacing
  the GitHub environment secret, validating a controlled release, and then
  revoking the old token.
- Rotate the Worker IAM key by creating a second key, updating both AWS Worker
  secrets together with `wrangler secret bulk`, validating Cognito/SES behavior,
  then disabling and deleting the old key. IAM allows at most two active access
  keys for a user.
- Rotate the Turnstile secret in the Cloudflare dashboard and immediately
  replace `TURNSTILE_SECRET_KEY`; verify registration before revoking any grace
  secret offered by the platform.
- GitHub OIDC has no AWS key to rotate. Change repository/environment trust or
  role permissions only through a reviewed bootstrap-stack update, read both
  outputs again, update `AWS_DEPLOY_ROLE_ARN` and
  `AWS_CLOUDFORMATION_ROLE_ARN` together, and validate a controlled release.
  The environment change must be coordinated because it changes the exact OIDC
  subject.
- To suspend automation, disable the release workflow before changing IAM. Do
  not add a routine reviewer gate as a substitute for incident handling. Do not
  delete `quickducks-cloudformation-execution` while `quickducks-production`
  records it as the service role. CloudFormation cannot return that stack to caller
  credentials. First associate a reviewed replacement execution role or retire
  the application stack, then remove the old role. Delete the bootstrap stack
  only after confirming the GitHub OIDC provider is not shared and no stack
  references either role.
- Store registrar, GitHub, Cloudflare, and AWS account recovery codes in the
  organization's controlled recovery records, not in this repository.

## References

- [Domain and permanent NFC-origin gate](DOMAIN_SETUP.md)
- [GitHub OIDC for AWS](https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services)
- [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [CloudFormation service roles](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-iam-servicerole.html)
- [Cloudflare Workers GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)
- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Workers rollbacks](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
- [Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Queues configuration](https://developers.cloudflare.com/queues/configuration/configure-queues/)
- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Amazon SES production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
