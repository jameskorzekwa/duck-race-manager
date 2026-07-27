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
| Delete an unpaired registration | `REGISTRATION` or `RACE_DIRECTOR` | Yes |
| Participant disqualification/reactivation | `RACE_DIRECTOR` | Yes |
| Participant contact data and registration notes | `REGISTRATION` or `RACE_DIRECTOR` | Yes |
| Duck inventory intake/edit, tag, assignment, unassignment, reservation, and inspection | `DUCK_MANAGER` or `RACE_DIRECTOR` | Yes |
| Take over another operator's abandoned pending sticker provisioning | `RACE_DIRECTOR`, after 10 minutes | Yes, after 10 minutes |
| Event list/detail context | Any operational role | Yes |
| Event readiness, heat list/detail/announcer-roster, result, and finalist reads | `ANNOUNCER`, `HEAT_RUNNER`, `RESULT_TAKER`, or `RACE_DIRECTOR` | Yes |
| Lock, ready, call, and start heat | `HEAT_RUNNER` or `RACE_DIRECTOR` | Yes |
| Finish heat and finalize required result/podium | `RESULT_TAKER` or `RACE_DIRECTOR` | Yes |
| Open `/staff/start-line` | `HEAT_RUNNER` or `RACE_DIRECTOR` | Yes |
| Open `/staff/announcer` (read-only) | `ANNOUNCER` or `RACE_DIRECTOR` | Yes |
| Open `/staff/finish-line` and resolve a roster duck by tag URL/number | `RESULT_TAKER` or `RACE_DIRECTOR` | Yes |
| Event lifecycle, planning, roster changes, result correction/reopen | `RACE_DIRECTOR` | Yes |
| Create/configure/delete draft; reopen registration | None | Yes |
| Staff management; support diagnostics/notifications/audit | None | Yes |
| Open `/staff/access` | None | Yes |
| Delete event: the whole dataset in any state | None | Yes |

The operational role vocabulary is `REGISTRATION`, `DUCK_MANAGER`, `ANNOUNCER`,
`HEAT_RUNNER`, `RESULT_TAKER`, and `RACE_DIRECTOR`. Granting or assigning any
other value is rejected as an invalid request.

All staff APIs still require an active profile. Authentication loads and
validates current assignment rows from D1 on every request. A regular account
with no current roles receives `403` for operational routes; there is no broad
production fallback. Role checks happen server-side even when the console hides
an unauthorized section. Heat and announcer responses include roster names as
required for race operation, but no contact fields.

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
  -> deleted by Delete event
```

The lifecycle is exactly these six statuses.

`REGISTRATION_CLOSED` can return to `REGISTRATION_OPEN` only before any heat
exists and only by a system administrator. `COMPLETED` is terminal: race results
stay publicly visible there indefinitely. The only way out of `COMPLETED` is a
system administrator running Delete event, which removes the whole dataset.

Duck returns and dispositions are not tracked. There is no return review, no
return batch, and no staged purge ceremony.

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

1. A system administrator creates the only event as a draft, choosing how many
   ducks race in each round-one heat (at least 3), and configures it before
   registration.
2. A race director opens registration.
3. Participants self-register, or registration staff create walk-ups.
4. Duck managers intake physical ducks and active tag tokens for the event.
5. Registration staff pair each eligible participant with one eligible duck.
   Each pairing also places the duck into the lowest-numbered round-one heat
   with an open slot, creating the next heat automatically when every existing
   heat is full. This is the only heat assignment model.
6. A race director closes registration. If the last heat holds fewer than three
   ducks, closing folds it into the heat before it, which goes over capacity.
7. Registration staff and the race director resolve every still-submitted
   participant and check readiness. An administrator may reopen registration at
   any point before round one starts, which splits a folded tail back out.
8. The race director starts round one, which locks every round-one roster in the
   same command; heat runners run heats; result takers finish them and publish
   one winner per heat.
10. Race readers verify automatic finalist promotion and the race director
    starts the final.
11. Heat runners run the final and a result taker publishes the complete podium.
12. The race director completes the event. Results stay publicly visible.
13. When the race is finished with, a system administrator deletes the event,
    which permanently removes the whole race dataset.

### Lifecycle Command Retry and Refresh

Every lifecycle endpoint requires a UUID command ID. A fresh transition writes
the command, guarded event update, and audit record in one atomic D1 batch and
returns `201` with `transitioned: true`. Source-state and readiness predicates
remain authoritative, so commands cannot skip states.

An exact retry with the same command ID and fingerprint returns `200`,
`replayed: true`, and the event's current state without another write. Reusing
that ID for another event or command remains a `409` conflict. A new command ID
sent from a stale control after the event has already reached the requested
target also returns `200` without writing only when command history proves that
the same transition completed and is the latest event-state command. The check
therefore distinguishes all alternate inbound paths, including the two paths to
`REGISTRATION_OPEN`: an old `OPEN_REGISTRATION` command does not make another
open command valid after `REOPEN_REGISTRATION`. Missing history, a different
inbound transition, or a state beyond the requested target remains blocked.

The staff console assigns one command ID to each rendered lifecycle control and
disables it before the request, preventing double submission. It applies the
authoritative event in a successful mutation response immediately, removes the
stale controls, and then refetches all event operations. An overlapping refresh
with a lower event revision cannot replace that response. If the mutation
response is lost, the console first refetches: a changed state remains disabled,
while an event still in the source state re-enables the same control with the
same command ID for a safe retry.

The console derives each readiness card's display from the event's current
status against the canonical status order; the readiness API itself is
unchanged. A forward transition whose target status the event has already
reached or passed shows a positive **Done** chip with no action button and no
blocker text. **Ready** marks a transition whose server readiness checks pass,
and **Blocked** with its server blocker reasons appears only for genuinely
upcoming transitions. The backward reopen-registration control shows a neutral
**Not needed** chip while the event is already `REGISTRATION_OPEN`; whenever
reopening is genuinely unavailable (wrong state, or heat rosters already locked
for racing) it keeps the blocked treatment and reasons.

## Public Site Phases

**Implemented:** every public page derives one phase from the single current
event, using one lightweight status query per HTML request. The phase drives
navigation, the home call to action, and what `/register` and `/race` render.

| Phase | Event state | Navigation | Home CTA |
| --- | --- | --- | --- |
| Preparing | no event, or `DRAFT` | Home, Staff | none; the hero says the next race is being prepared |
| Registration | `REGISTRATION_OPEN` | Home, Register, My Ducks, Staff | Register |
| Locked in | `REGISTRATION_CLOSED` | Home, Race Status, My Ducks, Staff | View race status |
| Racing | `ROUND_ONE`, `FINAL` | Home, Race Status, My Ducks, Staff | View live race |
| Results | `COMPLETED` | Home, Race Status, My Ducks, Staff | View results |

Register and Race Status strictly swap: the navigation offers exactly one of
them after `DRAFT` and neither while a race is being prepared. `/race` itself
stays reachable for all five post-`DRAFT` statuses, including while registration
is open, even though the navigation does not advertise it then. Staff stays in
the top navigation in every phase.

My Ducks appears whenever the phase is Registration or later, or when the saved
registration presence probe reports that this device has saved registrations.
The phase half of that rule is server-rendered; the presence half is applied by
`participant.js`, and neither can hide a link the other grants.

Navigation is correct on first paint and does not need a refresh to stay
correct: `live-ui.js` subscribes to the `event` domain of the live hub and
re-renders the navigation from `GET /api/v1/events/current`, the same
authoritative projection the server used, whenever the race advances.

That subscription is admitted per page. The live hub opens its WebSocket and
starts its polling fallback only once a page has a subscriber, and the
`RaceUpdates` object admits a limited number of connections, so pages with no
live need must not spend one. The server marks public content pages — the home
page, `/race`, `/my-ducks`, `/register`, `/duck/<number>`, `/r/<token>`, and
`/t/<token>` — with `data-live-nav` on the navigation element, and only those
pages register the navigation subscriber. The staff sign-in page, the not-found
page, the unsupported-device page, and staff error pages carry no marker and no
other live surface, so they open no socket and schedule no polls, and they keep
the navigation exactly as the server painted it.

The not-found page is the one public response that resolves no phase at all.
Every unmatched path reaches it, including bot and scanner traffic, so it runs
no current-event query and always renders the minimal Home and Staff
navigation.

Navigation chrome is never worth an outage. If the phase query itself fails —
D1 unavailable, degraded, or a transient error — the page still renders and
falls back to the Preparing phase instead of returning a server error. Preparing
is the conservative fallback: it is the same phase "no public event" produces,
and it advertises neither Register nor Race Status, so a database hiccup can
never invite a visitor into a flow that is not open. The degraded first paint
self-corrects, because `live-ui.js` rebuilds the navigation from
`GET /api/v1/events/current` on the next live signal or poll. The fallback is
limited to HTML page renders; the API routes that report authoritative state,
including `GET /api/v1/events/current` itself, keep surfacing database failures
rather than answering with a guess.

## Participant Registration

### Public Registration

**Implemented:** `/register` renders by phase. While a race is being prepared it
shows only "The next race is being prepared. Registration is not open yet, please
come back later to register!" with no form, privacy block, notice, or
multi-registration hint. From `REGISTRATION_CLOSED` through `COMPLETED` it shows
"Registration is closed." and a link to `/race`, and nothing else.

During `REGISTRATION_OPEN` it loads the current public event and enables the form
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
- A successful Turnstile response.

The safe current-event response includes the configured public-name policy. The
form applies it to the entered name and states the exact public display, while
also stating that email and phone remain private.

Duplicate names, email addresses, phone numbers, and shared browsers are
allowed. Every submission creates an independent registration and stable race
entry. Registration does not ask whether the participant plans to keep or return
the duck. Staff record only the actual physical disposition after the race.

The database retains the legacy `race_entries.duck_keep_preference` column for
compatibility. New entries use its existing default, and the application does
not read, explicitly write, expose, or make decisions from that column. Stored
values on existing rows are ignored and are removed with the race entry when the
event is deleted.

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

Before leaving `/register`, the browser strictly validates the returned
registration UUID and same-origin relative `/r/<private-token>` path. It attempts
to save only those two values as a transient `sessionStorage` handoff, tolerates
storage being unavailable, and redirects to the required
`/my-ducks?registered=<registration-uuid>` destination. The private path and
token are never placed in the redirect URL, browser history, or logs. No duck or
heat is assigned by public registration.

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

The primary navigation reveals **My Ducks** only after a lightweight collection
probe returns `{ hasRegistrations: true }`. Non-My-Ducks pages use this probe;
it applies the same cookie validation, invalid-cookie clearing, and sliding
expiry refresh as the full collection endpoint, but queries only whether one
collection link exists. It never selects or returns names, lookup codes, race
entries, status details, contact fields, or private paths.

A collection link records how it was created. A link created by registering in
that browser is `REGISTRATION`; a link added from the public name search, a duck
tag scan, or a public duck page is `FOLLOWED`. Registering always claims the link
as `REGISTRATION`, so following a participant first can never suppress that
browser's own registration data.

The dedicated noindex `/my-ducks` page loads the full safe collection. It shows,
for each collected registration:

- For a registered entry, the full participant name and the staff lookup code
  from the private browser collection.
- For a followed entry, a **Following** tag, the event's policy-filtered public
  display name, and no lookup code at all. The collection response returns
  `lookupCode: null` and null name parts for these entries, because the public
  search that produced them exposes neither.
- Registration status.
- Privacy-filtered race status, including duck, heat, current heat, and outcome
  when public race status is available.
- A `deletable` flag, which is `true` only for an entry this browser created and
  that can still be removed. See **Deleting Your Own Registration**.
- `duckName` and a `nameable` flag, both owner-only. See **Naming Your Own
  Duck**.

Cards are grouped into three horizontally swipeable sections with keyboard and
previous/next controls: **Awaiting Participants** and paired **My Ducks** hold
the participants registered on this device, and **Ducks I'm Following** holds
every `FOLLOWED` entry whether or not that participant has a duck yet. The page
states the difference in place: entries registered here keep their full details
and staff lookup code, and followed entries show the public projection only. A
live or polling refresh immediately regroups a registered card when staff pair
or unpair its participant. A group with no participants hides its entire
section, including its heading and controls, rather than rendering an empty
state; when all groups are empty the page keeps one guidance message so it is
never blank. Sections stay hidden until the first successful full collection
response, so a failed initial request shows only the error-only line and keeps
checking rather than claiming an empty collection.

After the registration redirect, the page highlights the matching registration.
Only after that UUID appears in a successful full collection response does the
page validate and consume the matching handoff. A valid handoff must contain
exactly the matching registration UUID and a same-origin relative
`/r/<valid-private-token>` path. Safe consumption removes it from
`sessionStorage` and adds an accessible **Open private status** link to the
just-registered notice so the participant can open and bookmark it. Invalid,
cross-origin, absolute, malformed, mismatched, unreadable, or non-removable
handoffs are never exposed. Full collection and presence responses never return
the private path or token.

The page refreshes through the shared live-update hub after a matching
event, participant, duck, heat, or return signal. While the live connection is
healthy, an approximately 30-second integrity refresh covers missed signals;
while it is unavailable or disconnected, polling increases to approximately
every five seconds. Polling and rendering pause in a hidden tab and resume with
an authoritative refresh when the tab becomes visible.

The collection cookie does not contain names, contact details, lookup codes, or
private status tokens. Clearing or expiring the cookie removes the shortcut but
does not withdraw or delete registrations.

Public race status in a collection stays available through `COMPLETED`. It
becomes `null` only when an administrator deletes the event, which also removes
the collection's registration entries.

### Deleting Your Own Registration

**Implemented:** a My Ducks card can offer one **Delete registration** action for
a registration created by mistake. The action removes the registration for real;
it is not a withdrawal and not an unfollow.

The button is rendered only when the collection response marks that entry
`deletable: true`, which requires all of the following at once:

- The collection link for this browser is `REGISTRATION`, meaning the
  registration was created on this device. A `FOLLOWED` entry is someone else's
  registration and is **never** deletable here.
- The race entry has no duck assignment at all, current or already ended. In
  practice this means the card is in **Awaiting Participants**; an entry that was
  paired and later unassigned is still not deletable.
- The race entry appears on no heat roster.
- The event is `REGISTRATION_OPEN`, `REGISTRATION_CLOSED`, `ROUND_ONE`, `FINAL`,
  or `COMPLETED`. A registration that has no duck and no heat place never entered
  the race, so removing it cannot affect any published heat or result.

The action opens the shared danger confirmation dialog in plain wording, then
posts `{ commandId, registrationId }` to
`POST /api/v1/registrations/mine/delete`. The endpoint requires
`application/json`, a bounded body, and the exact application `Origin`, because
the browser collection cookie is its only credential. It validates the RFC 4122
v4 command identifier and the registration identifier before any database
access, and applies the same public rate limiter as the name search and follow.

Command replay is resolved before anything else, from command history alone:
deleting the same registration twice with the same command identifier returns
`{ deleted: true, replayed: true }` rather than failing, because the registration
and its collection link no longer exist to be re-read. Reusing that identifier
for a different registration is `409`.

A caller that does not own the registration as `REGISTRATION`, a caller with no
collection cookie, and an unknown identifier all receive the same `404`, so the
endpoint never reveals whether an unrelated registration exists. A registration
that already has a duck or a heat place receives `409` with plain guidance to ask
race staff.

Ownership, link kind, event status, and unpaired state are re-checked inside the
guarded `race_commands` insert that opens the write batch, not only in the
preflight read. Every child delete in the batch is conditional on that command
row existing, so a refused attempt writes nothing.

A successful delete removes the registration, its race entry, its collection
links in every browser including followers, and any email notification and
attempt rows, in one atomic batch. The `race_commands` and redacted
`REGISTRATION_DELETED` audit rows deliberately outlive the subject; the audit
records the registration identifier and `deleted_via`, never a name, contact
value, lookup code, or token. The mutation publishes the `participants` refresh
domain, and the page rerenders from the authoritative collection endpoint rather
than from the delete response.

### Unfollowing a Duck You Follow

**Implemented:** a followed My Ducks card offers one **Stop following** action.
It posts `{ commandId, registrationId }` to
`POST /api/v1/registrations/mine/unfollow` and removes exactly one thing: this
browser's `FOLLOWED` collection link. It is not a deletion and not a withdrawal,
it never touches the registration or its race entry, and it is reversible by
following again, so it asks for no destructive confirmation.

The endpoint mirrors the follow and delete endpoints' transport rules: JSON only,
a bounded body, the exact application `Origin`, RFC 4122 v4 command identifier
and registration identifier validated before any database access, and the shared
public rate limiter. Replay is resolved from the command history first, so
retrying the same command after a committed unfollow returns
`{ "unfollowed": true, "replayed": true }`; reusing that identifier for a
different registration returns `409`.

A missing or unknown collection cookie, an unrelated registration, and a link
this browser holds as `REGISTRATION` all receive the same `404`, so the endpoint
never reveals whether an unrelated registration exists and can never be used to
delete a registration. Ownership of a `FOLLOWED` link is re-checked inside the
guarded `race_commands` insert that opens the write batch, and the single
`DELETE` is conditional on that command row and scoped to this collection, this
registration, and `added_via = 'FOLLOWED'`. The mutation publishes no refresh
signal because it changes nothing any other browser can see; the page rerenders
from the authoritative collection endpoint rather than from the response.

### Naming Your Own Duck

**Implemented:** once staff pair a duck to a participant registered on this
device, that card offers a **Give this duck a name** form. It posts
`{ commandId, registrationId, duckName }` to
`POST /api/v1/registrations/mine/duck-name`, and the name is stored on the race
entry.

The value is trimmed, internally whitespace-collapsed, and must be 1 to 40
characters; blank-after-trim, overlong, and control or format characters are
rejected with `422` before any database access, and the migration's `CHECK`
repeats the same bound. Transport rules match the other public collection
mutations exactly, including the exact `Origin` and the shared rate limiter.
Retrying the same command with the same name replays; reusing that identifier
with a different name returns `409`. The command row stores only a hash of the
accepted name, and the redacted `DUCK_NAME_SET` audit event records the changed
field name, never the text.

Only a `REGISTRATION` link may name, and only while a duck is currently assigned
to that entry. A followed link, an unrelated registration, and a missing cookie
are one indistinguishable `404`; an owned entry with no duck yet returns `409`.
The My Ducks projection reports the same permission in advance as `nameable`.

**Deliberate scope:** the chosen name is shown only in the owner's own My Ducks
view on the device that wrote it. It replaces "Duck #N" on that card, with the
number kept beside it so the card still matches the physical duck. It is
unmoderated free text for a public community event, so it never appears on the
public race board, the public duck pages, the tag scan pages, another browser's
followed card, or any staff-facing race operation: all of those keep the
canonical duck number.

### Private Status Link

**Implemented:** possession of the high-entropy `/r/<private-token>` URL is the
authorization credential. D1 stores only its SHA-256 hash. The HTML page shows
the full participant name, registration state, staff lookup code, event name,
and event date. The JSON endpoint also returns submission time. The endpoint
includes, and the HTML renders, the same
privacy-filtered race-status facts used by the browser collection and public
status: current duck, assigned round-one and final heat, current event heat, and
race outcome. Neither response returns email or phone.

The private HTML page refreshes these registration and race facts after live
signals and through the same polling fallback. The private token remains the
credential and is never sent through the live signal channel. A missing private
record clears the rendered participant facts instead of leaving stale data on
screen; deleting the event revalidates the server route immediately.

**Operator step:** tell participants to bookmark the private link and separately
save the short lookup code. The short code is not authorization for the private
page and staff cannot regenerate its private token.

### Public Name Search

**Implemented:** the `/my-ducks` page can search the current public event by an
exact, case-insensitive first name, last name, or full name. The search is the
recovery path for a device that lost its saved list, so it leads the page while
nothing is saved on that device and sits below the saved ducks otherwise.
Partial matching is not
performed. The query must contain 2 to 161 characters, returns at most ten
matches, and is limited to 20 requests per minute for each event and Cloudflare
client network key.

Only `SUBMITTED` and `ACTIVE` registrations in events from
`REGISTRATION_OPEN` through `COMPLETED` are searchable. Display names follow the
event policy: first name, first name plus last initial, or full name. Search can
show pairing pending, assigned duck, heat, current heat, and race outcome. It
never returns contact details, lookup codes, private links, staff notes,
inventory state, location, or audit data.

Each result also carries an opaque `followId` and an `inMyDucks` flag. The flag
is a read-only probe of the caller's own collection cookie; a search never
refreshes or issues that cookie. The identifier unlocks nothing beyond the
public status already shown in the same response.

Name search restores public status only. It does not restore the private link,
the lookup code, or a full name, and it does not show withdrawn or disqualified
registrations. After a submitted search, relevant event, participant, duck,
heat, and return signals rerun that same authoritative search automatically.
Unsaved edits in the search control are not replaced.

### Adding a Search Result to My Ducks

**Implemented:** each search result offers one **Add to My Ducks** action that
posts its `followId` to `POST /api/v1/registrations/mine/follow`. The endpoint
requires `application/json`, a bounded body, and the exact application `Origin`,
validates the identifier's shape and the shared public rate limit before any
database access, and then requires the identifier to still resolve to a publicly
searchable entry of the current public event. Anything else is rejected without
a write. Adding the same participant twice is a no-op success.

The link is written as `FOLLOWED`, and the action confirms in place and reveals
the **My Ducks** navigation. A result already in the collection renders the
confirmed state instead of the action. Because the search response carries no
lookup code and no private token, a followed entry can never gain either one,
and `/api/v1/registrations/mine` returns `lookupCode: null` for it.

### Following from a Duck Tag Scan or a Duck Page

**Implemented:** the anonymous tag scan page `/t/<tag-token>` and the public duck
page `/duck/<visible-number>` offer the same **Follow this duck** action, posting
to the same `POST /api/v1/registrations/mine/follow` endpoint with the same
`followId` and writing the same `FOLLOWED` link. A browser that already holds
that participant — whether it registered them or followed them earlier — sees the
**In My Ducks** state and a link to the saved list instead of an action.

Both duck responses (`GET /api/v1/ducks/<tag-token>` and
`GET /api/v1/ducks/number/<visible-number>`) carry the same `followId` and
`inMyDucks` signals as a search result, and only for a participant the follow
endpoint would actually accept: a withdrawn or disqualified registration, or one
outside the current public event, carries neither signal and its page renders no
control. The membership check is a read-only probe of the caller's own collection
cookie, so a tag GET stays read-only and issues no cookie. Nothing else about
these responses changed: they still carry no contact details, lookup code,
private link, duck name, or staff data.

### Public Duck Detail View

**Implemented:** `/duck/<visible-number>` is a public page for one duck,
addressed by the number printed on the duck and shown on the live board. It
needs no tag, no token, and no cookie.

The number is resolved against the same event the public race board renders, and
only while that event is between `REGISTRATION_OPEN` and `COMPLETED`. The page
reuses the shared public status projection, so it can show the event, the
policy-filtered participant name, the visible duck number, the round-one heat,
the final heat, the heat currently running, the race outcome, and an official
finishing place once a heat is finalized. It never shows contact details, lookup
codes, private links, raw tag tokens, inventory location, staff notes, or audit
history.

`GET /api/v1/ducks/number/<visible-number>` returns the same projection as
`{ "raceStatus": ... }`. Only canonical positive integers resolve; a
non-canonical value is rejected before any database access.

Unknown numbers, ducks that exist in inventory but are not paired, and ducks
outside the current public event are indistinguishable: all three return `404`
from the API and one identical friendly page, sent `noindex, nofollow` like the
other public duck and status pages. The page therefore adds no enumeration
signal beyond the duck numbers the board already publishes.

The live race board and the paired My Ducks cards link their duck numbers to
this view as plain navigations. An entry with no duck assigned renders text and
no link. The page itself refreshes through the shared live hub on the `event`,
`participants`, `ducks`, `heats`, and `returns` domains and refetches the
authoritative API, exactly like the other public pages.

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
unassigned, and deleted tags therefore do not expose inventory metadata. A successful status page can show the event, policy-filtered
participant name, visible duck number, assigned round-one/final heat, current
active heat, and race outcome. It never shows contact details, lookup codes,
private links, staff history, or storage location.

### Authenticated Staff Scan

**Implemented:** a staff browser opening `/t/<tag-token>` is redirected to the
protected staff duck page. `REGISTRATION`, `DUCK_MANAGER`, `RACE_DIRECTOR`, and
administrators may inspect a known tag. Registration and race-director views can
include participant identity, lookup code, email, and phone. Duck-manager views
retain inventory/relationship data without participant identity or contacts.

An active, available or event-reserved, unassigned duck is offered for pairing
only to registration-authorized accounts. An assigned or ineligible duck remains
an inspection view.
Closed historical assignments remain in history but do not appear as the
current assignment or suppress the pairing prompt after unassignment. The page
offers pairing and inspection only; there is no disposition entry.

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

Authentication and the inventory-role check run before the page's Android
compatibility gate. An authorized request with a missing or non-Android user
agent receives a noindex unsupported-device response with only a link back to
staff inventory; it does not receive station markup, configuration, or
provisioning data. User-agent detection is an advisory compatibility check, not
an authentication, authorization, or security boundary. A user agent can be
spoofed.

On the accepted Android page, provisioning controls remain hidden and no station
API is called until browser runtime checks confirm Android Chrome, `NDEFReader`,
a secure context, a top-level tab, and a visible document. The same conditions
are checked again on Start. iPhone, iPad, desktop, Android WebView, alternate
Android browsers, spoofed clients without Web NFC, embedded pages, insecure
contexts, and hidden documents receive no provisioning API user experience.
Provisioning APIs do not trust or require a user agent: they continue to enforce
live staff authentication, inventory roles, and same-origin provenance for
cookie-authenticated mutations, including for automated API clients.

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

Every staff page also renders one persistent staff navigation listing only the
pages the signed-in actor may open: **Console** (`/staff`, any staff member),
**Access** (`/staff/access`, system administrator), **Start line**
(`/staff/start-line`, `HEAT_RUNNER` or `RACE_DIRECTOR`), **Announcer**
(`/staff/announcer`, `ANNOUNCER` or `RACE_DIRECTOR`), **Finish line**
(`/staff/finish-line`, `RESULT_TAKER` or `RACE_DIRECTOR`), and **Inventory**
(`/staff/inventory-intake`, `DUCK_MANAGER` or `RACE_DIRECTOR`). A system
administrator sees every link. The current page is marked `aria-current="page"`.
The navigation wraps rather than scrolling, so it never overflows a 320px
viewport. Omitting a link is convenience only; each page repeats its own check.

**Operator step:** sign in and load the console on every intended device before
race operations. Do not assume the browser remains authorized beyond seven days.
There is no offline session or cached staff authorization. Every authenticated
request loads the active staff profile live; deactivation blocks access.
Cognito revocation or global sign-out prevents further refresh but does not make
offline verification of an already issued access token observe revocation.

Every rendered staff page also carries only its current administrator flag and
operational-role names. A generic `staff` invalidation makes the browser call
`GET /api/v1/staff/session`, which returns only that authorization projection.
If the profile was deactivated, the page removes rendered protected data before
returning to staff sign-in. If access was reduced, it clears and server-reloads
immediately; added access reloads once no form or command is in progress. The
WebSocket signal contains no staff identifier, email, display name, or role
mutation payload.

## Staff Access Page

**Implemented:** staff account and role management is event-independent, so it
is the standalone administrator page `/staff/access` rather than a console
section. An anonymous request receives `303` to
`/staff?returnTo=%2Fstaff%2Faccess`; an authenticated non-administrator receives
`403`; a system administrator receives the page. Like the other staff pages it
is `noindex`, `no-store`, carries the Cognito form-action content-security
policy and same-origin referrer policy, and propagates rotated session cookies.
Its browser client is served from `/assets/staff-access.js` with `no-store`.

The page lists every authorized staff account with its account type, operational
roles, and active state, and offers one **Add staff access** card that creates a
Cognito account and staff profile. Role, deactivation, and reactivation commands
are unchanged; each one confirms through the shared application dialog. The page
subscribes to the `staff` live domain and keeps the same staff-session
revalidation as the other protected pages.

## Event Setup and Lifecycle

Any operational role can load event list and event detail context needed by the
staff console. Event readiness and heat, announcer-roster, result, and finalist
reads are limited to announcers, heat runners, result takers, race directors,
and system administrators.

### Console Event Existence Gating

The console's **Event** section is always available. **Participants**,
**Inventory**, **Heats**, and **Support**, and their console
navigation anchors, are event-scoped: they are hidden in the served markup and
are revealed only when an event loads, so no section flashes and then vanishes.
Role gating still applies on top of event existence, so an event-scoped section
the actor may not use stays hidden even once an event exists.

While no event row exists the console hides all four sections and their anchors
and shows the Event section with a **No race yet** state and, for a system
administrator, the **Create event** card already open.

### Console Event Layout

The console's Event section is ordered setup-first. A system administrator sees
the collapsed **Create event** card directly under the section heading; other
roles see no create card. The **Working event** picker and its refresh button
follow. Everything about the chosen event then appears in one labelled
"Selected event details" region below the picker, in this order: the summary
facts, **Configure draft**, **Readiness and lifecycle**, **Delete empty draft**,
and **Delete event**. Administrator-only cards remain administrator-only, and
the configure and delete-draft cards still appear only while the event is a
draft.

That region is hidden in the served markup and is revealed once an event is
selected or defaulted. While no event row exists the console hides the region,
shows `Create a draft event to begin.` under the picker, and opens the create
card so the primary action is obvious.

### Create and Configure

**System administrator only:** create one event when no event row exists. Event
creation requires a name, a date, a timezone, and how many ducks race in each
round-one heat (a whole number from 3 through 10,000). The heat size is chosen at
creation because heats are set up before registration opens: ducks are assigned
to heats as they are paired with participants. The console detects the
operator's own zone with `Intl.DateTimeFormat().resolvedOptions().timeZone` and
sends it with the create command, so a new race starts in the zone the operator
is actually in rather than in the retained organization default. A create
request that omits the timezone still inherits that retained default. A new
event is always created in `IMMEDIATE_FIXED` (assign during pairing) mode, which
is now the only mode; the remaining settings copy the retained organization
defaults into a `DRAFT` event.
The server derives the URL
slug from the name as
lowercase ASCII letters, numbers, and hyphens; the staff form shows the same
read-only preview as the name changes. Diacritics are removed where possible,
unsafe-character runs become one hyphen, and names without safe characters use
a deterministic bounded fallback. Client-supplied slug values are ignored.

Only a draft can be configured. Configuration includes:

- Name, automatically derived slug preview, date, and timezone.
- Optional registration-open and registration-close timestamps.
- Optional or required email.
- Heat assignment is always `IMMEDIATE_FIXED`, meaning heats are filled as
  participants are paired. The retired `POST_CLOSE_BALANCED` planner no longer
  exists; naming it in a configuration request is rejected with `400`.
- Ducks per round-one heat from 3 through 10,000, and final capacity from 1
  through 10,000. The database CHECK stays at `> 0` so events configured before
  the minimum existed keep loading; the minimum is enforced in the API and in
  the console input.
- Public name policy.

Both timezone fields are dropdowns, never free text. The server renders only
the current value so no page carries hundreds of options; the browser then
fills the list from `Intl.supportedValuesOf("timeZone")`, falling back to a
bundled list of common zones when that API is missing. The detected zone is
labelled `(detected)` in the list. The shared app-select enhancement turns the
field into a searchable combobox: opening it reveals a filter input, typing
narrows the list (matching is case-insensitive, substring based, and treats
`_` and `/` as spaces so `new york` finds `America/New_York`), and arrow keys,
Home/End, Enter, Escape, and Tab keep working. The server accepts a timezone
only when it looks like an IANA identifier and the runtime's zone database
resolves it; anything else is rejected with `400` before any database access.
The accepted identifier is stored exactly as submitted, so zones stored earlier,
including legacy links such as `US/Mountain`, keep loading and saving unchanged.

Saving configuration also updates the retained organization defaults used by
the next event. Configuration is revision-checked; a stale form is rejected.
After registration opens, there is no supported configuration edit route.
Changing a draft's name regenerates its slug on the server. Saving other draft
settings leaves an existing persisted slug unchanged for compatibility.

An administrator may delete a mistaken draft only when its revision matches,
the typed text is exactly `DELETE <event name>`, it contains no race data, and
it has no operational command/audit history other than creation and
configuration. A detached deletion audit remains, while organization defaults
remain available.

### Open and Close Registration

A race director or system administrator can open a dated draft whose
ducks-per-heat (round-one heat size) configuration is present. Any legacy event
row lacking that value is blocked with a clear readiness reason; creation now
requires the field, so every new event satisfies this automatically. Opening
does not check other setup, inventory, or staffing readiness. The same
authority can manually close an open event.

A system administrator can reopen registration while the event is
`REGISTRATION_CLOSED` and no heat roster has been locked. Existing heats do not
block a reopen: heats are created as participants are paired, not afterwards, so
they are the normal state at this point. Reopening also splits back out any tail
heat that closing had folded into the heat before it, restoring the pre-close
layout exactly.

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
- Every round-one heat holds at least three entries. The blocker names reopening
  registration and signing up more participants as the remedy.
- The round-one heat count does not exceed final capacity.
- Every round-one heat is still `PLANNED`, `LOADING`, or `READY`.

Starting round one also locks every planned round-one roster, moving it to
`LOADING` and stamping `roster_locked_at`, in the same guarded batch as the
event transition.

**Operator step:** resolve every unpaired submission by pairing, withdrawal, or
administrative disqualification before starting. If a heat would race with fewer
than three ducks, reopen registration rather than trying to start.

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
final has not started. Starting the final locks the final roster in the same
guarded batch, exactly as starting round one does for round one.

A race director or system administrator can complete the event when the final is finalized,
all final heats are finalized or cancelled, and each finalized final contains
exactly places 1 through `min(3, final roster size)`.

`COMPLETED` is the final lifecycle status. There is no transition past it; the
event stays there, with results publicly visible, until an administrator runs
Delete event.

## Participant Corrections and Status Changes

### Edit Details

Registration staff, race directors, and administrators can list and filter
participants, inspect details, and edit name, email, phone, email-notification
preference, and staff notes. Edits are allowed while the event is `REGISTRATION_OPEN`,
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

### Delete Registration

Registration staff, race directors, and administrators can permanently delete a
registration from the participant detail pane with
`DELETE /api/v1/staff/registrations/<registrationId>`. Use it for a duplicate or
mistaken entry. It is not a substitute for withdrawal or disqualification, which
are the correct tools for someone who registered legitimately and then stopped
racing.

The request follows the other staff participant mutations: an RFC 4122 v4
`commandId`, the currently loaded `expectedRevision`, the exact application
`Origin` for cookie-authenticated sessions, and a confirmed danger dialog in the
console. A matching retry returns `{ deleted: true, replayed: true }` from
command history, because the registration no longer exists to be re-read;
reusing the identifier for another operation is `409`.

**Unassign first.** Deletion protects race integrity instead of tearing it down.
It is refused with `409` and an actionable message when either of the two
race-integrity relationships still exists:

- The participant has any duck assignment, current or already ended. The message
  directs staff to the existing inventory unassignment workflow. Note that
  unassigning is not by itself enough for this path: an ended assignment row
  still exists and still blocks deletion, because that participant genuinely was
  paired.
- The participant appears on any heat roster. The message directs staff to
  unassign the duck and remove the participant from the heat first.

Because a participant with any heat entry is refused outright, deletion can never
reach the roster-lock trigger and can never remove a locked, running, or
finalized roster row. The duck assignment and heat entry are left exactly as they
were on a refusal.

Deletion is also refused with `409` while the event is `DRAFT`, and `404` for an
unknown registration.

A successful delete runs as one atomic batch that removes the registration, its
race entry, its browser collection links, and its email notification and attempt
rows. Every child delete is conditional on the guarded `race_commands` insert
that opens the batch and re-checks revision, event status, and the unpaired
conditions, so a refused write leaves the database untouched and
`PRAGMA foreign_key_check` stays clean. The command row and a redacted
`REGISTRATION_DELETED` audit event survive the subject; the audit records the
staff profile identifier, `created_via`, and the previous revision, never a name,
contact value, lookup code, or token. The mutation publishes the `participants`,
`ducks`, and `heats` refresh domains.

## Duck Intake, Tags, and Assignment

### Intake

Duck managers, race directors, and administrators can provision and reserve a
duck during `DRAFT`, `REGISTRATION_OPEN`, or `REGISTRATION_CLOSED`. The normal
staff console still exposes the older explicit inventory form for supervised
administrative work, but it is not a fallback inside the dedicated station.
`/staff/inventory-intake` has no per-duck number, token, URL, condition, notes,
or physical-presence inputs. The operator selects the event and may set one
station-level storage location of at most 100 characters. The dedicated page is
served only after authentication, role authorization, and an Android user-agent
compatibility check; its client does not reveal or initialize the station until
all Android Chrome Web NFC and page-context requirements pass.

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

**End NFC provisioning** is visible only while Web NFC scanning is active. It
aborts the browser scan and restores **Start NFC provisioning** without clearing
confirmed counts or history. It is disabled while a reading or removal state is
active and whenever the station owns a pending server reservation; the operator
must finish that exact sticker before ending, so the control cannot silently
abandon a `PENDING_WRITE` item.

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

If a reading contains canonical QuickDucks URLs, the browser deduplicates them
and classifies every distinct URL in physical record order through the protected
provisioning endpoint before any reservation, write, or confirmation. With no
pending operation, any classified tag row that still identifies a duck in the
current dataset flashes **This duck is already registered in inventory**,
immediately returns to **Ready**, and does not allocate, write, confirm, or
increment **Added this session**. This includes active, retired, released,
different-event, and another operator's pending tags, regardless of whether an
absent/reusable record appears before or after the known record.

While this station owns a pending operation, only a reading containing exactly
its one pending URL can finish it. A pending URL mixed with a reusable URL, or
multiple inconsistent known URLs, fails safely after complete classification
without writing, confirming, clearing command IDs, or changing either count. If
the exact local pending URL now classifies as already, the station resolves the
same confirmation command instead of treating the tag as unrelated. A replayed
confirmation response completes that current addition exactly once, increments
session history/count once, enters **Remove duck**, and then returns to
**Ready**. Only a separately scanned current tag receives the count-neutral
already-registered warning.

An exact canonical URL absent from the current dataset is reusable rather than a
permanent duplicate. This is the expected state for a physical duck after the
event is deleted: the normal two-phase flow allocates new inventory and overwrites the
old URL with newly generated provisioning information. No tombstone or
cross-race compatibility row is retained. Blank tags and unrelated NDEF content
are likewise writable after the station starts.

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

### Console Inventory Sections

The console's Inventory list groups the duck cards into labelled sections that
are derived from the inventory projection itself, not from any new state:

1. **In use** — the duck holds an unreleased event reservation, has an open
   participant assignment, or its inventory status is `IN_USE`. Reservation and
   pairing are checked first, so a reserved duck that is damaged or quarantined
   is still reported as in use.
2. **Ready to be reserved** — the duck is not reserved or paired and its
   inventory status is `AVAILABLE`, which is exactly the state assignment and
   scan-first pairing accept.
3. **Not ready to reserve** — every remaining status (`NEW`, `QUARANTINED`,
   `DAMAGED`, `MISSING`, `UNACCOUNTED_FOR`, `KEPT`, `RETIRED`) with no live
   reservation or assignment.

The first two sections are always rendered and state an explicit message when
they are empty; the third appears only when it holds ducks. Cards keep the
existing card grid, the sticky detail panel, selection and focus behaviour, the
detail request versioning, and live refresh.

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

The command uses the lowest-numbered unlocked round-one heat below the
configured ducks-per-heat size or creates the next heat inside the same atomic
batch. It returns the heat number. Pairing rejects before creating a new heat
when the existing round-one heat count has reached final capacity, and the
atomic command re-checks both the open slot and that capacity with guarded SQL.
Pairing stays available through `REGISTRATION_CLOSED` so a participant paired
after the close still lands in a heat.

**Operator step:** physically place ducks in a bag labeled with
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

### Assign-at-Pairing Heats

Heats are assigned while participants are paired with ducks, and there is no
other model. The ducks-per-heat size is chosen when the event is created and can
change only while the event is still a draft. Each new participant uses the
lowest-numbered eligible heat with fewer entries than
`round_one_heat_capacity`; otherwise QuickDucks creates the next heat in the
same atomic pairing command, so heats exist and fill progressively from the
moment pairing begins.

Concurrent attempts that select the same slot are protected by guarded SQL
inside the atomic batch — the slot is recomputed in the database and a full heat
aborts the whole command — plus uniqueness constraints; one attempt may receive
a conflict and must refresh/retry, which then lands in the next open heat.

Slot numbers are always contiguous from one within a heat, because pairing
computes the next slot as `COUNT(*) + 1` and `UNIQUE (heat_id, slot_number)`
would otherwise reject a repeat. Every operation below preserves that.

### Minimum Heat Size and Tail Rebalancing

A heat can only be raced with at least three ducks. That minimum is enforced in
three places:

- Event creation and draft configuration reject a `roundOneHeatCapacity` below
  three with `400`.
- Closing registration folds a short tail heat into the heat before it.
- Round-one start readiness reports a blocker, and the guarded `START_ROUND_ONE`
  SQL refuses, while any round-one heat holds fewer than three entries.

Because heats fill in pairing order, the last round-one heat is the only one
that can be short. Closing registration therefore runs one deterministic
rebalance in the same guarded batch as the status change:

- If the last heat holds one or two entries and there is an earlier heat, those
  entries move to the end of the earlier heat, which goes deliberately over its
  capacity, and the emptied heat row is deleted. With a capacity of 10 and a
  final heat of 2, the previous heat becomes a heat of 12.
- If the short heat is the only heat, there is nothing to merge into. Nothing
  moves, and round one stays blocked until registration reopens and more
  participants sign up.

Reopening registration reverses the fold exactly: the entries past the heat's
own recorded slot count move back out into a restored heat, and the heat's
capacity is restored. A close, reopen, one late registration, and second close
therefore converges on a legal three-duck heat rather than oscillating.

`heats.target_size` is the merge marker and needs no extra state. It records how
many slots a heat owns: pairing sets it to `round_one_heat_capacity` and never
inserts past it, and roster replacement rewrites it to the roster it just wrote.
A merge is consequently the only writer that can leave a round-one heat holding
more entries than its own `target_size`, and a merge can only run while
transitioning out of `REGISTRATION_OPEN`, so at most one such heat exists at a
time. Comparing against the heat's own `target_size` rather than the event
capacity is what keeps the marker correct when pairing continues after
registration closes and opens a fresh short heat behind the merged one.

Both operations are atomic without a post-commit repair step:

- A merge deletes the emptied tail heat last. `heat_entries` references `heats`
  `ON DELETE RESTRICT`, so an entry that failed to move aborts the delete and
  rolls the whole batch back.
- A split creates the restored heat only when exactly the expected entries are
  still past `target_size`. If it is not created, the moves reference a heat row
  that does not exist and the foreign key aborts the batch.

Both are guarded on their own lifecycle command row, so a transition that loses
its race writes nothing, and a replayed command identifier returns the recorded
result without moving anything a second time.

### Reopening Registration

Registration may reopen at any point before round one actually starts. Existing
heats never block it, because heats are created as people register rather than
afterwards. Newly registered participants simply fill the next available spot.
Reopening is refused once the event has left `REGISTRATION_CLOSED` or any heat
roster has been locked.

### Roster Correction

A race director or administrator can replace a nonempty roster only while the heat is
`PLANNED` and unlocked and the event is in that heat's active round. Each entry
must be active, currently assigned, absent from another heat in the same round,
and, for a final roster, a finalized round-one winner. Replacement is
revision-checked and audited.

Starting a round locks every roster in that round, so in normal operation this
correction path has no window left; it survives only as a guarded recovery route
for a heat that is somehow still planned and unlocked during its active round.

## Heat Readiness and Running

For each round-one and final heat, station staff perform:

1. Review heat detail and the authoritative roster.
2. `Mark ready`: changes `LOADING` to `READY`.
3. `Call heat`: changes `READY` to `CALLING`.
4. `Start heat`: changes `CALLING` to `RUNNING`.
5. A result taker `Finish heat`: changes `RUNNING` to `AWAITING_RESULT`.
6. A result taker enters and publishes the required result.

There is no operator lock step. Starting round one moves every planned round-one
heat to `LOADING`, stamps `roster_locked_at`, and permanently locks roster
editing, all in the same guarded batch as the event transition; starting the
final does the same for the final heat. The console and the start-line station
therefore ship no `Lock roster` control. The `announcer-roster` endpoint remains
available for the announcer surface, but the console button that refetched it
into the same element it already showed was a visible no-op and was removed.

### Console Roster Deep Links

Each console roster entry shows its slot, participant name, duck number, and the
race-entry identifier, plus up to two in-page navigation buttons. **Participant
details** scrolls to the Participants section, loads that registration through
the existing participant-selection path, and moves focus into the loaded detail
panel. **Duck # in inventory** scrolls to the Inventory section and opens that
duck through the existing duck-detail path, including its request versioning, so
an overtaken link click never leaves a stale panel open.

An entry with no assigned duck offers no duck link. Each link is offered only to
an actor whose roles can open the target section — `REGISTRATION` or
`RACE_DIRECTOR` for the participant link, `DUCK_MANAGER` or `RACE_DIRECTOR` for
the duck link — and the target APIs enforce the same requirement regardless of
the console. The announcer roster action still renders its own plain list.

### Focused Start-Line Station

`/staff/start-line` prioritizes any heat awaiting publication, then the current
running heat, then the next unfinished heat in the event's active round. This
prevents a newer prepared or running heat from hiding a pending official result.
It shows event, round, heat number, status, roster names, and visible duck
numbers without contact data. Depending on authoritative status, it exposes
exactly one of `Mark heat ready`, `Call this heat`, or `Start this heat`. A
still-planned heat displays that its roster locks by itself when the race
director starts the round, and an awaiting-result heat instead displays that no
next heat can start.
Starting requires a plain-language confirmation that reads back round, heat
number, and racer count. The station has no finish, result, correction, reopen,
or roster-edit control. Large high-contrast controls are at least 48 pixels
tall.

### Focused Announcer Station

`/staff/announcer` is a reading script for someone holding a microphone. It is
strictly read-only: it issues only GET requests and has no lifecycle transition,
result entry, or roster control anywhere on the page.

It shows the heat that is up now, chosen by the same priority as the start-line
station, with a plain sentence saying what to do (read the racers, call the
race, or hold for the official result). Its roster comes from
`GET /api/v1/staff/events/:eventId/heats/:heatId/announcer-roster`, which
projects exactly slot number, full participant name, and visible duck number.
Announcers say the whole name, so this projection is deliberately the full
registered name rather than the public name policy used on the race board; it
carries no contact data, lookup code, or inventory detail.

Every heat that already has a published result appears under **Recorded
winners** with its round, heat number, winner's full name, and duck number, so
the announcer can call the winner out as soon as the finish-line staffer records
it. The final additionally renders the full official podium. A settled heat's
detail is read once per heat revision, so a live signal never refetches the
whole race, and a race-director correction is picked up immediately.

The page subscribes to the shared live hub on the `event`, `participants`,
`ducks`, and `heats` domains and refetches the authoritative APIs on a signal,
so the announcer never has to refresh.

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
event has been moved to `COMPLETED`. Therefore an operator who finds a podium
error must first complete the event, then correct or reopen it.

A direct final correction supersedes the old podium and publishes a new result
revision while the event remains `COMPLETED`. Reopening supersedes and removes
the podium, changes the heat to `AWAITING_RESULT`, and moves the event back to
`FINAL`; staff must republish the podium and complete the event again.

Final correction and reopen are blocked after any event duck reservation is
released.

Historical result revisions remain until the event is deleted.

## Public Race Results

**Implemented:** `GET /api/v1/race-board` publishes the one current event only
from `REGISTRATION_OPEN` through `COMPLETED`. The prominent board appears on the
noindex `/race` page, private status pages, and public duck-tag status pages.
The home page instead carries a compact "happening now" summary, the stage chip
plus one current-heat line, that links to `/race`. While there is no public
event, `/race` shows only "The next race is being prepared. Live race status
will appear here once the race begins." — its own wording, because a race-status
page must not carry the `/register` call to action. The board includes:

- Safe event lifecycle status and date. The board turns that status into a
  prominent plain-language stage chip and summary line beside the event name:
  `DRAFT` race being prepared, `REGISTRATION_OPEN` participant registration
  open, `REGISTRATION_CLOSED` registration closed while heats are finalized,
  `ROUND_ONE` round one under way, `FINAL` final under way, and `COMPLETED`
  results official. An unrecognized status falls back to neutral wording
  instead of raw enum text.
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

Every rendered application page loads one shared browser live-update hub. The
hub connects to same-origin `/api/v1/live` lazily when its first live
subscriber registers; a page with no live subscribers opens no socket and keeps
the polling scheduler idle. Admission requires the exact application
`Origin`. The single `RaceUpdates` Durable Object accepts at most 1,000
simultaneous sockets, rejects upgrades over that cap, and closes any client-sent
frame with WebSocket policy code `1008`.

After a successful mutating API handler has committed, the Worker classifies its
fixed route into one or more finite domains: `event`, `participants`, `ducks`,
`heats`, `staff`, or `support`. Delete event uses `all`.
Publication runs best-effort through `ExecutionContext.waitUntil`.
Read-only GETs, round-one plan preview, and provisioning tag classification do
not publish. Replayed successful mutation responses may publish a harmless
duplicate invalidation.

The object accepts and broadcasts only a validated bounded
`{type:"refresh", domains:[...], version:<random UUID>}` frame. It stores no race
state or client network identifier. Frames cannot contain IDs, names, contact
details, lookup codes, tokens, tag URLs, event or duck labels, command material,
or mutation payloads. Domain names only decide which open surfaces need an
authoritative refetch; they are never data or proof that a command succeeded.

A successful signal causes matching public, private, `My Ducks`, station,
inventory, scan, and staff-console subscribers to refetch D1-backed APIs.
Reconnect uses bounded jitter and triggers an integrity refetch to close the
missed-signal gap. While disconnected or when WebSocket is unavailable,
subscribers poll approximately every five seconds; while connected they perform
an approximately 30-second integrity refresh. Refresh requests are coalesced and
hidden tabs pause polling and rendering. Ordinary refreshes wait while a form is
dirty, an NFC/scan/result selection is unresolved, or a command is in flight;
the queued refresh runs when that protected work is clean. Dirty-form deferral
is scoped to each subscriber's own page region, so an unfinished edit in one
region never blocks another region's refreshes, and it is bounded: an edit
abandoned for more than five minutes stops deferring and the next authoritative
refresh proceeds. Station controls and
rosters are replaced only when heat ID, revision, or state changed, with focus
restored when possible.

An `all` signal is exceptional: every page removes its rendered main content and
server-reloads immediately so deletion cannot leave participant or staff data on
screen. Staff deactivation and reduced roles use the authorization revalidation
path above and likewise override dirty-form deferral. D1/API data is always
authoritative, and a failed live publication never changes a committed mutation
response.

Public race status is available through `COMPLETED` and stays available there.
It disappears only when an administrator deletes the event.

## Staff Access Lifecycle

The account model distinguishes regular staff from system administrators with
`is_system_admin`. Regular staff receive one or more normalized, composable
assignments from this fixed vocabulary:

- `REGISTRATION`
- `DUCK_MANAGER`
- `ANNOUNCER`
- `HEAT_RUNNER`
- `RESULT_TAKER`
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
and lifecycle command/audit records are retained across event deletions.

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
and audit timeline diagnostics.

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
currently delivered, regardless of the stored email-notification setting.
Notification support controls operate only on records inserted by some external
or future process and must not be presented as proof that delivery exists.

## Delete Event (Any State)

Deleting the event is the only cleanup path. There is no purge-readiness stage,
no purge gate, no purge claim, and no physical reconciliation prerequisite.

`POST /api/v1/staff/events/{id}/force-delete` is administrator-only and
permanently deletes an event and its complete dataset from any event status,
including mid-race and from `COMPLETED`. It does require the event to be the
only race dataset: if another event exists the request returns `409` and deletes
nothing, and the same only-event guard is re-checked inside the atomic batch so
a concurrently created second event makes the batch delete nothing.

The request requires an RFC 4122 v4 `commandId`, the event's current
`revision`, and `confirmName` typed exactly as the event name. The staff
console shows the control to system administrators only, confirms through the
application danger dialog, and then requires the typed event name; the API
enforces the administrator requirement regardless of the console. A stale
revision returns `409` without deleting anything; a wrong typed name returns
`422`.

One atomic D1 batch deletes the complete dataset: registrations, race entries,
duck assignments, event duck reservations, duck inventory events, ducks and
tags, heats, heat entries, current and superseded heat results, email
notifications and attempts, browser collection links and collections, race
commands, audit events, and the event row itself. Staff profiles, staff
access/lifecycle history, and organization event defaults remain. The next event
starts with no race duck/tag rows, so each physically selected duck must be
intaken again.

The deletion removes the primary D1 rows the application manages. It does not
operate Cloudflare account-level recovery systems, D1 time-travel retention,
external exports, third-party logs, or backups. Operators must manage those
systems consistently with the stated privacy policy.

Because the deletion removes its own command and audit history, a successful
delete records nothing afterward. A surviving command record with the same
identifier always belongs to a different operation and returns `409`; a
well-formed retry against the now-missing event returns a deterministic
already-deleted success (`deleted: true, alreadyDeleted: true`) instead of a
stored replay. This is irreversible, and connected consoles receive an `all`
refresh signal so no page keeps deleted data on screen.

## Failure, Retry, Idempotency, and Concurrency

### Safe Command Rules

Most current mutations accept a client-generated UUID command ID. A matching
replay returns the stored result and `replayed: true`; reuse for another
operation or materially different request returns a conflict. Event and heat
commands use request fingerprints where needed. Delete event is idempotent once
its event no longer exists.

Public registration preserves its pending command/private-token pair across a
network failure and is safe to retry. The staff console generally creates a new
command ID for each button submission and does not persist that ID in an
offline outbox. If a staff response is lost after a possible save, refresh the
relevant event, participant, duck, heat, or support view before pressing
the action again. A state conflict is safer than assuming the first action
failed.

### Optimistic Concurrency

Event configuration/deletion, participant edits/status, duck edits/tag and
assignment operations, heat transitions/rosters, and result publication or
correction require a current revision or preview fingerprint. A stale request
returns `409` and no accepted partial state. The operator should refresh, review
the new state, and make a new decision rather than repeatedly submitting stale
data.

Pairing relies on current-state predicates and uniqueness constraints rather
than a user-supplied entity revision. Concurrent claims of the same duck,
participant, heat slot, result place, or active tag cannot both commit.

### Atomicity

D1 batches make the command, domain changes, and audit records all-or-nothing
for implemented workflows. This includes registration, pairing, inventory/tag
changes, result publication/correction, and event deletion. Errors report
conflict/retry rather than accepting known partial
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

The UI shows no ambient freshness or connection-status text. There is no
`Updated just now`, `Updates are arriving live`, or delayed/reconnect line, and
no page claims a connection state. Refresh behavior is unchanged: WebSocket
signals still prompt refetches and polling still recovers.

Because no message ever implies success, operators must judge a mutation only by
its authoritative saved response and the refreshed state that follows. Station
pages report actionable operational errors through `data-station-message` and
`data-intake-message`. The public live board and My Ducks each keep one
error-only line that appears solely when their authoritative request fails and
clears on the next success.

## Security and Privacy Boundaries

- NFC/QR tags contain only the random tag URL, never participant data.
- A tag token is a public duck identifier, not staff authentication.
- Private status tokens are high-entropy bearer credentials stored only as
  hashes; lookup codes are staff search values, not private-page credentials.
- Public status never returns email, phone, lookup code, private link, staff
  notes, inventory location, or audit details.
- Exact public name search is rate-limited and event-scoped, but it is still
  public status, not identity verification.
- Adding a search result to My Ducks is rate-limited, same-origin, and revalidated
  against the public search predicate. It grants only what the search already
  showed: a followed collection entry never carries a lookup code, a private
  link, or a name beyond the event's public name policy.
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
- Deleting the event removes application-managed race, participant, duck, tag, browser,
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
   Delete event requires a typed event name and an explicit danger dialog.
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
  loading. The post-close balanced planner that once approximated this has been
  removed entirely.
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
| Balanced physical random draw, scan-to-load, and the post-close balanced planner | Removed. Heats are filled as participants are paired; that is the only model. |
| Immediate heats are fixed at ten | Capacity is configurable from three upward; current default is ten. |
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
| Multiple annual events/history are retained | Only one event dataset may exist, and the previous race is deleted before the next event. |

Infrastructure and domain setup documents remain authoritative for their own
deployment and permanent-origin subjects, but not for application workflows.
