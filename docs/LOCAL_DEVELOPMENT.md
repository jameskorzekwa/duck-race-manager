# Local development

Run the whole site — public pages, staff console, race-day stations, live
updates — on one machine with no network access, and fill it with realistic data
for any point in the race lifecycle.

```sh
npm ci
npm run dev:local                     # applies migrations, then serves http://localhost:8787
npm run seed:local -- --state=round-one   # in a second terminal
```

Open <http://localhost:8787>, then sign in at `/staff` and pick any account. No
password, no emailed code, no AWS, no Cloudflare account.

## What makes this work

Only two things in QuickDucks genuinely need the network: Cognito, which
authenticates staff, and Turnstile, which protects public registration. Local
development replaces exactly those two and nothing else.

`wrangler.local.jsonc` differs from `wrangler.jsonc` in four ways:

| | Production | Local |
| --- | --- | --- |
| `main` | `src/index.ts` | `src/local-dev.ts` |
| `APP_ORIGIN` | `https://quickducks.com` | `http://localhost:8787` |
| `COGNITO_DOMAIN` | the Cognito hosted UI | `http://localhost:8787` |
| `name` / `routes` | `quickducks`, both custom domains | `quickducks-local`, none |

The D1, Durable Object, queue, and rate-limiter bindings are identical, because
Wrangler simulates all four locally. Do not remove the `ratelimits` block from
the local config: `src/api.ts` reads that binding without an undefined guard, so
public search, follow, unfollow, duck naming, and self-service delete would throw.

`src/local-dev.ts` is never bundled into the deployed Worker — `wrangler.jsonc`
points `main` at `src/index.ts`, and a test asserts no deployed module imports it.
It supplies the two seams `createWorker` already accepts:

- a **token verifier** that reads a local bearer token instead of validating a
  Cognito JWT against a remote JWKS, and
- a **token fetch** that answers `/oauth2/token` and `/oauth2/revoke` in process.

It also serves a stand-in for the Cognito hosted UI at `/oauth2/authorize`, which
lists the staff accounts in the local database and lets you pick one.

Everything else is the real thing. Sign-in still runs the production PKCE flow,
sets the same `__Host-` cookies, refreshes the same way, and — crucially — still
requires an **active D1 staff profile with the right roles**. A local token for a
subject with no profile is refused, exactly as in production. Authorization
behaviour you observe locally is authorization behaviour you will get deployed.

### Everything local hangs off one predicate

`isLocalPreviewOrigin` in `src/local-preview.ts` is true only for an `http`
origin on `localhost`, `127.0.0.1`, or `[::1]`. Production configures
`https://quickducks.com`, so every local affordance is unreachable in production
by construction rather than by convention. Three behaviours depend on it:

1. **The canonical-origin redirect is skipped**, so `http://localhost:8787` is
   served instead of 308-redirected to production.
2. **Turnstile verification is waived** when no secret is configured, and the
   registration form renders as submittable. A deployment with no Turnstile keys
   still fails closed with `503`, exactly as before.
3. **Cognito staff provisioning is answered locally**, so adding, deactivating,
   and reactivating staff on `/staff/access` works offline. Every D1 write,
   guard, and audit row for those operations still runs for real; only the
   identity-provider call is replaced.

`src/local-preview.test.mjs` and `src/local-dev.test.mjs` pin all of this,
including that `wrangler.jsonc` still points at `src/index.ts` with an https
origin.

### Use `localhost`, not a hostname alias

Serve on `localhost` (or `127.0.0.1`) and browse the same one. Two reasons:

- The CSP sets `upgrade-insecure-requests`. Browsers skip the upgrade for
  loopback origins, but on any other http host — a LAN IP, or a `/etc/hosts`
  alias — every script, image, and fetch is rewritten to `https://` and the site
  breaks.
- `APP_ORIGIN` must match the origin in the address bar exactly.
  `http://localhost:8787` and `http://127.0.0.1:8787` are different origins, and
  the mismatch turns every staff mutation into a `403`.

Never point a `/etc/hosts` alias for `quickducks.com` at a local server. Your
browser has the production HSTS entry pinned and will silently force https.

## Seeding

`npm run seed:local` drives the running Worker over HTTP. Every row is produced by
the same handlers, guards, and idempotency rules that run in production, so a
seeded database is a state the application could actually have reached. Direct
inserts can express states the real workflow forbids, and then local testing
proves nothing.

The staff accounts are the one exception: `src/local-dev.ts` inserts them
directly, because provisioning a staff identity is precisely the operation that
belongs to Cognito. Everything downstream of sign-in goes through the API.

```sh
npm run seed:local -- --state=registration        # default
npm run seed:local -- --state=completed
npm run seed:local -- --state=round-one --participants=12 --heat-size=4
npm run seed:local -- --help
```

| `--state` | Public phase | What you get |
| --- | --- | --- |
| `empty` | Preparing | No event at all |
| `draft` | Preparing | A `DRAFT` event only staff can see |
| `registration` | Registration | Participants registered, two thirds paired with ducks |
| `closed` | Locked in | Everyone paired, heats filled and waiting |
| `round-one` | Racing | Heat 1 published, heat 2 on the water, heat 3 called |
| `final` | Racing | Finalists promoted, the final called |
| `completed` | Results | Full podium and public results |

QuickDucks holds one event dataset at a time, so every run force-deletes the
existing event first. That is the same administrator path used in production, so
it also exercises the delete.

The script prints the URLs and codes you need: a duck tag URL for the `/t/:token`
scan flow, a duck number for `/duck/:number`, a participant's private status link,
lookup codes for staff search and pairing, and the sign-in accounts.

### The seeded accounts

One administrator plus one single-role account per operational role, so any
role-gated surface can be opened as an actor holding exactly the role under test.

| Email | Access |
| --- | --- |
| `admin@quickducks.local` | Administrator |
| `director@quickducks.local` | `RACE_DIRECTOR` |
| `registration@quickducks.local` | `REGISTRATION` |
| `ducks@quickducks.local` | `DUCK_MANAGER` |
| `announcer@quickducks.local` | `ANNOUNCER` |
| `heats@quickducks.local` | `HEAT_RUNNER` |
| `results@quickducks.local` | `RESULT_TAKER` |

`POST /__local/staff` creates them and returns a bearer token for each, which is
what the seeding script uses and what you want for `curl` or an automated test:

```sh
TOKEN=$(curl -s -X POST http://localhost:8787/__local/staff | jq -r '.accounts[0].token')
curl -s -H "authorization: Bearer $TOKEN" http://localhost:8787/api/v1/staff/events
```

## Resetting

```sh
npm run seed:local -- --state=empty   # clear race data through the application
npm run db:reset:local                # delete the simulated database and reapply migrations
```

Use the first for data and the second for schema — after a new migration lands,
or when a local database drifted while a migration was being written.

## What is still not local

- **Outbound email.** The queue producer runs, but there is no consumer and no
  SES path in any environment, so nothing sends.
- **Real NFC writing.** `/staff/inventory-intake` needs Web NFC on Android
  Chrome. The station's HTTP API works locally, and the seeding script uses it to
  create tags, so every downstream page — `/t/:token`, pairing, staff duck
  inspection — is fully testable without hardware.
- **Cloudflare Web Analytics**, which is injected at the edge after the Worker
  responds.

## Verifying UI changes

Real browser verification is expected for any UI change. Point it at the local
site and check console errors and horizontal overflow at 320, 390, 768, and
1280 px. Seed the state the change affects rather than trusting a mock — the
lifecycle phase determines navigation, calls to action, and whole page bodies.
