# QuickDucks Infrastructure

## Production Services

| Service | Resource |
| --- | --- |
| Canonical domain | `quickducks.com` |
| Source | `jameskorzekwa/duck-race-manager` |
| Web/API | Cloudflare Worker `quickducks` |
| Database | Cloudflare D1 `quickducks-prod` |
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
```

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
