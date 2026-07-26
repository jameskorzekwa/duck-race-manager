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

## Public Duck Lookup

```http
GET /api/v1/ducks/{permanentTagToken}
```

The response intentionally exposes only the visible duck number and tag
status. It does not expose participants, registrations, assignments, heats,
inventory state, or location.

## Runtime Configuration

Production requires encrypted Worker secret `TURNSTILE_SECRET_KEY`. The future
UI also needs the corresponding public `TURNSTILE_SITE_KEY` binding.
