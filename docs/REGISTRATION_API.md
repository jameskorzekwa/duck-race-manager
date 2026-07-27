# Registration API

The versioned JSON API is independent of the public UI. All endpoints are
same-origin under `https://quickducks.com/api/v1` and return `Cache-Control:
no-store`.

## Current Event

```http
GET /api/v1/events/current
```

The response contains either the highest-priority non-archived event or
`{"event":null}`. Public event fields include the event ID, slug, name, date,
timezone, lifecycle status, registration window, and whether email is
required.

## Create Registration

```http
POST /api/v1/registrations
Content-Type: application/json
```

Example request:

```json
{
  "eventId": "event-id",
  "commandId": "client-generated-uuid-v4",
  "privateToken": "client-generated-256-bit-base64url-token",
  "firstName": "Daisy",
  "lastName": "Duck",
  "email": "daisy@example.com",
  "phone": null,
  "emailNotificationsEnabled": true,
  "turnstileToken": "turnstile-response-token",
  "clientTimestamp": "2026-07-26T00:00:00.000Z"
}
```

The client generates and retains both `commandId` and `privateToken` before
sending. The private token must contain at least 256 bits of randomness and be
encoded as unpadded base64url. The server stores only its SHA-256 hash.

The command UUID makes retries idempotent. A retry with the same command and
private token returns the original registration without consuming another
Turnstile token or creating duplicate records. Reusing a command UUID with a
different private token returns `409`.

Successful response:

```json
{
  "registrationId": "registration-id",
  "status": "SUBMITTED",
  "lookupCode": "ABCD2345",
  "privateStatusPath": "/r/private-token",
  "replayed": false
}
```

Registration creation writes the command, registration, stable race entry,
and audit event in one D1 batch. No duck or heat is assigned at submission.
Registration does not ask whether a participant plans to keep or return a duck.
The legacy `race_entries.duck_keep_preference` column remains for database
compatibility, receives its existing default for new rows, and is not read,
written explicitly, or exposed by the application. Existing stored values are
ignored.

Public registration fails closed unless:

- the event is `REGISTRATION_OPEN` and inside its configured time window;
- required names and event-specific email policy pass validation;
- the request is same-origin when an `Origin` header is present; and
- server-side Turnstile verification succeeds.

## Private Registration Status

```http
GET /api/v1/registrations/{privateToken}
```

The high-entropy token is the authorization credential. The response includes
participant name, registration status, staff lookup code, and event details.
Email and phone remain staff-only and are not returned, even with the private
token. Never place this endpoint or its response in analytics, application
logs, public links, or search indexes.

The short lookup code is for staff search only and must never authorize this
endpoint.

## Public Duck Lookup

```http
GET /api/v1/ducks/{permanentTagToken}
```

An unassigned, retired, unknown, or purged token returns the same `HOME`
destination and no inventory metadata. An actively assigned token returns a
`RACE_STATUS` destination with privacy-filtered event, visible duck, assigned
heat, currently running heat, and finalized progression/result fields. It never
returns contact information, lookup codes, private links, staff history,
synchronization details, or physical location.

## Browser Registration Collection

```http
GET /api/v1/registrations/mine
```

Registration responses issue one opaque `__Host-` prefixed, `HttpOnly`,
`Secure`, `SameSite=Lax` browser-collection cookie. The cookie resolves
server-side to every independent registration created from that browser,
allowing one phone to retain many participant names, lookup codes, and race
statuses across refreshes. Successful reads renew its server-side expiry. The
cookie contains no participant data or private status tokens.

## Public Name Search

```http
GET /api/v1/race-status/search?eventId={eventId}&name={name}
```

Anonymous search accepts exact first names, last names, or full names only.
Submitted entries may return
`AWAITING_DUCK_PAIRING`; assigned entries return public race status. Results
obey the event public-name policy. Email, phone, lookup code, private link,
staff data, inventory state, and location are never returned.
The production Worker rate-limits name search to 20 requests per minute per
event and client network key.

Authenticated staff use a separate event-scoped code, name, phone, or email
search and may see the full name, email, and phone required for registration
operations.

## Staff Scan and Pairing

```http
GET  /api/v1/staff/ducks/{tagToken}
GET  /api/v1/staff/registrations/search?eventId={eventId}&q={codeOrName}
POST /api/v1/staff/ducks/{tagToken}/assignments
```

Staff endpoints require a verified Cognito access token whose subject maps to
a matching `staff_profiles` row. Staff search may return full participant name,
email, phone, lookup code, registration state, and assigned duck. The pairing
command is idempotent and atomically creates the event reservation, versioned
duck assignment, registration transition, inventory transition, audit, and
immediate-mode heat entry when applicable.

Browser staff sessions use separate `Secure`, `HttpOnly`, `SameSite=Lax`,
host-only access and refresh cookies created only after Cognito authorization-
code, state, and PKCE checks. Access and ID tokens are valid for at most 15
minutes. The browser silently rotates both cookies within Cognito's absolute
seven-day refresh-token validity; rotation does not extend the seven-day session.
The refresh token is never returned to JavaScript or stored in response bodies,
URLs, logs, or D1. Cognito `400`/`401` refresh rejection or a malformed successful
response clears both cookies. Network failures, `408`, `429`, and `5xx` responses
preserve the existing refresh cookie unchanged for a later retry. Cookie-
authenticated mutation requests require the exact application origin. Explicit
Bearer access tokens remain supported for trusted API clients and are never
refreshed.

`POST /staff/logout` requires an exact application `Origin`, with a strict
same-origin `Referer` fallback only when `Origin` is absent. Rejected requests do
not revoke or clear anything. Accepted logout best-effort revokes the refresh
token, clears both cookies, and redirects through Cognito even when revocation
has a network failure or non-2xx response. This local-logout availability
tradeoff leaves a copied access token with at most 15 minutes of residual
validity: offline JWT verification does not observe Cognito revocation
immediately. Every authenticated request still reloads the live
`staff_profiles.is_active` value from D1, so deactivation fails closed
immediately; Cognito revocation and global sign-out prevent future refresh.

## Staff Access Administration

```http
GET  /api/v1/staff/profiles
POST /api/v1/staff/profiles
```

Both routes require a verified system-administrator profile. Listing returns
staff email, display name, role, and creation time but never the Cognito subject
or AWS details. Creation accepts an idempotent command UUID, email, display
name, and either `STAFF` or `ADMIN`. It creates or safely resumes a passwordless
Cognito identity, writes the matching D1 authorization profile, and retains an
administrator access audit. Regular staff cannot list or grant access.

## Return Review and Purge Readiness

```http
GET  /api/v1/staff/events/return-review
POST /api/v1/staff/ducks/{tagToken}/dispositions
POST /api/v1/staff/events/{eventId}/ducks/{visibleNumber}/dispositions
POST /api/v1/staff/events/{eventId}/purge-ready
POST /api/v1/staff/events/{eventId}/purge-ready/cancel
```

After racing reaches `COMPLETED`, authenticated staff scan each physical duck
and record `RETURNED`, `QUARANTINED`, `DAMAGED`, `RETIRED`, `KEPT`, `MISSING`,
or `UNACCOUNTED_FOR`. The idempotent command atomically records or explicitly
corrects the event disposition, closes the active assignment, releases the
event reservation, updates inventory, writes an audit event, and moves the
event into `RETURN_PROCESSING`.
The event-scoped visible-number route supports located ducks without a readable
tag and ducks that must be marked missing or unaccounted for because they cannot
be physically scanned.

The staff return-review panel reports counts and unresolved gates. A system
administrator must acknowledge both the completed physical review and
permanent deletion before marking an event `ARCHIVED`. The transition is
blocked by unresolved dispositions, unreleased reservations, active
assignments, running heats, or heats awaiting results. `ARCHIVED` is read-only;
an administrator can reopen `RETURN_PROCESSING` only with a recorded correction
reason.

## Complete Race Purge

```http
POST /api/v1/staff/events/{eventId}/purge
```

Purge requires a system administrator, purge-ready event state, no other event
dataset, a physical disposition for every event duck, and an exact typed
confirmation. It transactionally deletes browser links, heats, results,
assignments, registrations, commands, audits, event, duck tags, ducks, and
browser collections. The next race re-registers physical ducks from scratch.

## Post-Race Purge

After return processing, the complete race dataset is deleted, including
events, participants, browser collections, ducks, tags, assignments, heats,
results, messages, commands, and audits. Staff accounts, schema, and
infrastructure remain. Every physical duck used in a later race must be scanned
and registered again.

## Runtime Configuration

Production registration requires encrypted Worker secret
`TURNSTILE_SECRET_KEY` and the corresponding public `TURNSTILE_SITE_KEY`
binding. The form remains disabled without the public key, while the API fails
closed without the secret.
Automatic Workers invocation logs stay disabled because fetch-event logs include
request URLs, and private status credentials are carried in URL paths.
