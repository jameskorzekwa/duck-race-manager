# QuickDucks Infrastructure

## Production Services

| Service | Resource |
| --- | --- |
| Canonical domain | `quickducks.com` |
| Source | `jameskorzekwa/duck-race-manager` |
| Web/API | Cloudflare Worker `quickducks` |
| Database | Cloudflare D1 `quickducks-prod` |
| Public name-search protection | Workers Rate Limiting binding `PUBLIC_SEARCH_RATE_LIMITER` |
| Email queue | Cloudflare Queue `quickducks-email` |
| Dead-letter queue | Cloudflare Queue `quickducks-email-dlq` |
| Staff identity | Amazon Cognito user pool `quickducks-staff` in `us-east-1` |
| Staff login | Invite-only passwordless email OTP |
| Transactional email | Amazon SES identity `quickducks.com` in `us-east-1` |

Porkbun remains the registrar. Cloudflare is the authoritative DNS provider
after the domain's nameservers are changed to the assigned Cloudflare pair.

## Credentials

Do not commit credentials. Local administration uses browser-authenticated AWS
CLI and Wrangler sessions. Runtime AWS access is a least-privilege IAM user that
can send only from the QuickDucks SES identity; its key is stored only as
encrypted Cloudflare Worker secrets.

Expected Worker secrets:

```text
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
TURNSTILE_SECRET_KEY
```

The public Turnstile site key is the non-secret Worker variable
`TURNSTILE_SITE_KEY`. The registration page remains visibly disabled unless
that variable exists, and the registration API independently fails closed until
the encrypted `TURNSTILE_SECRET_KEY` exists.

Staff sign-in uses Cognito managed login with the OAuth authorization-code flow,
PKCE `S256`, and a random state value. The Worker exchanges the callback code
server-side, verifies the access token and matching `staff_profiles` row, and
stores only the short-lived access token in the host-only
`__Host-quickducks_staff` cookie. The cookie is `Secure`, `HttpOnly`, and
`SameSite=Lax`; no refresh token is retained, so staff sign in again after the
one-hour Cognito access token expires.

Automatic Workers invocation logs are disabled in Wrangler because Cloudflare
fetch-event logs include request URLs. QuickDucks private status credentials are
URL path segments and must not be persisted in observability data. Application
logging must likewise exclude request bodies, names, contact details, private
tokens, lookup codes, and tag tokens.

## AWS Deployment

```sh
aws cloudformation deploy \
  --region us-east-1 \
  --stack-name quickducks-production \
  --template-file infra/aws/quickducks.yaml \
  --capabilities CAPABILITY_NAMED_IAM
```

The stack creates Cognito, SES identity, and the least-privilege IAM user. It
does not create an IAM access key. Access keys are generated only when the
Worker email integration is ready and are transferred directly into encrypted
Cloudflare secrets without committing or logging them.

## Cloudflare Deployment

`wrangler.jsonc` is generated from `wrangler.example.jsonc` after AWS and D1
resource IDs exist.

```sh
npm install
npm run check
npm run db:migrate:remote
npm run deploy
```

## DNS Records

Cloudflare must contain:

- The Worker Custom Domain for `quickducks.com`
- Three SES Easy DKIM CNAME records emitted by the AWS stack
- `mail.quickducks.com` MX record pointing to the SES feedback endpoint
- `mail.quickducks.com` SPF TXT record
- `_dmarc.quickducks.com` DMARC TXT record

Production NFC tags must not be written until the custom domain, Cognito
callback, SES identity, and offline tag route have passed the pre-provisioning
gate in [DOMAIN_SETUP.md](DOMAIN_SETUP.md).
