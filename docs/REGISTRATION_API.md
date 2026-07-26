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
  "duckKeepPreference": "UNDECIDED",
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
participant contact information, registration status, staff lookup code,
event details, and keep/return preference. Never place this endpoint or its
response in analytics, application logs, public links, or search indexes.

The short lookup code is for staff search only and must never authorize this
endpoint.

Each successful response also appends the participant name, lookup code, and
private status path to the secure, HttpOnly
`__Host-quickducks-registrations` browser cookie. The bounded cookie supports
multiple registrations from one phone and lets the server render the device's
registration list on the home page. Email and phone are not unique.

## Public Status Search

```http
GET /api/v1/status/search?q={participantName}
```

Public name search may return participant display name, visible duck number,
assigned/current heat, registration status, and published race outcome. It
must never return contact details, lookup codes, private status paths, internal
IDs, inventory state, or audit data. Authenticated staff use a separate
role-checked search that may return the lookup code for pairing assistance.

## Public Duck Lookup

```http
GET /api/v1/ducks/{permanentTagToken}
```

An unpaired duck has no anonymous status payload and redirects home at the page
route. A paired duck's public status payload may expose participant name, duck
number, heat, current race progress, and published result. It never exposes
contact details, lookup codes, private tokens, inventory state, location,
synchronization state, or audit history.

## Runtime Configuration

Production requires encrypted Worker secret `TURNSTILE_SECRET_KEY`. The future
UI also needs the corresponding public `TURNSTILE_SITE_KEY` binding.
