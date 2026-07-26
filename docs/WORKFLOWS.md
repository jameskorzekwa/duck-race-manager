# QuickDucks Current Workflows

## Canonical Status

This document is the canonical operator and user workflow specification for the
currently implemented QuickDucks application. It describes behavior present in
the Worker, D1 migrations through `0012_staff_role_assignments.sql`, browser
scripts, and automated tests. When this document conflicts with an older
planning or design document, this document controls for current operation.

The terms in this document have precise meanings:

- **Implemented** means the current application and schema perform the behavior.
- **Operator step** means a person must perform or verify the step; QuickDucks
  does not infer that it happened.
- **System administrator** means an active `staff_profiles` row with
  `is_system_admin = 1`. It is an account type, not an assignment row, and
  implicitly passes every operational-role check.
- **Regular staff** means an active `staff_profiles` row with
  `is_system_admin = 0` and zero or more current normalized operational-role
  assignments.
- **Operational staff** means regular staff with at least one current role.
  Roles are composable and are not event-specific.
- **Deferred** means the schema, UI wording, or older design may mention the
  feature, but it is not an operational end-to-end workflow.

QuickDucks currently supports one event dataset at a time and requires online
access for every authoritative operation. It does not currently provide an
offline cache, service worker, command outbox, automatic synchronization, or
conflict-resolution queue.

## Authorization Summary

All staff APIs require a valid Cognito access token whose subject maps to an
active D1 staff profile. A Cognito account without an active matching profile is
not authorized.

| Capability | Required regular-staff role | System administrator |
| --- | --- | --- |
| Participant list/detail/search, walk-up, edits, withdrawal, scan-first search and pairing | `REGISTRATION` or `RACE_DIRECTOR` | Yes |
| Participant disqualification/reactivation | `RACE_DIRECTOR` | Yes |
| Participant contact data and registration notes | `REGISTRATION` or `RACE_DIRECTOR` | Yes |
| Duck inventory intake/edit, tag, assignment, unassignment, reservation, and inspection | `DUCK_MANAGER` or `RACE_DIRECTOR` | Yes |
| Take over another operator's abandoned pending sticker provisioning | `RACE_DIRECTOR`, after 10 minutes | Yes, after 10 minutes |
| Event list/detail context | Any operational role | Yes |
| Event readiness, heat list/detail/announcer-roster, result, and finalist reads | `ANNOUNCER`, `HEAT_RUNNER`, `RESULT_TAKER`, or `RACE_DIRECTOR` | Yes |
| Lock, ready, call, and start heat | `HEAT_RUNNER` or `RACE_DIRECTOR` | Yes |
| Finish heat and finalize required result/podium | `RESULT_TAKER` or `RACE_DIRECTOR` | Yes |
| Open `/staff/start-line` | `HEAT_RUNNER` or `RACE_DIRECTOR` | Yes |
| Open `/staff/finish-line` and resolve a roster duck by tag URL/number | `RESULT_TAKER` or `RACE_DIRECTOR` | Yes |
| Event lifecycle, planning, roster changes, result correction/reopen | `RACE_DIRECTOR` | Yes |
| Return review, dispositions, and return-batch create/stage/undo/finalize | `RETURN_STEWARD` or `RACE_DIRECTOR` | Yes |
| Create/configure/delete draft; reopen registration | None | Yes |
| Staff management; support diagnostics/notifications/audit | None | Yes |
| Purge readiness, cancellation, claim, and permanent purge | None | Yes |

All staff APIs still require an active profile. Authentication loads and
validates current assignment rows from D1 on every request. A regular account
with no current roles receives `403` for operational routes; there is no broad
production fallback. Role checks happen server-side even when the console hides
an unauthorized section. Heat and announcer responses include roster names as
required for race operation, but no contact fields. Duck/return-only inspection
also omits participant identity and contact fields.

## State Models

### Event

The operational event path is:

```text
DRAFT
  -> REGISTRATION_OPEN
  -> REGISTRATION_CLOSED
  -> ROUND_ONE
  -> FINAL
  -> COMPLETED
  -> RETURN_PROCESSING
  -> ARCHIVED
  -> deleted by purge
```

`REGISTRATION_CLOSED` can return to `REGISTRATION_OPEN` only before any heat
exists and only by a system administrator. `COMPLETED` can move to
`RETURN_PROCESSING` explicitly or when the first disposition or return batch is
finalized. `ARCHIVED` is a temporary purge-ready state, not retained event
history. A system administrator can cancel purge readiness and return the event
to `RETURN_PROCESSING` before a purge claim is made.

### Registration

```text
SUBMITTED -> ACTIVE
SUBMITTED or ACTIVE -> WITHDRAWN or DISQUALIFIED
WITHDRAWN or DISQUALIFIED -> SUBMITTED or ACTIVE
```

Pairing changes `SUBMITTED` to `ACTIVE`. Reactivation returns a registration to
`ACTIVE` when it still has a current duck assignment, otherwise to `SUBMITTED`.
Withdrawal and disqualification do not themselves close an assignment or
remove a heat entry.

### Heat

```text
PLANNED -> LOADING -> READY -> CALLING -> RUNNING
  -> AWAITING_RESULT -> FINALIZED
```

The schema also accepts `CANCELLED`, but no current route or console control
cancels a heat. A finalized result can be reopened to `AWAITING_RESULT` under
the dependency rules described below.

## Normal Event Sequence

The supported complete sequence is:

1. A system administrator creates and configures the only event as a draft.
2. A race director opens registration.
3. Participants self-register, or registration staff create walk-ups.
4. Duck managers intake physical ducks and active tag tokens for the event.
5. Registration staff pair each eligible participant with one eligible duck.
6. A race director closes registration.
7. For balanced mode, a race director previews and commits the round-one plan.
8. Registration staff and the race director resolve every still-submitted
   participant and check readiness.
9. The race director starts round one; heat runners run heats; result takers
   finish them and publish one winner per heat.
10. Race readers verify automatic finalist promotion and the race director
    starts the final.
11. Heat runners run the final and a result taker publishes the complete podium.
12. The race director completes the event and return stewards reconcile every
    physical duck.
13. A system administrator marks the event purge-ready, checks and claims the
   final purge gate, then permanently purges the race dataset.

## Participant Registration

### Public Registration

**Implemented:** `/register` loads the current public event and enables the form
only when its lifecycle status is `REGISTRATION_OPEN` and Turnstile is configured
in the rendered page. The server is authoritative and accepts a registration
only when the event is still open and the current server time is inside the
configured opening and closing timestamps.

The participant enters:

- First name, required, normalized to single spaces, maximum 80 characters.
- Last name, required, normalized to single spaces, maximum 80 characters.
- Email, optional or required by event configuration, maximum 254 characters.
- Phone, optional, maximum 32 characters.
- Email for staff contact when supplied. The routine UI does not offer an email
  notification preference while outbound delivery remains non-operational.
- Keep, return, or undecided duck preference.
- A successful Turnstile response.

The safe current-event response includes the configured public-name policy. The
form applies it to the entered name and states the exact public display, while
also stating that email and phone remain private.

Duplicate names, email addresses, phone numbers, and shared browsers are
allowed. Every submission creates an independent registration and stable race
entry. The keep preference is planning information only; a staff-recorded
physical disposition is authoritative after the race.

**Implemented security checks:** the API requires JSON, limits the request to
16 KiB, rejects a non-matching `Origin` header, validates the event and fields,
and verifies Turnstile server-side against the configured application hostname.
Registration fails closed when the Turnstile secret is absent or verification
cannot complete.

**Implemented retry behavior:** the browser creates a UUID command ID and a
high-entropy private token before submission. On a network interruption it
retains and retries that pair. Replaying the same command and private token
returns the original registration without another Turnstile verification. The
same command with a different private token is rejected.

On success, the participant receives:

- A registration in `SUBMITTED` state.
- An eight-character staff lookup code that excludes ambiguous characters.
- A private path of the form `/r/<private-token>`.
- Membership in the current browser's registration collection.

No duck or heat is assigned by public registration.

**Operator step:** keep registration lifecycle state aligned with the intended
schedule. Timestamps gate submission but do not automatically open or close the
event. The current browser UI also checks lifecycle status, not the timestamp
window, so the server may reject a form that appears enabled when an opening or
closing timestamp has passed.

### Staff Walk-Up Registration

**Implemented:** `REGISTRATION`, `RACE_DIRECTOR`, and system-administrator
accounts can create a walk-up while the event
is `REGISTRATION_OPEN` and inside its configured registration window. The same
field and email rules apply. Staff may also add notes of up to 2,000 characters.
The registration is marked `created_via = STAFF` and starts as `SUBMITTED`.

The console displays the new lookup code and a one-time link to open the private
status page. A staff walk-up is not automatically added to the participant's
browser collection.

**Operator step:** give the participant the displayed lookup code or private
link before leaving the result. QuickDucks has no email delivery or later
verified private-link recovery workflow.

## Participant Status and Recovery

### Browser Collection

**Implemented:** every successful public registration sets one opaque
`__Host-quickducks_browser` cookie. It is `Secure`, `HttpOnly`, `SameSite=Lax`,
host-only, and has a one-year sliding lifetime. Only a hash of its token is
stored in D1. The collection can link many registrations created in the same
browser.

The home page's `My ducks` section shows, for each collected registration:

- Full participant name from the private browser collection.
- Staff lookup code.
- Registration status.
- Privacy-filtered race status, including duck, heat, current heat, and outcome
  when public race status is available.

The section refreshes after a live race signal. While the live connection is
healthy, an approximately 30-second integrity refresh covers missed signals;
while it is unavailable or disconnected, polling increases to approximately
every five seconds. Polling and rendering pause in a hidden tab and resume with
an authoritative refresh when the tab becomes visible.

The collection cookie does not contain names, contact details, lookup codes, or
private status tokens. Clearing or expiring the cookie removes the shortcut but
does not withdraw or delete registrations. There is no current control to
remove one registration from the collection.

Public race status in a collection becomes `null` once the event enters
`RETURN_PROCESSING` or `ARCHIVED`, although the collection's registration name,
code, and registration status remain until purge.

### Private Status Link

**Implemented:** possession of the high-entropy `/r/<private-token>` URL is the
authorization credential. D1 stores only its SHA-256 hash. The HTML page shows
the full participant name, registration state, staff lookup code, event name,
and event date. The JSON endpoint also returns submission time and keep
preference. The endpoint includes, and the HTML renders, the same
privacy-filtered race-status facts used by the browser collection and public
status: current duck, assigned round-one and final heat, current event heat, and
race outcome. Neither response returns email or phone.

The private HTML page refreshes these registration and race facts after live
signals and through the same polling fallback. The private token remains the
credential and is never sent through the live signal channel.

**Operator step:** tell participants to bookmark the private link and separately
save the short lookup code. The short code is not authorization for the private
page and staff cannot regenerate its private token.

### Public Name Search

**Implemented:** the home page can search the current public event by an exact,
case-insensitive first name, last name, or full name. Partial matching is not
performed. The query must contain 2 to 161 characters, returns at most ten
matches, and is limited to 20 requests per minute for each event and Cloudflare
client network key.

Only `SUBMITTED` and `ACTIVE` registrations in events from
`REGISTRATION_OPEN` through `COMPLETED` are searchable. Display names follow the
event policy: first name, first name plus last initial, or full name. Search can
show pairing pending, assigned duck, heat, current heat, and race outcome. It
never returns contact details, lookup codes, private links, staff notes,
inventory state, location, or audit data.

Name search restores public status only. It does not restore the private link or
browser collection and does not show withdrawn or disqualified registrations.

## Duck Tag Scans

The physical NFC or QR content is an HTTPS URL `/t/<tag-token>`. The token maps
to a duck while that race dataset exists. A GET is always read-only.

### Anonymous Scan

**Implemented:** an anonymous scan displays public race status only when all of
these are true:

- The token belongs to an `ACTIVE` tag.
- The duck has a current assignment.
- The event is between `REGISTRATION_OPEN` and `COMPLETED`.

Otherwise the request redirects to the home page. Unknown, invalid, retired,
unassigned, return-processing, archived, and purged tags therefore do not expose
inventory metadata. A successful status page can show the event, policy-filtered
participant name, visible duck number, assigned round-one/final heat, current
active heat, and race outcome. It never shows contact details, lookup codes,
private links, staff history, or storage location.

### Authenticated Staff Scan

**Implemented:** a staff browser opening `/t/<tag-token>` is redirected to the
protected staff duck page. `REGISTRATION`, `DUCK_MANAGER`, `RETURN_STEWARD`,
`RACE_DIRECTOR`, and administrators may inspect a known tag. Registration and
race-director views can include participant identity, lookup code, email, and
phone. Duck-manager views retain inventory/relationship data without participant
identity or contacts. Return-only views contain return-relevant duck, event,
assignment-presence, and disposition state only.

An active, available or event-reserved, unassigned duck with no disposition is
offered for pairing only to registration-authorized accounts. An assigned or
ineligible duck remains an inspection view.
Closed historical assignments remain in history but do not appear as the
current assignment or suppress the pairing prompt after unassignment.
During `COMPLETED` or `RETURN_PROCESSING`, the same page offers disposition entry
or correction.

**Implemented scan stations:** `/staff/finish-line` can read an NFC URL through
Android Web NFC when `NDEFReader` is available. Its first-class
manual field also accepts a pasted canonical tag URL or visible duck number.
Both paths only select a roster entry; neither submits a result. Camera QR APIs,
inventory tag provisioning, and camera scanning remain separate from the finish
station.
Response headers continue to disable browser camera access.

`/staff/inventory-intake` is the dedicated Android station that provisions blank
writable NDEF stickers. A duck manager, race director, or administrator selects
the race and optional station location and presses Start once. That user gesture
starts one `NDEFReader.scan()` in current Android Chrome over HTTPS; the top-level
page must remain visible. Each subsequent physical reading writes and confirms
one sticker without a per-duck form, printed number, pasted URL, condition,
presence checkbox, or desktop fallback.

QuickDucks generates the UUID, next globally unique positive internal number,
and random 32-byte base64url token. The number remains an internal inventory
identifier; it is not input from or required to be printed on the duck. The
browser writes exactly `APP_ORIGIN/t/<token>` as one URL record and does not make
the tag read-only. NFC hardware serial numbers are used only as transient
in-memory read debouncing; they are never persisted, transmitted, displayed,
logged, or used as duck identity.

On iPhone, the operating system opens `/t/<tag-token>`. While a running or
awaiting-result heat is displayed, the finish station keeps a one-minute
same-origin `localStorage` return context containing event ID, heat ID, heat
revision, and expiry. The authenticated staff duck page consumes that context
and returns all four values plus the tag token in the finish-line URL. The
finish line removes the complete query immediately, refetches authoritative
state, and consumes the scan only when event, heat, revision, and
`AWAITING_RESULT` state match exactly. Expired, wrong-heat, stale-revision, and
pre-finish scans are discarded with instructions to review the current heat and
scan again. This GET/navigation sequence never submits a result.

## Staff Sign-In

**Implemented:** `/staff` sends unauthorized users through Cognito hosted sign-in
using authorization code, OAuth state, and PKCE. After the callback exchanges
the code, QuickDucks verifies the Cognito access token and requires a matching
active staff profile.

The browser session uses separate `Secure`, `HttpOnly`, `SameSite=Lax`, host-only
access and refresh cookies. Access and ID tokens remain valid for at most 15
minutes. The browser silently rotates both cookies through Cognito as needed,
without exposing the refresh token to JavaScript, responses, URLs, logs, or D1.
Cognito's rotating refresh token has an absolute seven-day provider validity, so
the browser remains signed in for up to seven days from sign-in and rotation
does not extend that deadline. A Cognito `400` or `401`, or a malformed
successful token response, clears both cookies. Network failures, `408`, `429`,
and `5xx` responses fail closed for that request but preserve the existing
refresh cookie unchanged so a reload can retry. Staff API clients may instead
use an explicit Cognito Bearer access token; Bearer requests are never refreshed.

Cookie-authenticated mutations require an exact application `Origin` header.
Sign-out is a same-origin `POST`; it requires the exact application `Origin`, or
when a browser omits `Origin`, a `Referer` whose parsed origin matches exactly.
Requests without that provenance do not revoke or clear anything. Accepted
sign-out requests revoke the refresh token best-effort, clear both local cookies,
and redirect through Cognito logout even when revocation has a network failure
or non-2xx response. This deliberately favors reliable local logout. Cognito
revocation is not observed immediately by offline JWT verification, so a copied
access token can retain residual validity for at most 15 minutes. Every request
still performs the live `staff_profiles.is_active = 1` D1 check, so staff
deactivation fails closed immediately. After the seven-day provider session
expires, the browser returns to staff sign-in. A scan page preserves its path as
a safe same-origin return target.

The staff home shows role-aware links to the focused start-line and finish-line
pages. Hidden links are only a convenience; each page and every API it calls
repeat authentication, active-profile, role, event-state, heat-state, and
revision checks.

**Operator step:** sign in and load the console on every intended device before
race operations. Do not assume the browser remains authorized beyond seven days.
There is no offline session or cached staff authorization. Every authenticated
request loads the active staff profile live; deactivation blocks access.
Cognito revocation or global sign-out prevents further refresh but does not make
offline verification of an already issued access token observe revocation.

## Event Setup and Lifecycle

Any operational role can load event list and event detail context needed by the
staff console. Event readiness and heat, announcer-roster, result, and finalist
reads are limited to announcers, heat runners, result takers, race directors,
and system administrators.

### Create and Configure

**System administrator only:** create one event when no event row exists. Event
creation requires a name, lowercase hyphenated slug, and date, then copies the
retained organization defaults into a `DRAFT` event.

Only a draft can be configured. Configuration includes:

- Name, slug, date, and IANA-style timezone.
- Optional registration-open and registration-close timestamps.
- Optional or required email.
- `IMMEDIATE_FIXED` or `POST_CLOSE_BALANCED` heat assignment.
- Round-one and final capacities from 1 through 10,000.
- Public name policy.

Saving configuration also updates the retained organization defaults used by
the next event. Configuration is revision-checked; a stale form is rejected.
After registration opens, there is no supported configuration edit route.

An administrator may delete a mistaken draft only when its revision matches,
the typed text is exactly `DELETE <event name>`, it contains no race data, and
it has no operational command/audit history other than creation and
configuration. A detached deletion audit remains, while organization defaults
remain available.

### Open and Close Registration

A race director or system administrator can open a dated draft. Opening does
not check other setup, inventory, or staffing readiness. The same authority can
manually close an open event.

A system administrator can reopen registration only while the event is closed
and no heat has been created. Immediate-mode pairing creates heats, so a closed
immediate-mode event normally cannot be reopened after any participant has been
paired into a heat.

### Start Round One

A race director or system administrator can start round one only when all server readiness
checks pass:

- Event status is `REGISTRATION_CLOSED`.
- At least one registration is `ACTIVE`.
- No registration remains `SUBMITTED`.
- Every active participant has a current duck assignment.
- Every active participant has a round-one heat entry.
- No blank-sticker provisioning remains pending physical-write confirmation.
- At least one round-one heat exists.
- The round-one heat count does not exceed final capacity.
- Every round-one heat is still `PLANNED`, `LOADING`, or `READY`.

**Operator step:** resolve every unpaired submission by pairing, withdrawal, or
administrative disqualification before starting. A heat cannot lock while its
roster contains a participant who is not `ACTIVE`; update the still-planned,
unlocked roster before proceeding.

Registration can close while a sticker is pending, and its owning operator can
still confirm it during `REGISTRATION_CLOSED`. Round one remains blocked until
every `START_DUCK_PROVISIONING` record still joined to a `NEW`/`NEEDS_TAG` duck,
`RESERVED` tag, and no active event reservation has been confirmed. The server
checks this both in readiness and inside the atomic round-start command so a
concurrent provisioning transition cannot strand a written sticker. An
abandoned pending record is not discarded to bypass readiness: a race director
or administrator must safely take it over and recover or confirm the exact
sticker first.

### Start Final and Complete Event

A race director or system administrator can start the final when every round-one heat is
`FINALIZED` or `CANCELLED`, at least one is finalized, each finalized round-one
heat has one first-place result, one final heat with entries exists, and that
final has not started.

A race director or system administrator can complete the event when the final is finalized,
all final heats are finalized or cancelled, and each finalized final contains
exactly places 1 through `min(3, final roster size)`.

A race director or system administrator can explicitly start return processing from
`COMPLETED` when no heat is `CALLING`, `RUNNING`, or `AWAITING_RESULT`. Recording
the first disposition or finalizing the first return batch also changes a
`COMPLETED` event to `RETURN_PROCESSING`.

## Participant Corrections and Status Changes

### Edit Details

Registration staff, race directors, and administrators can list and filter
participants, inspect details, and edit name, email, phone, email-notification
preference, keep preference, and staff notes. Edits are allowed while the event is `REGISTRATION_OPEN`,
`REGISTRATION_CLOSED`, `ROUND_ONE`, or `FINAL` and require the currently loaded
registration revision.

Audits record which field names changed and revision metadata, not the old or
new contact values. The participant's private token and lookup code do not
change.

### Withdraw, Disqualify, and Reactivate

Registration staff, race directors, and administrators can withdraw a
`SUBMITTED` or `ACTIVE` registration. Race directors and administrators can
disqualify a `SUBMITTED` or `ACTIVE` registration or reactivate a
withdrawn/disqualified registration. These
operations are revision-checked, idempotent, and audited.

Withdrawal or disqualification is allowed while every heat containing that
participant remains `PLANNED` and unlocked. Once any containing heat is locked,
running, awaiting a result, or finalized, both operations are blocked in
preflight and in the atomic write. Keep the participant `ACTIVE` and ask the
race director to resolve the heat or official result instead.

Status changes do not close a duck assignment, release an event reservation, or
remove a still-unlocked heat entry. For a pre-race active participant who should
leave the race, the operator should also use the duck unassignment workflow and
replace the unlocked roster if necessary. Unassignment itself preserves an
existing heat entry. There is no current operation to replace a roster with zero
entries or cancel an empty heat, so operators must resolve these cases before
locking and avoid creating a stranded empty heat.

## Duck Intake, Tags, and Assignment

### Intake

Duck managers, race directors, and administrators can provision and reserve a
duck during `DRAFT`, `REGISTRATION_OPEN`, or `REGISTRATION_CLOSED`. The normal
staff console still exposes the older explicit inventory form for supervised
administrative work, but it is not a fallback inside the dedicated station.
`/staff/inventory-intake` has no per-duck number, token, URL, condition, notes,
or physical-presence inputs. The operator selects the event and may set one
station-level storage location of at most 100 characters.

Blank-sticker provisioning uses a durable two-phase protocol:

1. `POST /api/v1/staff/inventory/provisioning` accepts an idempotent command ID,
   event ID, and optional location. In one write transaction it allocates the
   UUID, computes the next globally unique positive internal number as
   `MAX(visible_number) + 1`, generates a cryptographically random 32-byte
   base64url token, creates a `NEW`/`NEEDS_TAG` duck and `RESERVED` tag, and
   records a redacted command/audit association with the actor. The raw token is
   present only in the tag row and authorized no-store response, never command
   fingerprints or audit details.
2. The pending record does not create `event_ducks`, does not increment
   `summary.eventDucks`, has no intake inventory event, and cannot resolve as an
   active public tag. `GET /api/v1/staff/inventory/provisioning?eventId=...`
   immediately returns only the current owner's oldest pending record and exact
   URL for that event. A new start request recovers it instead of allocating
   another duck. It never automatically returns another operator's URL.
3. After Web NFC `write()` resolves, an independently idempotent
   `POST /api/v1/staff/inventory/provisioning/confirm` atomically changes the duck
   to `GOOD`/`RESERVED_FOR_EVENT`, changes the tag to `ACTIVE` with written,
   verified, and activated timestamps, creates the event reservation and
   `DUCK_INTAKE` history, and writes redacted audit history. Event state and
   pending ownership/state are guarded again inside the transaction. Same-command
   replay and a concurrent second confirmation return the authoritative existing
   result without duplicating the reservation or history.
4. If the owning station is abandoned, the pending record remains protected for
   at least 10 minutes after its latest start or takeover ownership audit. After
   that interval, recovery may show a race director or administrator only the
   pending duck's internal number and an explicit takeover action. A duck manager
   alone cannot take over it, and no tag URL is disclosed before takeover.
   Confirming the action atomically records a redacted
   `DUCK_PROVISIONING_TAKEN_OVER` audit naming the prior and new staff profile
   IDs. The new owner can then recover the exact URL and confirm; the prior owner
   immediately loses recovery, classification, and confirmation access. Each
   takeover starts a new 10-minute ownership-protection interval so concurrent
   stations cannot steal live work. Start audits remain immutable, and command
   reuse plus pending/event guards make takeover idempotent and race-safe.

**Operator step:** in current Android Chrome on an NFC-capable device, keep the
top-level HTTPS page visible and online. Select the race, optionally enter the
station location, and press Start once. Then tap one blank writable NDEF sticker,
hold it still until the station beeps/vibrates and displays success, remove that
duck during the short **Remove duck** state, and immediately tap the next one.
QuickDucks automatically writes exactly one URL record containing the canonical
`https://quickducks.com/t/<token>` URL. It uses successful `write()` resolution
as physical-write verification and does not call `makeReadOnly`, preserving the
controlled tag-replacement workflow.

The browser allows one operation in flight and has no scan queue. It uses an NFC
hardware serial only as an in-memory same-reading debounce and never as duck
identity. A failed or interrupted write retains the same pending URL and both
command IDs; a blank retap retries the same URL and no new duck is allocated. If
the physical write succeeded but confirmation is uncertain, retapping its exact
canonical URL retries confirmation without rewriting. Reloading recovers the
pending record from the server; reading that exact recovered URL treats the
physical write as complete and proceeds directly to confirmation without another
`write()` call. The station pre-arms recovery after success but does not allocate
the next duck until the next physical reading.

If a reading already contains an exact canonical QuickDucks URL, the browser
classifies it through the protected provisioning endpoint before any write. With
no pending operation, an active tag reserved for the selected event reports
**Already provisioned**, refreshes the authoritative count, and does not increment
**Added this session**. While provisioning is pending, only the current actor's
exact pending URL can finish it. Every other canonical URL, including another
active selected-event tag, produces a sticky **finish the pending sticker**
mismatch without clearing command IDs, allocating a duck, cloning the pending URL,
or changing either count. Unknown, different-event, or different-actor canonical
URLs are likewise never adopted or overwritten. Blank tags and unrelated NDEF
content may be overwritten after the station starts.

The station's session count and DOM-built history contain outcomes only, never
the raw token or permanent URL. Provisioning is online-only and requires current
staff authentication, live authorization, same-origin cookie mutation
protection, and live API access. Unsupported platforms receive Android
Chrome/HTTPS/top-level/visible-page instructions. There is no pasted URL,
manual-number, desktop, offline queue, service-worker cache, or background retry
fallback. Takeover target IDs and internal number are non-sensitive recovery
metadata; after a successful takeover, the recovered URL remains only in the
station's in-memory provisioning state and is not placed in DOM, browser history,
or logs.

### Inventory Editing and Label Data

Duck managers, race directors, and administrators can edit visible number, condition, storage location,
and notes only before racing begins and with the current duck revision. The
label-data action returns only the visible number and canonical active tag URL;
it does not generate or print a label.

Inventory detail includes current state and append-only views of inventory
events, tag versions, event reservations, and duck assignments. Raw tag tokens
are not returned in detail/history responses. Participant names are included
only when the actor also has `REGISTRATION`, has `RACE_DIRECTOR`, or is an
administrator.

### Tag Replacement and Retirement

Duck managers, race directors, and administrators can replace an active tag from draft through final.
The operator enters a new unique token, confirms the physical tag was written
and verified, and submits the current duck revision. The old tag becomes
`RETIRED`; the new tag becomes `ACTIVE` and supersedes it. Participant,
assignment, and heat state are unchanged. A duck in `NEEDS_TAG` condition is
restored to `GOOD` with the appropriate reserved or in-use inventory state.

Retiring a tag without replacement is allowed only before racing, only for an
unassigned duck, and requires confirmation that the physical tag was removed
plus a reason. The duck becomes `NEEDS_TAG` and `QUARANTINED`. An assigned duck
must receive a replacement tag instead.

### Scan-First Pairing

The normal pairing workflow is:

1. The participant selects a physical duck.
2. Logged-in staff open that duck's NFC/QR URL.
3. QuickDucks verifies the tag and displays the exact duck.
4. Staff search the current event by lookup code, name, phone, or email.
5. Staff select an unpaired registration and review participant plus duck.
6. Staff press the one confirmation button.
7. QuickDucks atomically reserves the duck if needed, creates a current
   assignment, changes registration to `ACTIVE`, changes inventory to `IN_USE`,
   writes audit history, and assigns an immediate-mode heat when applicable.

Pairing is allowed while the event is `REGISTRATION_OPEN` or
`REGISTRATION_CLOSED`. The registration must be `SUBMITTED` and unpaired. The
duck must have an active tag, no current assignment, an eligible inventory
state, and no reservation for another event.

Staff search accepts an exact normalized code or a case-insensitive name
substring of at least two characters. It can show contact details, status, and
an assigned duck. The UI disables already assigned results; the server also
requires an unpaired `SUBMITTED` registration.

In `IMMEDIATE_FIXED` mode, the command uses the lowest-numbered unlocked
round-one heat below configured capacity or creates the next heat. It returns
the heat number. Pairing rejects before creating a new heat when the existing
round-one heat count has reached final capacity. In `POST_CLOSE_BALANCED` mode,
pairing returns heat assignment pending.

**Operator step:** physically place immediate-mode ducks in a bag labeled with
the returned heat number. QuickDucks records no bag placement or expected
physical location confirmation.

### Assignment, Reassignment, and Unassignment

The inventory console can assign a selected good, actively tagged, available or
event-reserved duck to a race-entry ID. A reason and current duck revision are
required. This route also performs pre-race reassignment: it closes the prior
assignment, returns the old duck to event-reserved inventory, assigns the new
duck, and preserves the participant's heat entries.

Assignment changes are allowed only in `REGISTRATION_OPEN` or
`REGISTRATION_CLOSED` and are blocked once any participant heat is `CALLING`,
`RUNNING`, `AWAITING_RESULT`, or `FINALIZED`, or has a result. A replacement
during round one or the final is not implemented.

Unassignment is subject to the same phase and dependency limits. It closes the
assignment, changes an `ACTIVE` registration to `SUBMITTED`, and either keeps
the duck reserved or releases the reservation according to the operator's
choice. A separate release action is available for an unassigned reservation
before racing.

**Deferred:** there is no two-participant duck swap, lost/found workflow,
in-race replacement, finalist-replacement policy, or physical-location event
model. Current pre-race reassignment is the only physical-duck replacement
workflow. Heat entries remain attached to the stable race entry.

## Heat Planning

### Immediate Fixed Mode

Pairing builds round-one heats in staff pairing order. Each new participant
uses the first eligible heat with fewer entries than
`round_one_heat_capacity`; otherwise QuickDucks creates the next heat. The final
partially filled heat is not automatically rebalanced.

Closing registration does not automatically lock heat rosters. Operators still
start round one and run every heat through the normal lock/readiness sequence.
Concurrent attempts that select the same slot are protected by uniqueness and
atomic batches; one may receive a conflict and must refresh/retry.

### Post-Close Balanced Mode

After registration is closed, a race director or administrator can preview a balanced
plan when no round-one heat exists. QuickDucks:

1. Selects all `ACTIVE` entries with a current duck assignment.
2. Orders them deterministically by visible duck number, then race-entry ID.
3. Calculates `ceil(N / capacity)` heats.
4. Divides entries so heat sizes differ by at most one.
5. Returns the exact rosters and a fingerprint without writing data.

The operator reviews the preview and commits that exact fingerprint. Commit
creates all planned heat and roster rows atomically. If participants or
assignments changed, commit fails and the operator must preview again.

This is not a random physical draw. It is a deterministic balanced assignment.
Preview and commit both reject a plan unless:

```text
ceil(active participants / round-one capacity) <= final capacity
```

Configuration and round-one roster replacement do not enforce each heat's
configured target size, so operator review is still required.

### Roster Correction

A race director or administrator can replace a nonempty roster only while the heat is
`PLANNED` and unlocked and the event is in that heat's active round. Each entry
must be active, currently assigned, absent from another heat in the same round,
and, for a final roster, a finalized round-one winner. Replacement is
revision-checked and audited.

Because the event must already be `ROUND_ONE` or `FINAL`, planned rosters are
corrected after starting the applicable round but before locking the heat.

## Heat Readiness and Running

For each round-one and final heat, station staff perform:

1. Review heat detail and the authoritative roster.
2. Optionally load the announcer roster, which shows full name, duck number, and
   slot but no contact details.
3. A heat runner `Lock roster`: requires at least one entry and every listed
   registration to be `ACTIVE`, changes `PLANNED` to `LOADING`, and permanently
   locks roster editing.
4. `Mark ready`: changes `LOADING` to `READY`.
5. `Call heat`: changes `READY` to `CALLING`.
6. `Start heat`: changes `CALLING` to `RUNNING`.
7. A result taker `Finish heat`: changes `RUNNING` to `AWAITING_RESULT`.
8. A result taker enters and publishes the required result.

### Focused Start-Line Station

`/staff/start-line` prioritizes any heat awaiting publication, then the current
running heat, then the next unfinished heat in the event's active round. This
prevents a newer prepared or running heat from hiding a pending official result.
It shows event, round, heat number, status, roster names, and visible duck
numbers without contact data. Depending on authoritative status, it exposes
exactly one of `Lock roster`, `Mark heat ready`, `Call this heat`, or `Start this
heat`. An awaiting-result heat instead displays that no next heat can start.
Starting requires a plain-language confirmation that reads back round, heat
number, and racer count. The station has no finish, result, correction, reopen,
or roster-edit control. Large high-contrast controls are at least 48 pixels
tall.

### Focused Finish-Line Station

`/staff/finish-line` prioritizes an `AWAITING_RESULT` heat, otherwise a `RUNNING`
heat, in the active round. A newer running heat therefore cannot clear result
selections for an older unpublished heat. A running heat exposes only `Mark heat
finished`. Once awaiting a result, each tag URL, Web NFC read, iPhone handoff,
or visible number is resolved server-side against that exact heat's
authoritative current roster and requires the registration to remain `ACTIVE`.
Wrong-heat, inactive, and unknown ducks are rejected. Selecting the same race
entry twice is rejected visibly.

Round one requires exactly one selected winner. A final requires distinct places
1 through `min(3, final roster size)`. Every selection displays place,
policy-filtered participant name, and visible duck number before submission.
Only one tag/number lookup can run at a time. While it runs, manual, NFC,
selection-removal, and result-submit controls are disabled and additional scans
are ignored. The station captures event ID, heat ID, revision, and intended
place before the request and discards the response if any value changed. NFC
handlers await that same serialized selection path.

Scanning never submits; the operator presses one explicit `Submit official
winner` or `Submit official podium` button. Submission requires a plain-language
confirmation that reads back every selected participant, duck, and place. The
revision-checked, role-guarded result endpoint revalidates that each selected
registration is `ACTIVE`; the atomic command repeats that eligibility guard.
The station offers no result correction or automatic retry/offline queue.

Only one heat in an event may be `RUNNING`, and no heat may start while any other
heat in that event is `AWAITING_RESULT`. Preparing, locking, readying, and
calling the next heat may overlap, but starting conflicts until the prior heat's
official result is published. Every transition requires the currently loaded
heat revision and is rechecked atomically against event round, heat state,
pending results, and roster eligibility.

**Operator step:** before locking, count physical ducks, compare the displayed
roster with the bag, and verify the configured target. The server requires only
a nonempty roster; it does not require `rosterSize == targetSize`. The announcer
roster is a read-only list. There is no checklist-complete or announced-at
record.

## Round-One Results and Finalist Promotion

After a round-one heat reaches `AWAITING_RESULT`, a result taker, race director,
or administrator
selects exactly one `ACTIVE` first-place race entry from that heat's roster and
confirms the plain-language readback before publication. QuickDucks atomically:

- Writes one finalized first-place result linked to the current duck assignment.
- Changes the heat to `FINALIZED`.
- Creates the single planned final heat if needed.
- Adds the winner to the next final slot.
- Writes command and audit history.

Finalist verification compares finalized round-one heats and first-place
results with the one final roster. `verified` is true only when every round-one
heat is finalized, exactly one final exists, every winner is present, and every
finalist is a winner.

The operator checks finalist verification before starting the final. There is
no physical winners-bag scan or set-verification workflow.

## Final Results

The final follows the same lock, ready, call, start, and finish transitions.
When it reaches `AWAITING_RESULT`, a result taker, race director, or administrator must publish exactly
places 1 through `min(3, final roster size)`, using distinct finalists from the
roster. All required places are written in one atomic command and the final
becomes `FINALIZED`.

The event remains `FINAL` until a race director or administrator runs `Complete event`.
There is no staged first-place, second-place, then third-place scan workflow;
the current form submits the complete podium together.

## Result Corrections

All result corrections and reopens require `RACE_DIRECTOR` or a system
administrator, a fresh heat revision, a 4-to-500-character reason, and explicit
confirmation. Result takers may finalize new results but cannot alter published
results.

### Round-One Correction

A published winner can be directly replaced while the final heat is still
`PLANNED` and unlocked. QuickDucks moves the old result into
`heat_result_history` as `SUPERSEDED`, publishes a new revision, and replaces
the corresponding finalist roster entry.

A round-one result can instead be reopened to `AWAITING_RESULT`. The existing
result is superseded and its finalist promotion is removed. If the event had
already moved to `FINAL`, it is returned to `ROUND_ONE`. Reopen is blocked once
the final roster is locked or underway.

### Final Correction

Current final result correction and reopen routes are available only after the
event has been moved to `COMPLETED` and before return processing has begun.
Therefore an operator who finds a podium error must first complete the event,
then correct or reopen it.

A direct final correction supersedes the old podium and publishes a new result
revision while the event remains `COMPLETED`. Reopening supersedes and removes
the podium, changes the heat to `AWAITING_RESULT`, and moves the event back to
`FINAL`; staff must republish the podium and complete the event again.

Final correction and reopen are blocked after any event duck reservation is
released or any disposition exists. They are also unavailable once the event
has explicitly entered `RETURN_PROCESSING`.

Historical result revisions remain until the race purge.

## Public Race Results

**Implemented:** `GET /api/v1/race-board` publishes the one current event only
from `REGISTRATION_OPEN` through `COMPLETED`. The prominent board appears on the
home page, private status pages, and public duck-tag status pages. It includes:

- Safe event lifecycle status and date.
- Ordered round-one and final heats.
- Safe heat status, including calling, running, and awaiting-result emphasis.
- Policy-filtered participant display names and visible duck numbers.
- Finalized round-one winners and an ordered final podium.

Visible duck numbers come only from a current assignment with `valid_to IS
NULL`; a historical assignment closed by pre-race unassignment is never revived
on the board.

The board returns no event, heat, race-entry, registration, assignment, or
result IDs; no contacts, lookup/private/tag tokens, staff data, notes, inventory,
or audit data; and no unfinalized place claims. Before heats exist it shows the
event with a plain-language empty state. With no current event it shows a usable
check-back message.

Participant-level race status remains available through an assigned active duck
tag, exact public name search, and browser collection cards. It exposes:

- Policy-filtered participant display name.
- Visible duck number when currently assigned.
- Round-one and final heat numbers and statuses.
- The event's one currently calling, running, or awaiting-result heat.
- Pairing pending, heat assignment pending, not raced, running, awaiting result,
  round-one winner, finalist, eliminated, withdrawn, disqualified, final
  complete, or first/second/third place outcomes.

The outcome gives withdrawal/disqualification priority, then podium, final
completion/finalist state, round-one winner/elimination, running state, pairing,
and heat assignment.

The board and participant pages connect to same-origin `/api/v1/live`. Admission
requires the exact application `Origin`. The single `RaceUpdates` Durable Object
accepts at most 1,000 simultaneous sockets, rejects upgrades over that cap, and
closes any client-sent frame with WebSocket policy code `1008`. It broadcasts
only a small random-version refresh signal and stores no race state or client
network identifier.

A successful signal causes clients to refetch. Reconnect uses bounded jitter.
While disconnected or when WebSocket is unavailable, clients poll approximately
every five seconds; while connected they perform an approximately 30-second
integrity refresh. Refresh requests are coalesced, hidden tabs pause polling and
rendering, and station controls/rosters are replaced only when heat ID, revision,
or state changed, with focus restored when possible. Public freshness text says
plainly when the board refreshed but private status or `My ducks` did not.
D1/API data is always authoritative, and a failed live publication never
changes a committed mutation response.

Public race status is available only through `COMPLETED`. Starting return
processing removes tag and name-search race status from public access before
the final purge.

## Returns and Dispositions

### Single Duck

After racing is `COMPLETED` or in `RETURN_PROCESSING`, a return steward, race director, or administrator
can record a disposition by opening an active tag or entering a visible duck
number in return review. Allowed dispositions and resulting inventory states
are:

| Disposition | Inventory state |
| --- | --- |
| `RETURNED` | `AVAILABLE` |
| `QUARANTINED` | `QUARANTINED` |
| `DAMAGED` | `DAMAGED` |
| `RETIRED` | `RETIRED` |
| `KEPT` | `KEPT` |
| `MISSING` | `MISSING` |
| `UNACCOUNTED_FOR` | `UNACCOUNTED_FOR` |

The atomic command creates or updates the event disposition, closes any active
assignment, releases the event reservation, updates inventory, audits the
action, and moves a completed event to `RETURN_PROCESSING`. Submitting another
disposition for the same event duck is an explicit correction and updates the
authoritative outcome.

**Operator step:** visually confirm the physical duck and select the actual
outcome. The participant's earlier keep preference does not set the disposition.
Use visible-number entry for missing/unreadable tags. Disposition does not
change the duck's stored physical-condition field; it changes inventory state.

### Bulk Return Batch

Return stewards, race directors, and administrators can:

1. Start an open batch for a completed/writable event.
2. Stage unresolved, unreleased ducks by visible number and disposition.
3. Undo only the latest non-undone item in that open batch.
4. Finalize a nonempty batch.

Staging does not change assignment, reservation, disposition, or inventory.
Finalization applies every active item atomically, closes assignments, releases
reservations, updates inventory, changes the event to `RETURN_PROCESSING`, and
marks the batch finalized. A duck cannot be actively staged twice, and a duck
already given a disposition cannot be staged.

There is no cancel/delete operation for an accidentally created open batch. An
open or `FINALIZING` batch blocks the final purge gate. Operators should not
start a batch until they intend to add at least one unresolved duck and finalize
it. An abandoned empty batch currently has no console recovery path.

### Return Review

Return stewards, race directors, and administrators can view the current completed, return-processing, or archived
event's total ducks, unresolved duck numbers, unreleased reservations,
disposition counts, active-assignment flag, and blocking-heat flag. The review
does not expose participant data.

## Staff Access Lifecycle

The account model distinguishes regular staff from system administrators with
`is_system_admin`. Regular staff receive one or more normalized, composable
assignments from this fixed vocabulary:

- `REGISTRATION`
- `DUCK_MANAGER`
- `ANNOUNCER`
- `HEAT_RUNNER`
- `RESULT_TAKER`
- `RETURN_STEWARD`
- `RACE_DIRECTOR`

System administrators have no assignment rows. Migration `0012` deliberately
does not infer or seed roles for a legacy regular profile. Before the first
remote application, release automation stops if such a profile exists so each
legacy account must receive an explicit reviewed mapping instead of broad access
or a silent lockout. Once `staff_role_assignments` exists, this legacy gate no
longer applies. A newly created regular account must receive a nonempty validated
set; a newly created administrator receives none.

### Grant Access

A system administrator enters email, display name, account type, and, for a
regular account, one or more operational roles. Roles can be combined.
QuickDucks creates
or safely reuses an enabled matching Cognito identity, then creates the D1 staff
profile and retained access command/audit records. The command is idempotent.
If D1 persistence fails after creating a new Cognito identity, QuickDucks tries
to delete that identity; even if cleanup fails, it remains unauthorized without
a D1 profile.

Cognito user creation suppresses the administrative creation message. Granting
access does not send a QuickDucks invitation email. The staff member signs in
through the Cognito hosted flow with the authorized account.

### Change, Deactivate, and Reactivate

Only a system administrator can list staff, replace a regular account's role
set, promote/demote account type, deactivate, or reactivate an account. Role-set
replacement requires a command ID and current role revision; it atomically
revokes prior current assignments, writes new current assignments, increments
the revision, and retains command/audit history. Administrators cannot demote or
deactivate themselves.
The database also prevents demoting, deactivating, or deleting the final active
system administrator.

Deactivation disables the Cognito identity and globally signs out sessions
before saving inactive D1 state. If global sign-out fails, QuickDucks attempts
to re-enable Cognito and saves no lifecycle change. If D1 save fails after a
Cognito change, QuickDucks attempts the opposite Cognito operation to reconcile
state. Reactivation similarly enables Cognito before saving active D1 state.

Deactivation does not revoke operational assignments, so reactivation restores
the same role set. Promotion to administrator closes current assignment rows;
demotion requires a new nonempty set. An inactive profile cannot authenticate
even with an otherwise valid Cognito token. Staff access, assignment history,
and lifecycle command/audit records are retained across race purges.

## Audit and Support

### Operational History

Implemented domain mutations write `race_commands` and `audit_events` in the
same D1 batch as their state changes. Duck inventory also has a command-linked
history. Result correction preserves superseded result rows rather than
overwriting history. Staff access and staff lifecycle use separate retained
command/audit tables.

Participant details are restricted to registration staff, race directors, and
administrators. Duck inventory/relationship history is restricted to duck
managers, race directors, and administrators, with participant identity omitted
unless the actor also has participant-PII authority. Only a system administrator
can open support summary, notification records/attempts, the redacted event
audit timeline, and purge-gate diagnostics.

The support audit timeline intentionally returns event/action/subject,
actor type and display name, time, and a safe notification error code. It does
not return `details_json`, contact data, tokens, or provider details.

### Notification Support

The schema and administrator UI can list notification rows and attempts, retry
`FAILED` or `RETRY_PENDING` records, and suppress or cancel eligible records.
Retry creates a durable queue attempt and publishes only the notification ID to
the configured queue producer.

**Deferred and non-operational:** current registration, pairing, heat, and
result commands never create `email_notifications` rows. `wrangler.jsonc`
declares only an `EMAIL_QUEUE` producer. There is no Worker queue consumer, SES
template/send path, delivery callback, or automatic retry processor. Therefore
no registration, assignment, upcoming-heat, finalist, or result email is
currently delivered, regardless of the participant's stored preference.
Notification support controls operate only on records inserted by some external
or future process and must not be presented as proof that delivery exists.

## Purge Readiness and Permanent Purge

Purge has three distinct administrator-only stages.

### Stage 1: Mark Purge-Ready

The system administrator reviews all physical outcomes and acknowledges
permanent deletion. QuickDucks moves the event to `ARCHIVED` only when:

- No heat is `RUNNING` or `AWAITING_RESULT`.
- Every event duck has a disposition.
- Every event reservation is released.
- Every duck assignment is closed.

`ARCHIVED` disables normal race operation. Before a purge claim, an
administrator can cancel purge readiness with a reason, returning the event to
`RETURN_PROCESSING` for corrections.

### Stage 2: Check and Claim Purge

The administrator opens the purge gate. Claim is allowed only when:

- The event is `ARCHIVED`.
- It is the only event dataset.
- No heat is running or awaiting a result.
- No race command has a null completion time.
- Every notification is terminal: delivered, failed, bounced, complained,
  suppressed, or cancelled.
- Every event duck has a disposition and released reservation.
- No active duck assignment remains.
- No return batch is open or finalizing.
- No prior purge claim exists.

The administrator types exactly `DELETE <event name>`. A successful claim
records `PURGING`, writes command/audit history, and freezes event updates.
Support notification and return mutations also reject a claimed event.

### Stage 3: Permanently Delete

The administrator again acknowledges deletion and types exactly
`DELETE <event name>`. Final purge requires the archived event, active purge
claim, no other event, and a disposition for every event duck. It then deletes
in one D1 batch:

- Browser collection links and browser collections.
- Email notifications and attempts.
- Current and superseded heat results, entries, and heats.
- Return batches and items.
- Dispositions, assignments, reservations, and duck inventory events.
- Event audit events and race commands.
- Race entries, registrations, and the event.
- Every duck and tag row.

The response clears browser cache, cookies, and storage and expires the browser
collection cookie. Repeating purge after the event is absent returns success
without another delete.

Staff profiles, staff access/lifecycle history, organization event defaults,
schema, and infrastructure remain. The next event starts with no race duck/tag
rows, so each physically selected duck must be intaken again.

The application purge deletes the primary D1 rows it manages. It does not
operate Cloudflare account-level recovery systems, D1 time-travel retention,
external exports, third-party logs, or backups. Operators must manage those
systems consistently with the stated privacy policy.

## Failure, Retry, Idempotency, and Concurrency

### Safe Command Rules

Most current mutations accept a client-generated UUID command ID. A matching
replay returns the stored result and `replayed: true`; reuse for another
operation or materially different request returns a conflict. Event and heat
commands use request fingerprints where needed. Permanent purge itself has no
command ID but is idempotent once its event no longer exists.

Public registration preserves its pending command/private-token pair across a
network failure and is safe to retry. The staff console generally creates a new
command ID for each button submission and does not persist that ID in an
offline outbox. If a staff response is lost after a possible save, refresh the
relevant event, participant, duck, heat, batch, or support view before pressing
the action again. A state conflict is safer than assuming the first action
failed.

### Optimistic Concurrency

Event configuration/deletion, participant edits/status, duck edits/tag and
assignment operations, heat transitions/rosters, and result publication or
correction require a current revision or preview fingerprint. A stale request
returns `409` and no accepted partial state. The operator should refresh, review
the new state, and make a new decision rather than repeatedly submitting stale
data.

Pairing and return staging rely on current-state predicates and uniqueness
constraints rather than a user-supplied entity revision. Concurrent claims of
the same duck, participant, heat slot, result place, batch duck, active tag, or
purge claim cannot both commit.

### Atomicity

D1 batches make the command, domain changes, and audit records all-or-nothing
for implemented workflows. This includes registration, pairing, inventory/tag
changes, result publication/correction, return batch finalization, purge claim,
and purge. Errors report conflict/retry rather than accepting known partial
database changes.

External Cognito changes cannot share a D1 transaction. Staff grant and
lifecycle handlers use compensation as described in the staff-access section
and return explicit reconciliation errors if compensation also fails.

Queue retry is also split across D1 and Cloudflare Queue. The durable attempt is
created first. If publish fails, it is marked temporary failure and the
notification returns to `RETRY_PENDING`; the same command can retry publication.
This path does not make email delivery operational without a consumer.

### Connectivity Failure

There is no supported offline success state. Do not continue assigning,
planning, changing rosters, starting heats, publishing results, or finalizing
returns while disconnected. Keep the physical duck in a clearly marked pending
area, restore connectivity, refresh server state, and then perform the action.
For critical race-day work, use one authoritative online device until another
device has refreshed current state.

The words `Updates are arriving live`, `Updated just now`, or a delayed/reconnect
message describe connection freshness only. They do not acknowledge an
authoritative mutation. Operators must still wait for the mutation's saved
response and refreshed state.

## Security and Privacy Boundaries

- NFC/QR tags contain only the random tag URL, never participant data.
- A tag token is a public duck identifier, not staff authentication.
- Private status tokens are high-entropy bearer credentials stored only as
  hashes; lookup codes are staff search values, not private-page credentials.
- Public status never returns email, phone, lookup code, private link, staff
  notes, inventory location, or audit details.
- Exact public name search is rate-limited and event-scoped, but it is still
  public status, not identity verification.
- Every staff request requires a valid Cognito token and active D1 profile.
- Browser staff mutations require exact same-origin requests; Bearer clients
  remain responsible for protecting their access tokens.
- Dynamic public, private, tag, API, and staff responses use
  `Cache-Control: no-store`.
- Protected `staff-duck.js`, `start-line.js`, and `finish-line.js` scripts use
  `Cache-Control: no-store`; public static scripts retain bounded public caching.
- Private, tag, registration, staff, and not-found HTML is marked noindex; robots
  also disallow private/API/staff paths.
- Responses set strict transport, no-referrer, content-type, opener, permissions,
  and content-security policies. Camera, microphone, and geolocation are
  disabled by policy.
- Automatic Worker invocation logs are disabled because private and tag tokens
  occur in URL paths. Operators must not put request bodies, names, contacts,
  lookup codes, private tokens, tag tokens, or credentials in logs or exports.
- Public registration is Turnstile-protected. The current code does not apply a
  separate registration rate limiter or a private-status rate limiter.
- Race purge removes application-managed race, participant, duck, tag, browser,
  result, command, and event-audit rows. Staff identity and staff-access history
  are intentionally retained.

## Older and Non-Technical User Rules

The current console is one responsive staff page. Regular accounts see only the
navigation, sections, and per-heat controls allowed by their role combination.
Administrators see all operational sections plus Support and Access. The access
UI uses human-labeled checkboxes and explains that operational roles can be
combined. Hidden UI is convenience only; server authorization remains the
boundary.

Use these operating rules with older or non-technical staff:

1. Sign in and select the correct event before handling a participant or duck.
2. For normal pairing, let the participant choose the duck, open that tag first,
   search by the short code when available, review both names/numbers, and press
   confirm once.
3. Read the returned heat number aloud and physically place the duck in the
   matching labeled bag; QuickDucks does not track the movement.
4. Wait for the displayed success message before moving the physical item or
   starting another software action. Console operations normally report
   `Saved. Current data has been refreshed.`; scan pages use task-specific text.
5. If the screen reports a conflict or the network response is uncertain, stop,
   keep the item in a pending area, refresh, and inspect current state. Do not
   repeatedly press the button.
6. Before locking a heat, compare the screen roster, physical bag, duck count,
   and target. Lock only after a second physical check when practical.
7. Before publishing a result, have the finish judge identify the roster entry
   by NFC URL or visible number, reject any wrong-heat/duplicate warning, and
   have the operator read back participant, duck, and place. The complete podium
   is submitted together with the one explicit station submit button.
8. Use visible duck numbers at the finish station and for return exceptions when
   a tag cannot be opened. It is not a universal fallback for other workflows.
9. Keep destructive administrator tasks separate from routine race operation.
   Purge requires return review, two typed confirmations, and a distinct claim.
10. Do not teach unsupported offline, camera scan, random-draw scanning, or
    email-notification procedures as if they work. NFC writing works only in the
    protected blank-sticker provisioning station.

The UI still exposes race-entry IDs for inventory assignment and return-batch
IDs for bulk work. A lead operator should prepare those workflows and supervise
staff who are not comfortable with technical identifiers. There is no demo
mode, task-specific help system, printed quick reference, or automated
usability-test gate in the current application. The provisioning station does
provide success sound/vibration when the browser and device support them.

## Live Race Test Coverage

Automated tests parse every live/station browser script, prohibit unsafe HTML
sinks, and execute coalescing, jitter, hidden-tab, five/30-second polling,
pending-result selection, serialized scan, stale response, and place-order
helpers. A mocked browser runtime verifies successful, expired, wrong-heat, and
stale-revision iPhone handoffs without submitting. Focused handler tests cover
exact-origin Durable Object routing, connection cap, policy closure, broadcast,
publication failure isolation, station page roles, and no start-line
finish/result control.

Real freshly migrated SQLite tests verify public-board ordering, safe statuses,
current-assignment joins, policy display names, privacy exclusions, ACTIVE
registration result boundaries, atomic lock/finalization races, overlapping
heat starts, round-one winners, final podium, empty state, and foreign keys. The
complete race integration test verifies board state during round one, the
running final, published podium, and completion; resolves round-one and final
scans through real station handlers; and confirms mutation refresh signals
contain only `type` and `version`. Provisioning tests cover generated tokens and
numbers, redacted audits, pending invisibility, actor/event recovery, command
replay, phase gates, atomic confirmation, concurrent confirmation, exact Web NFC
URL writes, same-tag debounce, write/confirm retry separation, unsafe sinks, and
the full migrated-SQLite race workflow.

## Deliberately Deferred or Non-Operational Features

The following are not current operator workflows:

- Email notification creation, queue consumption, SES delivery, bounce or
  complaint ingestion, and automatic retry processing.
- Offline PWA shell, cached event data, IndexedDB command outbox, device claims,
  sync status, and offline conflict resolution.
- Camera QR scanning and general visible-number fallback outside the finish and
  return stations.
- Event-specific assignments; current roles are organization-wide.
- Random draw scanning into balanced heat bags, heat claims, and undo-last heat
  loading.
- Physical bag/location history, winners-bag verification scans, and announcer
  completion/check-off records.
- In-race lost-duck replacement, found-duck handling, two-duck swap, and finalist
  replacement policy.
- Heat cancellation or rerun operation.
- Participant QR-code generation, verified private-link recovery, or removing a
  single registration from a browser collection.
- Automatic schedule transitions, result timing, payments, waivers, divisions,
  or more than two rounds.

## Legacy Design History

The following documents remain useful design history and supporting context,
but their planned or future-tense features do not override this specification:

- `README.md`
- `docs/PROJECT_PLAN.md`
- `docs/REGISTRATION_API.md`
- `docs/SCAN_PAIRING_AND_PARTICIPANT_STATUS.md`
- `docs/HEAT_ASSIGNMENT_AND_NOTIFICATIONS.md`
- `docs/STAFF_UX_AND_DUCK_RECOVERY.md`
- `docs/RACE_LIFECYCLE_AND_DUCK_REUSE.md`

Important reconciliations include:

| Legacy statement | Canonical current behavior |
| --- | --- |
| Granular provisioner, registration, official, viewer, or race-director roles | Seven composable operational roles exist; system administrator remains a separate account flag. |
| Balanced physical random draw and scan-to-load | Preview deterministically orders ducks and commits complete balanced rosters. |
| Immediate heats are fixed at ten | Capacity is configurable; current default is ten. |
| Heat/final capacity compatibility is validated | Operators must verify it; current planning does not enforce final compatibility. |
| Email assignment/upcoming/result messages are sent | Preference and support schema exist, but creation and delivery are not operational. |
| Offline cache and outbox permit race-day work | Every authoritative operation is online-only. |
| Protected Android Web NFC provisions tags | Implemented for blank writable NDEF stickers with durable reservation, write, confirmation, and recovery phases. |
| QR and visible number are universal fallbacks | Opening the URL works; the finish station accepts canonical tag URLs or roster duck numbers, and returns accept numbers, but fallback is not universal. |
| Private status shows duck, heat, and results | Current private status also includes privacy-filtered race progress and result state. |
| Public event pages list all heat winners and podium | This is now implemented through the privacy-filtered live race board from registration-open through completed. |
| Role-filtered inspection hides contact data from some staff | Contact data is limited to registration, race-director, and administrator authority. |
| Lost-duck replacement, swap, and location tracking work throughout the race | Only pre-race reassignment and tag replacement are implemented. |
| Result correction is administrator/race-director only | This is current behavior; result takers can finalize but cannot correct or reopen. |
| Announcer checklist and physical placement are recorded | Only read-only rosters exist; these are operator steps. |
| Multiple annual events/history are retained | Only one event dataset may exist, and full race data is purged before the next event. |

Infrastructure and domain setup documents remain authoritative for their own
deployment and permanent-origin subjects, but not for application workflows.
