# QuickDucks Infrastructure, Deployment, and Releases

## Production Services

| Service | Resource | Management path |
| --- | --- | --- |
| Source and releases | `jameskorzekwa/duck-race-manager` | GitHub |
| Canonical origin | `https://quickducks.com` | Cloudflare DNS and Worker Custom Domain |
| Redirect origin | `https://www.quickducks.com` | Worker Custom Domain; application returns `308` |
| Web and API | Cloudflare Worker `quickducks` | `wrangler.jsonc` and tagged releases |
| Database | Cloudflare D1 `quickducks-prod` | Wrangler and `db/migrations` |
| Live refresh fan-out | Durable Object class `RaceUpdates`, binding `RACE_UPDATES` | Wrangler class migration and Worker deployment |
| Public search limit | Workers binding `PUBLIC_SEARCH_RATE_LIMITER` | `wrangler.jsonc` |
| Email producer | Cloudflare Queue `quickducks-email` | Wrangler and `EMAIL_QUEUE` binding |
| Email dead-letter queue | Cloudflare Queue `quickducks-email-dlq` | Wrangler; connect when a queue consumer is deployed |
| Staff identity | Cognito user pool `quickducks-staff` in `us-east-1` | CloudFormation |
| Transactional email identity | Amazon SES identity `quickducks.com` in `us-east-1` | CloudFormation plus DNS |
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
  versions or remove the boundary. The boundary fixes effective SES access to
  `SendEmail` and `SendRawEmail` on only the `quickducks.com` identity and
  staff-administration access to only the production Cognito pool.
- The Worker's runtime AWS key pair and both Turnstile keys exist only as
  encrypted Cloudflare Worker secrets. They are not GitHub Actions secrets and
  the release does not replace them.
- All third-party actions are pinned to full commit SHAs. The adjacent version
  comment is informational; review and repin the SHA when upgrading an action.
- Workflow permissions are job-scoped. Only the deployment job can request an
  OIDC token and only the final job can write a GitHub release.
- Production releases use one concurrency group with `queue: max`. Up to 100
  tag runs wait FIFO, execute one at a time, and are not canceled in progress.
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
npm run wrangler:validate
npm run db:migrate:local
```

`npm ci` installs exactly `package-lock.json`; the audit fails on high or
critical known vulnerabilities. The TypeScript command performs a no-emit
strict check. The test command runs every `src/*.test.mjs` file. The Wrangler
validation script discovers every non-example `wrangler*.json`,
`wrangler*.jsonc`, or `wrangler*.toml` outside generated directories and
dry-runs each entry without uploading it; currently only `wrangler.jsonc`
matches. The D1 command applies
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

## GitHub Production Configuration

Create a GitHub environment named exactly `production`. Configure:

- One or more required reviewers who understand the CloudFormation and D1
  changes in the release. This solo-maintainer repository currently requires
  James's approval and allows self-review; enable **Prevent self-review** after
  adding another eligible reviewer so releases do not deadlock.
- No administrator bypass, where the repository plan supports it.
- A deployment tag rule allowing only `v*` tags. The workflow performs an
  additional semantic-version check.
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

The first-time setup order is:

1. Create and protect the exact GitHub `production` environment.
2. Deploy and review the AWS bootstrap stack.
3. Set both role-output variables and the remaining repository variables.
4. Deploy or update `quickducks-production` with the execution-role output.
5. Copy the application outputs into the committed Worker configuration.
6. Complete the Cloudflare, D1, queue, DNS, SES, Turnstile, and Worker-secret
   gates below before creating a release tag.

Protect semantic-version tags with a repository ruleset. Limit tag creation and
updates to release maintainers, block force updates and deletion, and configure
the required signed-tag policy. The workflow fetches full history and
independently requires the peeled tagged commit to be an ancestor of the
repository default branch before the production environment can be approved.
Tag signatures and tag-rule enforcement remain repository/release-maintainer
controls; the workflow does not claim to verify signature trust.

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
tag. The first automated release may add both. Every later tag must have greater
SemVer precedence than the stack's normalized `Version`; an exact same version
is permitted only when `Commit` is also the same peeled tagged commit, for a
recovery rerun. A lower version, an equal-precedence version with different
build metadata, a same version at another commit, or a stack with `Commit` but
no `Version` is rejected before CloudFormation deployment.
For every higher version, the recorded commit must also exist in the full
checkout and be an ancestor of the incoming tagged commit. A missing recorded
object, shallow/incomplete history, older source commit, divergent history, or
Git ancestry error fails closed. Only the first release, where both stack tags
are absent, has no prior ancestry to prove.

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

The current Worker sends notification IDs to `quickducks-email` through the
`EMAIL_QUEUE` producer binding. A queue consumer is not currently declared in
`wrangler.jsonc`; therefore the DLQ is not connected by the current deployment.
When a consumer handler is implemented, add a `queues.consumers` entry with
`dead_letter_queue: "quickducks-email-dlq"`, retry limits, and tests in the same
change. Do not claim email delivery is operational until that consumer and SES
send path pass an end-to-end test.

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
from the fixed `all`, `event`, `participants`, `ducks`, `heats`, `returns`,
`staff`, and `support` allowlist. The frame contains no authoritative race data,
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

The shared browser hub defers ordinary refreshes while a form, scan, NFC write,
result selection, or command is dirty/in flight. Purge's `all` signal clears
rendered main content and server-reloads without deferral. A `staff` signal calls
the PII-free `/api/v1/staff/session` projection; deactivation or reduced access
clears protected rendering and navigates/reloads immediately. These behaviors
are application safety rules, not WebSocket authorization; every API refetch
still authenticates and authorizes independently.

Operator smoke checks after deployment:

1. Load `/` and confirm the live board reaches `Updated just now` even when no
   event or heat exists.
2. Confirm an ordinary non-upgrade `GET /api/v1/live` returns `426`.
3. In browser developer tools, confirm the same-origin live connection upgrades;
   then perform a controlled non-production mutation and verify another open
   public page and another signed-in staff device refetch their matching APIs.
4. Interrupt the live connection and confirm the page reports delayed updates,
   reconnects with bounded jitter, and still refreshes through five-second
   polling. Restore the connection and confirm polling slows to the 30-second
   integrity interval.
5. Send a client frame in a controlled browser test and confirm the socket closes
   with code `1008`; ordinary clients never send frames.
6. With an unsaved non-destructive form on one device, mutate matching data on a
   second device and confirm the first device defers its queued refresh until the
   form is saved/reset. Separately verify staff deactivation and test-data purge
   clear protected/participant rendering immediately instead of deferring.

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

The Worker needs this exact encrypted-secret set:

| Worker secret | Source |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | Access key created for CloudFormation output `SesIamUser` |
| `AWS_SECRET_ACCESS_KEY` | Matching secret access key, available only at creation |
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
release notes. Confirm all four secrets with `npx wrangler secret list`, which
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

## First Deployment

Before creating the first version tag, verify all of the following manually:

- The GitHub `production` environment, reviewer rule, secret, and repository
  variables are configured.
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
- The Worker's four encrypted runtime secret names exist.
- Both custom hostnames are active and Turnstile allows the production host.
- The reviewer accepts that the first deployment of `RaceUpdates` migration
  `v1` has no rollback path to a pre-migration Worker and has a forward-fix
  recovery plan ready.

Run the credential-free release checks locally:

```sh
cfn-lint infra/aws/github-actions-bootstrap.yaml infra/aws/quickducks.yaml
actionlint
npm ci
npm audit --audit-level=high
npm run typecheck
npm test
npm run wrangler:validate
npm run db:migrate:local
```

Do not use `npm run db:migrate:remote` or `npm run deploy` for a normal release;
the protected workflow owns those production operations.

## Release Procedure

Releases are triggered only by a canonical, `v`-prefixed semantic-version tag
such as `v1.2.3`, `v1.2.3-rc.1`, or `v1.2.3-alpha-beta+build-1`. Validation runs
the locked direct `semver` dependency after `npm ci`; it rejects numeric
prerelease identifiers with leading zeroes, emits the normalized version without
`v`, and emits an exact prerelease boolean. A hyphen inside a valid identifier is
accepted, and build metadata alone does not mark a release as prerelease.
Publishing a GitHub release without pushing a matching tag does not deploy
production.

1. Merge the release commit through the protected default branch and wait for
   CI to pass.
2. Review every new D1 migration for forward compatibility with both the old
   and new Worker versions, and review every Wrangler Durable Object migration
   as a one-way platform schema declaration.
3. Review the CloudFormation diff and confirm required manual DNS or SES work
   is already complete.
4. Create a signed version tag on the reviewed commit, as required by repository
   policy, and push it:

   ```sh
   git tag -s v1.2.3 <reviewed-commit-sha>
   git push origin v1.2.3
   ```

5. The unprivileged release job checks out full history, proves the peeled tag
   commit is on the current default branch, then repeats the locked install,
   SemVer validation, dependency audit, TypeScript check, full tests, every
   Wrangler-config dry-run, and fresh local D1 migration validation.
6. A production reviewer checks the exact tag, commit, normalized version,
   workflow diff, CloudFormation change, and migrations, then approves the
   environment gate. For the first `RaceUpdates` release, approval explicitly
   accepts the pre-migration rollback boundary and forward-fix-only recovery.
7. Before mutation, the deployment job verifies the exact account, region,
   stack and bootstrap role ARN shapes, all four Worker secret names, D1
   legacy-role safety, the existing named CloudFormation stack, current Cognito
   outputs and `AppOrigin`, monotonic stack version, and that the recorded stack
   commit is an available ancestor of the incoming commit. It validates both
   templates, deploys the application stack with
   `--role-arn "$AWS_CLOUDFORMATION_ROLE_ARN"`, verifies it again, applies D1
   migrations, and deploys the Worker.
8. The workflow checks the D1-backed apex `/health` endpoint, requires an exact
   `308` redirect from `www`, and opens then cleanly closes a real WebSocket at
   `wss://<production-host>/api/v1/live` with exact `Origin: PRODUCTION_URL`, all
   under bounded timeouts.
9. Only after every smoke test passes, the workflow creates or updates the
   GitHub release with version, commit, timestamp, URL, Worker version, D1,
   CloudFormation stack, region, workflow-run information, and the validated
   prerelease state.

Do not pre-publish a release when GitHub immutable releases are enabled. Let the
tag workflow create the release after deployment; a published immutable release
cannot be updated on a rerun.

## Failure and Rollback

The production order is intentional:

1. CloudFormation update.
2. D1 migrations.
3. Worker deployment, including any new Durable Object class migration.
4. Apex, redirect, and WebSocket smoke tests.
5. GitHub release publication.

If validation or environment approval fails, production is unchanged. If
CloudFormation fails, AWS rolls back the stack update by default and D1 is
untouched. Inspect stack events before retrying; do not delete the retained,
deletion-protected identity resources.

If D1 migration fails, Wrangler rolls back the failing migration while retaining
previous migrations that completed successfully. The old Worker remains active,
but the AWS update and any earlier migrations may already be live. Fix forward
with a new migration and a new version tag; never edit or renumber a migration
that production recorded.

If Worker deployment fails, the migrated database remains live with the old
Worker. This is why migrations must be backward compatible. Correct the Worker
or add a forward migration and release a new version.

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
If no such target exists, fix forward. Never select a pre-migration Worker or
code that cannot operate on the current schemas.

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

If only GitHub release publication fails after successful smoke tests,
production is already deployed. Re-run the failed release job or the workflow
for the same tag only after confirming the tag still resolves to the same
commit. The stack version gate permits that exact version only when its recorded
commit also matches. D1 migrations are idempotently skipped once recorded, and
the release metadata block is updated rather than duplicated.

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
- To suspend automation, disable the release workflow or production environment
  approvals before changing IAM. Do not delete
  `quickducks-cloudformation-execution` while `quickducks-production` records it
  as the service role. CloudFormation cannot return that stack to caller
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
