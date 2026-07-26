# Domain and Hosting Setup

## Purpose

The purchased domain will identify the deployed Duck Race Manager website. It
does not point directly to the GitHub repository. GitHub stores the source code;
Cloudflare Workers runs the application.

The only expected recurring fixed infrastructure cost is domain registration,
as long as the application remains within the Cloudflare free-tier limits.
Transactional race email is usage-based and is expected to cost only cents per
event at the planned volume.

## Canonical Domain Design

Use one permanent production origin for public pages, staff pages, APIs, and
NFC tag URLs:

```text
https://example.org/
https://example.org/register
https://example.org/results
https://example.org/staff
https://example.org/t/<random-tag-token>
```

Replace `example.org` after the domain is purchased.

Using one origin is intentional. It lets iPhone NFC links open the same origin
where staff are logged in, lets one service worker handle offline tag routes,
and avoids redirect and cross-domain cookie failures during race operations.
The continuous inventory intake station is intentionally online-only and does
not use a service worker or offline command queue.

The `www` hostname should redirect to the canonical hostname. If `example.org`
is canonical, production tags must contain `https://example.org/t/<token>` and
must never contain `https://www.example.org`, a `workers.dev` address, or a
staging hostname.

Optional non-production hostname:

```text
https://staging.example.org
```

No physical production tag may ever be written with the staging hostname.

## Free and Paid Components

| Component | Expected cost |
| --- | --- |
| Cloudflare Workers hosting | Free within plan limits |
| Cloudflare static assets | Free within plan limits |
| Cloudflare D1 database | Free within plan limits |
| Cloudflare Access | Free within the selected plan limits |
| Cloudflare Turnstile | Free |
| Cloudflare-managed TLS certificate | Free |
| Domain registration and renewal | Paid annually |
| Cloudflare Queues for email jobs | Free within plan limits |
| Amazon SES transactional email | Usage-based; expected to cost cents per event |

Free-tier usage must be monitored during rehearsal and race day. If expected
traffic approaches a hard free limit, upgrade for the event period rather than
risk rejected requests.

## Domain Purchase

Cloudflare Registrar is the simplest option because a domain purchased there
automatically uses Cloudflare authoritative DNS. A domain purchased from
another registrar also works, but its nameservers must be changed to the pair
assigned by Cloudflare.

Selection requirements:

- Short enough for permanent NFC URLs
- Easy to say and type
- Owned by the race organization rather than an individual volunteer when
  possible
- Automatic renewal enabled
- Multi-factor authentication enabled on the registrar and Cloudflare accounts
- Recovery codes stored with the organization's operational records

The domain must be treated as permanent infrastructure. Losing it would break
every NFC tag that contains it.

## Add an Externally Purchased Domain to Cloudflare

Skip this section if the domain is purchased through Cloudflare Registrar.

1. Create or sign in to the organization's Cloudflare account.
2. Add the apex domain as a new Cloudflare zone on the Free plan.
3. Review imported DNS records, especially any email records.
4. If DNSSEC is currently active at the registrar, disable it before changing
   nameservers.
5. Replace the registrar's nameservers with the two assigned by Cloudflare.
6. Wait until Cloudflare marks the zone active.
7. Re-enable DNSSEC through Cloudflare and publish the new DS record at the
   registrar when instructed.
8. Confirm the domain resolves before deploying the application.

Changing nameservers while an old DNSSEC delegation remains active can make the
domain unreachable, so that transition must not be skipped.

## Connect the Worker

Cloudflare Workers Custom Domains are preferred because the Worker is the
application origin. Cloudflare creates the DNS record and certificate for the
custom domain automatically.

After the production Worker exists:

1. Open Cloudflare **Workers & Pages**.
2. Select the production Worker.
3. Open **Settings**, then **Domains & Routes**.
4. Select **Add**, then **Custom Domain**.
5. Enter the canonical domain, such as `example.org`.
6. Wait for DNS and certificate activation.
7. Configure a redirect from `www.example.org` to `example.org` if desired.

The same setting will eventually be represented in `wrangler.jsonc`:

```jsonc
{
  "routes": [
    {
      "pattern": "example.org",
      "custom_domain": true
    }
  ]
}
```

The actual domain should be committed only after it is selected. Environment
configuration must also define one authoritative production origin used when
generating tag URLs, QR codes, registration links, and security checks.

## Staff Protection

Public routes remain accessible:

```text
/
/register
/results
/t/*
```

Amazon Cognito authentication protects staff pages and staff APIs:

```text
/staff/*
/auth/callback
/api/v1/staff/*
```

Cognito establishes staff identity. The Worker verifies each access token and
requires a matching staff profile for every protected read or mutation. The
profile's administrator flag separately protects complete-race purge. Browser
sign-in uses authorization code plus PKCE; the resulting access token is held
in a host-only, `Secure`, `HttpOnly`, `SameSite=Lax` cookie. Cookie-authenticated
staff mutations also require an exact same-origin `Origin` header.

The public `/t/<token>` GET route never mutates race data. A logged-in staff
page submits a separate authenticated POST command after resolving a scanned
tag. Anonymous unpaired tags redirect to `/`; anonymous paired tags open public
race status. The staff application uses the protected duck endpoint to choose
pairing or inspection after verifying the Cognito access token.

The protected `/staff/inventory-intake` page is available only to duck managers,
race directors, and system administrators. It provisions blank writable NDEF
stickers and has no desktop, pasted-token, or manual-number fallback. Android
Web NFC requires current Android Chrome, a secure HTTPS context, an NFC-capable
device, a top-level visible page, and a user gesture. The operator selects the
race and optional station location, presses Start once, and then taps one blank
sticker per duck without entering per-duck data.

The server generates the duck UUID, next globally unique internal number, and
cryptographically random 32-byte base64url token. The browser writes only the
exact configured-origin `https://quickducks.com/t/<token>` URL. Web NFC
`write()` resolution is the physical-write verification used for activation;
the station does not call `makeReadOnly`, so tags remain writable for controlled
replacement. Query strings, fragments, credentials, alternate origins, and
redirected hostnames are rejected when an existing QuickDucks URL is scanned.

Provisioning requires live staff authentication, same-origin mutation
protection, and live API connectivity. A server-side `NEW`/`NEEDS_TAG` duck and
`RESERVED` tag survive reload or a failed write but are not event-reserved or
publicly active. Confirmation after a successful write atomically marks the duck
good and race-reserved, activates the tag, and creates intake history. The
current actor recovers that pending record and must retap the same sticker;
QuickDucks never allocates another while it remains pending. There is no offline
queue or service-worker retry. NFC hardware serials are used only for transient
in-memory debouncing and are never persisted, transmitted, displayed, logged,
or used as duck identity.

## GitHub Configuration

The GitHub repository remains at:

```text
https://github.com/jameskorzekwa/duck-race-manager
```

After the production deployment is working, set the repository's **Website**
field to the canonical application URL. Do not configure the production domain
as a GitHub Pages domain; this application requires Workers, D1, authentication,
and server-side commands.

## Pre-Provisioning Gate

Do not write production NFC tags until all checks pass:

- Domain registration and automatic renewal are confirmed.
- The Cloudflare zone is active.
- The production Worker is deployed on the custom domain.
- HTTPS certificates are active and renew automatically.
- The canonical domain opens on supported iPhones and Android phones.
- `/t/<test-token>` is served directly without changing origins.
- Staff login and role checks work on the canonical origin.
- Android Chrome can start the protected provisioner from one user gesture in a
  top-level visible HTTPS page and keep scanning for repeated physical taps.
- A blank writable NDEF test sticker receives the exact canonical URL, activates
  only after `write()` resolves, and remains writable for controlled replacement.
- Reloading or losing connectivity with a pending sticker recovers the same URL
  for the same actor and event without allocating another duck.
- A canonical URL already assigned to different or unknown inventory is rejected
  without being overwritten; there is no desktop/manual fallback.
- iPhone background scanning opens the test tag correctly.
- The PWA has been installed or cached and handles a tag route during a planned
  connectivity outage.
- QR fallback opens the identical canonical URL.
- Registrar and Cloudflare recovery access is documented.

Only after this gate passes should the system generate and write permanent
production tag tokens.

## Domain Change Policy

After production tags are written, the canonical tag origin and `/t/<token>`
path contract are permanent. The application may move to another hosting
provider later, but the organization must retain the domain and continue
serving those URLs.

If branding changes, add new public domains that redirect to the canonical
origin. Do not replace or retire the domain embedded in the tags.

## References

- [Cloudflare Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
- [Cloudflare full DNS setup](https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/)
- [Cloudflare Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/)
