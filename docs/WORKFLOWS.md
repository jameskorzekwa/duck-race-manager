# QuickDucks Current Workflows

## Canonical Status

This document is the canonical operator and user workflow specification for the
currently implemented QuickDucks application. It describes behavior present in
the Worker, D1 migrations through `0016_locked_final_winner_correction.sql`, browser
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
| Delete a never-paired registration | `REGISTRATION` or `RACE_DIRECTOR` | Yes |
| Set or clear a participant's duck name | `REGISTRATION` or `RACE_DIRECTOR` | Yes |
| Participant disqualification/reactivation | `RACE_DIRECTOR` | Yes |
| Participant contact data and registration notes | `REGISTRATION` or `RACE_DIRECTOR` | Yes |
| Duck inventory intake, deletion, assignment, unassignment, and reservation | `DUCK_MANAGER` or `RACE_DIRECTOR` | Yes |
| Open a staff duck inspection | `REGISTRATION`, `DUCK_MANAGER`, `RESULT_TAKER`, or `RACE_DIRECTOR`; projection stays role-narrow | Yes |
| Open `/staff/inventory` | `DUCK_MANAGER` or `RACE_DIRECTOR` | Yes |
| Open `/staff/registration` | `REGISTRATION` or `RACE_DIRECTOR` | Yes |
| Take over another operator's abandoned pending sticker provisioning | `RACE_DIRECTOR`, after 10 minutes | Yes, after 10 minutes |
| Event list/detail context | Any operational role | Yes |
| Event readiness, heat list/detail/announcer-roster, result, and finalist reads | `ANNOUNCER`, `HEAT_RUNNER`, `RESULT_TAKER`, or `RACE_DIRECTOR` | Yes |
| Lock, ready, call, and start heat | `HEAT_RUNNER` or `RACE_DIRECTOR` | Yes |
| Finish heat and finalize required result/podium | `RESULT_TAKER` or `RACE_DIRECTOR` | Yes |
| Open `/staff/start-line` | `HEAT_RUNNER` or `RACE_DIRECTOR` | Yes |
| Open `/staff/announcer` (read-only) | `ANNOUNCER` or `RACE_DIRECTOR` | Yes |
| Open `/staff/finish-line` and resolve a roster duck by tag URL/number | `RESULT_TAKER` or `RACE_DIRECTOR` | Yes |
| Event lifecycle, planning, roster changes, result correction/reopen | `RACE_DIRECTOR` | Yes |
| Create/configure draft; reopen registration | None | Yes |
| Staff management; support diagnostics/notifications/audit | None | Yes |
| Open `/staff/access` and the `/staff` Admin console | None | Yes |
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

Pairing is also the one-way door between the two ways a participant can leave:

- **Never paired:** delete the registration. It removes the row for real, and it
  is the only removal path a participant or staff member has.
- **Paired at any point, current or already unassigned:** delete is refused with
  `409`. The participant is withdrawn or disqualified instead. Pairing put a
  physical duck into a sealed heat bag, and nobody unpacks a bag on race day to
  retrieve one duck, so the duck stays where it is and may still float past the
  finish line.

Nothing about withdrawal or disqualification touches the physical race. Heats,
heat entries, slot numbers, lane order, duck assignments, and recorded results
are never renumbered, rebalanced, reordered, or removed — resorting the bags
would mean rescanning every duck. The participant simply disappears from every
public surface and can never be published as a winner. See Public Visibility of
Withdrawn and Disqualified Participants.

Because the write disturbs nothing physical, it is available at **every** point
in the event lifecycle: a participant may be withdrawn or disqualified while
their heat is `PLANNED`, `LOADING`, locked, `READY`, `CALLING`, `RUNNING`,
`AWAITING_RESULT`, or `FINALIZED`, and the heat is left byte for byte as it was.
A non-`ACTIVE` roster entry is therefore a normal, expected race-day state: that
duck rides in the bag, goes down the water, and simply cannot win.

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
| Preparing | no event, or `DRAFT` | Home, Staff | none; the hero says the next race is being prepared, and `/race` redirects home |
| Registration | `REGISTRATION_OPEN` | Home, Register, My Ducks, Staff | Register |
| Locked in | `REGISTRATION_CLOSED` | Home, Race Status, My Ducks, Staff | View race status |
| Racing | `ROUND_ONE`, `FINAL` | Home, Race Status, My Ducks, Staff | View live race |
| Results | `COMPLETED` | Home, Race Status, My Ducks, Staff | View results |

Register and Race Status strictly swap: the navigation offers exactly one of
them after `DRAFT` and neither while a race is being prepared. `/race` itself
stays reachable for all five post-`DRAFT` statuses, including while registration
is open, even though the navigation does not advertise it then. While the phase
is Preparing there is no stage, heat, or result to report, so both the
navigation and a direct `GET /race` keep the page unavailable and the direct
request returns `303` to `/`. Staff stays in the top navigation in every phase.

The home call to action is not in the hero. When a phase has one it is the
primary action of the "happening now" section, whose title the live client
replaces with the event's own name, so the action sits with the race it belongs
to and the secondary "Open the full race board" link follows it. The hero
carries copy and artwork only, plus the Preparing empty-state sentence.

My Ducks appears whenever the phase is Registration or later. Before
registration opens, both the navigation and a direct `GET /my-ducks` keep the
page unavailable; the direct request returns `303` to `/`. The saved-registration
presence probe controls the page's empty-versus-saved layout after it opens, not
whether the route or navigation is available.

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
page, and staff error pages carry no marker and no other live surface, so they
open no socket and schedule no polls, and they keep the navigation exactly as the
server painted it. Staff HTML routes still resolve the same phase for their
server-rendered primary navigation, so their Home, Register or Race Status, My
Ducks, and Staff links match the public site on first paint without taking a
live-navigation connection.

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

Non-My-Ducks pages run a lightweight collection presence probe. It applies the
same cookie validation, invalid-cookie clearing, and sliding expiry refresh as
the full collection endpoint, but queries only whether one collection link
exists. It never selects or returns names, lookup codes, race entries, status
details, contact fields, or private paths. The result controls the saved-list
layout when My Ducks is phase-accessible; it cannot reveal the link during
Preparing, when the route redirects home.

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
- `duckName` and a `nameable` flag. The card's own editable name is sent only for
  an entry this browser registered; a followed card reads the duck's public name
  from its race status like any other visitor. See **Naming Your Own Duck**.

Cards are grouped into three horizontally swipeable sections with keyboard and
previous/next controls: **Awaiting Participants** and paired **My Ducks** hold
the participants registered on this device, and **Ducks I'm Following** holds
every `FOLLOWED` entry whether or not that participant has a duck yet. The page
states the difference in place: entries registered here keep their full details
and staff lookup code, and followed entries show the public projection only. A
live or polling refresh immediately regroups a registered card when staff pair
or unpair its participant. A group with no participants normally hides its
entire section, including its heading and controls, rather than rendering an
empty state. During open registration, the empty Awaiting Participants section
keeps its heading and **Register another participant** action while its track and
carousel controls stay hidden. When all groups are empty the page keeps one
guidance message so it is never blank. Sections stay hidden until the first
successful full collection response, so a failed initial request shows only the
error-only line and keeps checking rather than claiming an empty collection.

While registration is open, **Register another participant** sits in the
Awaiting Participants heading row instead of below the complete page. The row
wraps the action below the heading on narrow screens.

After the registration redirect, the page scrolls the matching card into view.
The card itself is rendered exactly as it is on a plain refresh: it carries no
highlight, no "just registered" tag, and no moved focus, and it stays that way
once staff pair it with a duck. Only after that UUID appears in a successful full
collection response does the page validate and consume the matching handoff. A
valid handoff must contain exactly the matching registration UUID and a
same-origin relative `/r/<valid-private-token>` path. Safe consumption removes it
from `sessionStorage` and adds an accessible **Open private status** link to the
one-time "Registration saved." notice, which names the participant so the link is
unambiguous, so the participant can open and bookmark it. Invalid,
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
device, that card's **Duck** fact carries a **Rename** button, or **Name this
duck** while it has no name. Pressing it reveals the name field in place, with
**Save name**, **Suggest a name**, and **Cancel**. Only Save writes anything:
Cancel discards the draft and the field reopens showing the name the server
currently holds, and an editor left open survives a live or polling refresh
rather than folding away mid-edit. Saving posts
`{ commandId, registrationId, duckName }` to
`POST /api/v1/registrations/mine/duck-name`, and the name is stored on the race
entry.

**Suggest a name** fills the field from the two word lists in
`src/duck-name-suggestions.ts`, which `client-scripts.ts` serializes into the
browser bundle so a suggestion costs no request. Nothing is saved until Save is
pressed. `src/duck-name-suggestions.test.mjs` asserts that every possible pairing
of those lists passes `cleanDuckName`, `hasSupportedDuckNameCharacters`,
`isAllowedDuckName`, and the read-time `publicDuckName` projection unchanged, so
an accepted suggestion can never be refused by the write endpoint or suppressed
on the board.

The value is trimmed, internally whitespace-collapsed, and must be 1 to 40
characters; blank-after-trim, overlong, and control or format characters are
rejected with `422` before any database access, and the migration's `CHECK`
repeats the same bound. Characters outside the supported alphabet described
under *Filtering a Duck Name* are refused with their own `422` message. Transport rules match the other public collection
mutations exactly, including the exact `Origin` and the shared rate limiter.
Retrying the same command with the same name replays; reusing that identifier
with a different name returns `409`. The command row stores only a hash of the
accepted name, and the redacted `DUCK_NAME_SET` audit event records the changed
field name, never the text.

Only a `REGISTRATION` link may name, and only while a duck is currently assigned
to that entry. A followed link, an unrelated registration, and a missing cookie
are one indistinguishable `404`; an owned entry with no duck yet returns `409`.
The My Ducks projection reports the same permission in advance as `nameable`.

**The name is public.** It appears beside the canonical duck number — never
instead of it — on the live race board rosters and podium, `/duck/<number>`,
`/t/<tag-token>`, and public race-status search results, rendered as
`Duck #12 · Sir Quacks-a-Lot`. Page headings and board links keep the bare
number, so a duck on a screen always matches the duck in the water. The owner's
own My Ducks card is unchanged: the name replaces "Duck #N" as the link text with
the number quietly beside it.

The **announcer station deliberately does not receive it**. Its roster
projection stays slot, participant name, and duck number. A name that slips past
the filter can be cleared from a screen in seconds but cannot be unsaid over a
public-address system, and the announcer needs the number to line racers up
anyway.

### Filtering a Duck Name

**Implemented:** `src/duck-name-filter.ts` is a pure, dependency-free filter with
no external moderation service, so naming adds no latency, no cost, no
third-party dependency, and never sends participant text off-platform.

**The alphabet comes first.** A name may contain Unicode letters, the combining
marks that belong to them, decimal digits, spaces, and a short punctuation list
(`'`, `’`, `‘`, `-`, `‐`, `–`, `—`, `.`, `,`, `!`, `?`, `¡`, `¿`, `#`, `&`).
Symbols, emoji, private-use characters, box drawing, and every other category are
refused outright, because a duck name has no use for them and each block is an
open-ended supply of new letter-lookalikes that no wordlist could keep up with.
This is a character-category rule and never an ASCII one: `Señor Pato`, `Björn`,
`Πάπια`, and `アヒル` all pass. It is reported separately from the wordlists, so a
participant who pastes an emoji is told to use letters, numbers, spaces, and
simple punctuation rather than being told their name reads as profanity.

It then normalizes before matching: control and format characters are dropped,
NFKD plus combining-mark stripping folds accents and compatibility forms, text is
casefolded, and a table folds leetspeak and confusables — Cyrillic, Greek, Latin
small capitals, and hooked or turned Latin letters that NFKD leaves alone such as
`ƒ` (U+0192) and `ı`.

The name is then read several ways, and a hit in **any** reading rejects. `1`,
`!`, `|`, and `¡` are ambiguous, so it is read once as `i` and once as `l`. On
top of that sit four substitution families — `v`→`u`, `z`→`s`, `k`→`c`, `q`→`g`
— applied to the whole text or not at all, once for every subset, which is what
catches `fvck`, `azz hole`, `kunt`, and `niqqer`. These are alternative readings
and never a collapse of two letters into one: the plain reading is always
evaluated too, so `Spike`, `Duck`, and `Kayak` are untouched. `k`→`c` is read
word-initially only, because mid-word it would turn every `spik` into `spic`.

Matching runs against a separator-preserving form, that form with runs of single
letters merged, and a separator-stripped form, so `f u c k`, `f.u.c.k`, `fu-ck`,
and `azz hole` are all caught. Repeated letters are handled in the pattern rather
than by collapsing the text, so `fuuuck` matches while `Cookie` and `Class` are
untouched.

Matching is tiered to control false positives, which are the real failure mode.
Severe slurs match anywhere, including inside a word, and additionally match a
vowel-elided spelling such as `niggr`. That elision is tier-1 only and guarded —
the dropped vowel must follow a doubled consonant, five letters and a vowel must
survive — because unguarded it turns `gook` into `gk` and rejects `ringlet`,
`banner`, and `Tenggerese`. General profanity carries a per-term mode: a
distinctive sequence matches anywhere, and a sequence that also occurs inside
ordinary words matches only as a whole word. A short whole-word term may also
carry an explicit compound list, so `badass`, `asshat`, and `dickwad` are caught
while `class`, `grass`, `bass`, `assassin`, and `Massachusetts` are not.

An explicit allowlist of innocent words — `assassin`, `class`, `grass`, `bass`,
`cocktail`, `Hancock`, `Cockburn`, `Scunthorpe`, `shiitake`, `shitake`,
`analysis`, `therapist`, `spice`, `Penistone`, and the rest — is removed from the
text before any matching. A token is scrubbed when either its plain or its
substituted spelling is allowlisted, so `spick` survives the `k`→`c` reading. The
wordlists sit in one clearly marked block at the top of the module with
instructions for extending them.

Every change to those lists is audited against `/usr/share/dict/words`, because
the failure that reaches a real person is a rejected ordinary name rather than a
slur that slipped through. That audit currently rejects 538 of 235,976 words
(0.23%), nearly all archaic entries.

A rejected name returns `422` with a message that never quotes the offending
word back, nothing is written, and the attempted value is never logged. The
filter reports only a decision and never which term matched, nor even whether it
was the alphabet rule or a wordlist that refused.

**Read-time safety net.** Every projection of a stored name runs it through the
same filter again. This matters for rows stored before the name became public and
for names that only become disallowed later when the wordlists are extended. A
suppressed name is projected as `null` and the surface falls back to "Duck #N".
Names are at most 40 characters, so the recheck is cheap.

### Setting and Clearing a Duck Name (Staff)

**Implemented:** staff can name a duck at the desk with
`POST /api/v1/staff/registrations/<registration-id>/set-duck-name`, for a
participant who cannot do it themselves — a walk-up with no phone, or a device
that lost its saved list. It requires the `REGISTRATION` or `RACE_DIRECTOR` role,
which administrators pass implicitly, and the same exact application `Origin` as
every other staff mutation.

The body is an RFC 4122 v4 `commandId` and the `duckName`. The endpoint applies
exactly the gates the public endpoint applies, in the same order: the trim and
1-to-40-character bound, the supported alphabet, and the wordlists, each with its
own `422`. A rejected value is never echoed to the caller, logged, or audited.
The participant must currently hold a duck; naming one who does not returns `409`
with guidance to pair first, and the write batch is guarded on that assignment
still being open. The write records a `SET_DUCK_NAME` command row and a redacted
`DUCK_NAME_SET` audit event carrying the staff profile, the changed field name,
and `named_via: "STAFF_DESK"` — never the text. A retry with the same identifier
replays; reusing it for another registration returns `409`.

Because both paths run the same gates, a name staff can set is a name the
participant could have set. The name is public on exactly the same terms, and the
announcer station still never receives it.

**Implemented:** no filter is perfect, so staff can also remove a name outright
with `POST /api/v1/staff/registrations/<registration-id>/clear-duck-name`. It
requires the `REGISTRATION` or `RACE_DIRECTOR` role, which administrators pass
implicitly, and a cookie-authenticated call requires the exact application
`Origin` like every other staff mutation.

The clear body is one RFC 4122 v4 `commandId` and nothing else. There is no
expected revision, and none of the naming preconditions apply: clearing is always
safe and idempotent, and moderation must not fail because the owner renamed the
duck a second earlier. A retry with the same identifier replays; reusing it for
another registration returns `409`.

The write is one guarded batch: a `CLEAR_DUCK_NAME` command row, an `UPDATE`
conditional on that row, and a redacted `DUCK_NAME_CLEARED` audit event recording
the staff profile, the changed field, and whether a name was present — never the
offending text. Clearing sets the column back to `NULL`, so the duck shows as
"Duck #N" everywhere, and the participant may name it again afterwards, subject
to the same filter.

Three staff surfaces expose these actions. The participant detail panel in the
console shows a **Duck name** fact, a **Duck name** field for a paired
participant, and a **Clear duck name** action. The duck detail panel on
`/staff/inventory` carries the same **Duck name** field and **Clear name** button
for a paired duck. The staff duck scan page `/staff/ducks/<tag-token>` offers the
clear action, which is the fast path when someone is complaining about a duck in
the water. All three show the stored text so staff can judge it, marked when the
read-time filter is already hiding it, and all three send those fields only to
the roles the endpoint itself accepts.

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
page and staff cannot regenerate its private token. At the duck table,
participants can simply show this screen: staff scan its QR code or type the
code shown beside it. A participant who did not keep the private link can show
their card on `/my-ducks` instead, which carries the same code and QR on the
device that registered them.

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
show pairing pending, assigned duck and its filtered public duck name, heat,
current heat, and race outcome. It never returns contact details, lookup codes,
private links, staff notes, inventory state, location, or audit data.

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
endpoint would actually accept. A duck whose participant is withdrawn or
disqualified, or one outside the current public event, resolves to no public
participant at all, so there is nothing on its page to follow. The membership
check is a read-only probe of the caller's own collection cookie, so a tag GET
stays read-only and issues no cookie. Nothing else about these responses changed:
they still carry no contact details, lookup code, private link, or staff data.
They do carry the duck's filtered public `duckName`, always alongside its visible
number.

### Public Duck Detail View

**Implemented:** `/duck/<visible-number>` is a public page for one duck,
addressed by the number printed on the duck and shown on the live board. It
needs no tag, no token, and no cookie.

The number is resolved against the same event the public race board renders, and
only while that event is between `REGISTRATION_OPEN` and `COMPLETED`. The page
reuses the shared public status projection, so it can show the event, the
policy-filtered participant name, the visible duck number with the
participant-chosen duck name beside it when there is one the filter allows, the
round-one heat, the final heat, the heat currently running, the race outcome, and
an official finishing place once a heat is finalized. It never shows contact
details, lookup codes, private links, raw tag tokens, inventory location, staff
notes, or audit history.

`GET /api/v1/ducks/number/<visible-number>` returns the same projection as
`{ "raceStatus": ... }`. Only canonical positive integers resolve; a
non-canonical value is rejected before any database access.

Unknown numbers, ducks that exist in inventory but are not paired, ducks whose
participant is withdrawn or disqualified, and ducks outside the current public
event are indistinguishable: all four return `404` from the API and one identical
friendly page — "Duck #N isn't racing." — sent `noindex, nofollow` like the other
public duck and status pages. The page therefore adds no enumeration signal
beyond the duck numbers the board already publishes, and it is honest about a
duck that physically exists without naming anybody.

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
- That assignment's participant is `SUBMITTED` or `ACTIVE`.
- The event is between `REGISTRATION_OPEN` and `COMPLETED`.

Otherwise the request redirects to the home page. Unknown, invalid, retired,
unassigned, and deleted tags, and tags on a duck whose participant withdrew or
was disqualified, therefore do not expose inventory metadata or that participant.
A successful status page can show the event, policy-filtered
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
Both paths only select a roster entry; neither submits a result. Inventory tag
provisioning and participant QR scanning remain separate from the finish station.
Response headers continue to disable browser camera access at the finish station;
only the duck-pairing page enables the camera.

The blank-sticker station is the **Scan ducks** section of `/staff/inventory`. A
duck manager, race director, or administrator selects the working event and
optional station location and presses Start once. That user gesture starts one
`NDEFReader.scan()` in current Android Chrome over HTTPS; the top-level page must
remain visible. Each subsequent physical reading writes and confirms one sticker
without a per-duck form, printed number, pasted URL, presence checkbox, or
desktop fallback.

The page itself is not device gated. Authentication and the inventory-role check
decide who may open it, and every device that passes them gets the whole page,
including the staff navigation, the duck list and detail panel, and every
inventory command. The scanning station is the only device-dependent part, and it
turns itself off in the browser and says why.

Station controls therefore remain hidden and no station API is called until
browser runtime checks confirm Android Chrome, `NDEFReader`, a secure context, a
top-level tab, and a visible document. The same conditions are checked again on
Start. iPhone, iPad, desktop, Android WebView, alternate Android browsers,
spoofed clients without Web NFC, embedded pages, insecure contexts, and hidden
documents receive no provisioning API user experience, and are told that
everything else on the page still works. Provisioning APIs do not trust or
require a user agent: they continue to enforce live staff authentication,
inventory roles, and same-origin provenance for cookie-authenticated mutations,
including for automated API clients.

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

The staff home does not repeat large start-line or finish-line shortcut buttons;
the persistent staff navigation is the single route to those focused pages.
Hidden links are only a convenience; each page and every API it calls repeat
authentication, active-profile, role, event-state, heat-state, and revision
checks.

Every staff page also renders one persistent staff navigation, organised by the
job a staffer is doing and listing only the pages the signed-in actor may open:
**Admin** (`/staff`, system administrator), **Registration**
(`/staff/registration`, `REGISTRATION` or `RACE_DIRECTOR`), **Announcer**
(`/staff/announcer`, `ANNOUNCER` or `RACE_DIRECTOR`), **Start line**
(`/staff/start-line`, `HEAT_RUNNER` or `RACE_DIRECTOR`), and **Finish line**
(`/staff/finish-line`, `RESULT_TAKER` or `RACE_DIRECTOR`).

Inventory and Access are reached from the Admin console's own menu bar rather
than from this navigation. The one exception is a **non-administrator** holding
`DUCK_MANAGER` or `RACE_DIRECTOR`: they have no Admin menu bar, so they keep an
**Inventory** (`/staff/inventory`) link here as the last item. The current page
is marked `aria-current="page"`. The navigation wraps rather than scrolling, so
it never overflows a 320px viewport. Omitting a link is convenience only; each
page repeats its own check.

`/staff` is the return target of staff sign-in, so it never refuses a regular
staff member. A signed-in system administrator receives the Admin console. A
signed-in non-administrator receives `303` to the first page their own roles
open, in this order: `/staff/registration`, `/staff/start-line`,
`/staff/finish-line`, `/staff/announcer`, `/staff/inventory`. Each target is a
distinct path with its own role check and none of them redirects back to
`/staff` while authenticated, so the redirect cannot loop. A staff member with
no operational role at all receives the console page and its **No operational
roles assigned** notice instead of a redirect.

The signed-in identity bar is the last element of each operational staff page,
not a header. It contains only the escaped display name on the left and the
same-origin POST **Log out** control on the right; page navigation and page-name
labels do not appear in this footer.

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

### The Admin Console and Its Views

`/staff` is the administrator console. Its menu bar lists, in this order,
**Event Details**, **Heats**, **Participants**, **Inventory**, **Support**, and
**Access**. Event Details, Heats, Participants, and Support are separate views
inside `/staff`; Inventory and Access are links to `/staff/inventory` and
`/staff/access`, which render the same menu bar so an administrator can navigate
back.

The views are not one stacked page: exactly one is displayed at a time. The URL
hash names the displayed view — `#event`, `#heats`, `#participants`, `#support` —
so a view is linkable, survives a reload, and moves with browser back and
forward. The displayed item is marked `aria-current="page"`. The switcher only
ever chooses among views the actor's role gating and the current event existence
already permit, and falls back to the first permitted, currently-available view
when the requested one is unavailable. Data loading is independent of display:
hidden views stay populated, so refresh, live signals, and the readiness and
lifecycle controls behave exactly as before.

### Console Event Existence Gating

The console's **Event Details** view is always available. **Participants**,
**Heats**, and **Support**, and their menu-bar items, are event-scoped: they are
hidden in the served markup and are revealed only when an event loads, so no
section flashes and then vanishes. Role gating still applies on top of event
existence, so an event-scoped view the actor may not use stays hidden even once
an event exists.

While no event row exists the console hides all three event-scoped views and
their menu items and shows Event Details with a **No race yet** state and, for a
system administrator, the **Create event** card revealed and already open.

### Console Event Layout

The console's Event Details view is ordered setup-first. A system administrator
sees the **Create event** card directly under the heading; other roles see no
create card. QuickDucks holds one event dataset at a time, so that card is
rendered hidden and is revealed only while no event exists: it disappears as
soon as an event is created and reappears the moment the event is deleted,
without a manual reload. It is removed with `hidden` rather than dimmed, and the
client refuses a create submission while an event exists, so it is never hidden
but still submittable. The **Working event** picker and its refresh button
follow. Everything about the chosen event then appears in one labelled
"Selected event details" region below the picker, in this order: the summary
facts, **Configure draft**, **Readiness and lifecycle**, and **Delete event**.
Administrator-only cards remain administrator-only, and the configure card
appears only while the event is a draft.

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

An administrator may run **Delete event** from a draft or any later state by
typing the exact event name in the danger dialog. This universal deletion is the
only cleanup path and removes the complete event dataset; there is no separate
empty-draft deletion action.

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
they are the normal state at this point. Reopening also splits back out the
slots closing had folded into an earlier heat, returning every heat to at most
its capacity. See Minimum Heat Size and Tail Rebalancing for what that restores
exactly and what it does not.

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
- Every round-one heat still holds at least one `ACTIVE` racer. Withdrawn and
  disqualified racers on a roster never block: their entries, slots, and ducks
  stay exactly where they are and readiness reports them as an informational
  note. What is refused is a heat where *nobody* can win, because round one needs
  one first place and that place is `ACTIVE`-only, so such a heat would run and
  then be impossible to publish. The blocker names reactivating a racer as the
  remedy — not replacing the roster, which would renumber slots the sealed heat
  bags cannot follow.
- Every round-one heat is still `PLANNED`, `LOADING`, or `READY`.

Starting round one also locks every planned round-one roster, moving it to
`LOADING` and stamping `roster_locked_at`, in the same guarded batch as the
event transition. A roster holding withdrawn or disqualified racers locks
normally. The roster lock carries the same at-least-one-`ACTIVE` predicate as the
readiness blocker and the guarded `START_ROUND_ONE` command, so a heat nobody
could win fails the whole transition rather than being silently left unlocked
while the round starts around it.

Readiness also reports, without blocking, how many racers on round-one rosters
are withdrawn or disqualified. Those appear in the `notes` array beside
`blockers`; `allowed` ignores them.

**Operator step:** resolve every unpaired submission by pairing, withdrawal, or
administrative disqualification before starting. If a heat would race with fewer
than three ducks, reopen registration rather than trying to start. A racer who
withdrew after being paired needs no action at all: leave the roster alone, their
duck races and cannot win. Only if every racer in one heat has left must a race
director reactivate one of them.

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
heat has one first-place result, one final heat with entries exists, the final
roster still holds at least one `ACTIVE` racer, and that final has not started.
Starting the final locks the final roster in the same guarded batch, exactly as
starting round one does for round one, including the same at-least-one-`ACTIVE`
rule. A withdrawn or disqualified finalist keeps their slot and their duck in the
bag, is reported as a readiness note, and blocks nothing.

A round-one winner who is later withdrawn or disqualified is never promoted in
the first place: promotion happens in the same guarded batch that publishes the
winner, and that batch requires an `ACTIVE` racer. A finalist who leaves after
being promoted stays on the final roster and simply cannot take a place.

A race director or system administrator can complete the event when the final is finalized,
all final heats are finalized or cancelled, and each finalized final contains
exactly places 1 through `min(3, eligible final roster size)`. The podium is only
as deep as the racers who can hold a place, counted the same way in
`validateResultSet`, in the readiness stats, and in the guarded `COMPLETE_EVENT`
command; counting a withdrawn finalist would demand a place nobody is allowed to
fill and leave the event permanently incompletable.

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

The participant detail pane offers **Withdraw** and **Disqualify** only for a
participant who currently holds a duck assignment, because that duck is already
sealed into a heat bag and physically stays in the race; all staff can do is
make the participant ineligible to be counted as a winner, and the pane says so
in one sentence beside the actions. **Reactivate** is unaffected by pairing. The
pane reads the projection's current-assignment field, not the status, because a
reactivated participant can be `SUBMITTED` while still holding their duck. This
is console convenience only: the API accepts a withdrawal or disqualification
for an unpaired registration as well.

**Withdrawal or disqualification is allowed at any point in the event
lifecycle.** The heat's state is not a precondition: `PLANNED`, `LOADING`,
locked, `READY`, `CALLING`, `RUNNING`, `AWAITING_RESULT`, and `FINALIZED` all
accept it, and none of them is changed by it. There is no longer a heat guard in
the preflight or in the atomic write, because there is nothing to remove — the
duck is sealed in a numbered bag, the entry never moves, and only eligibility
changes. Every other guard is unchanged: the event-status gate, the revision
check, the allowed-transition check, command idempotency, and the audit write.

Withdrawal and disqualification are the exit for a participant who has been
paired, and they are deliberately bookkeeping only. Each writes exactly three
rows — the guarded command, the registration status, and the audit event — and
nothing else. They do not close a duck assignment, release an event reservation,
remove a heat entry, or renumber, rebalance, or reorder any heat, slot, or lane.
The duck is already sealed in a heat bag, and resorting the bags would mean
physically rescanning every duck, so the bags and the rosters stay exactly as
they are.

The participant instead disappears from every public surface; see Public
Visibility of Withdrawn and Disqualified Participants. There is no current
operation to replace a roster with zero entries or cancel an empty heat, so
operators must resolve these cases before locking and avoid creating a stranded
empty heat.

The heat entry survives and the round starts around it. The only roster fact
that still refuses a lock or a start is a heat holding **no** `ACTIVE` racer at
all, because that heat could never produce a result. That one refusal is reported
as a readiness blocker, enforced inside the guarded start command and the heat
lock/start transitions, and enforced again by the automatic roster lock, all with
the same predicate so the preflight, the transition, and the lock can never
disagree. Reactivation, which is available at any point, is its remedy.

Staff rosters — heat detail, the announcer roster, the start-line roster, the
staff finalist list, and published results — keep showing withdrawn and
disqualified racers with `eligible: false` and their `registrationStatus`. Staff
must reconcile what is physically in the bag, and the announcer must know not to
call that name. Only public surfaces omit them.

### Delete Registration

Registration staff, race directors, and administrators can permanently delete a
registration from the participant detail pane with
`DELETE /api/v1/staff/registrations/<registrationId>`. Use it for a duplicate or
mistaken entry. It is not a substitute for withdrawal or disqualification, which
are the correct tools for someone who registered legitimately and then stopped
racing.

The pane offers **Delete registration** only while the participant holds no
current duck assignment, and offers it as the only destructive action there, so
a paired participant is never shown a button whose command the server refuses.
The console filter is narrower than the server rule described below in one case:
a participant whose assignment has already ended keeps the button and receives
the server's actionable `409` instead.

The request follows the other staff participant mutations: an RFC 4122 v4
`commandId`, the currently loaded `expectedRevision`, the exact application
`Origin` for cookie-authenticated sessions, and a confirmed danger dialog in the
console. A matching retry returns `{ deleted: true, replayed: true }` from
command history, because the registration no longer exists to be re-read;
reusing the identifier for another operation is `409`.

**Only while never paired.** Deletion protects race integrity instead of tearing
it down. It is refused with `409` — a lifecycle conflict, the same code every
other state refusal on this surface uses — when either race-integrity
relationship exists, and the message names withdrawal or disqualification as the
remedy rather than unassigning a duck:

- The participant has any duck assignment, current or already ended. Unassigning
  the duck afterwards does **not** reopen deletion: the ended assignment row
  still exists and still means that participant's duck went into a heat bag.
- The participant appears on any heat roster.

The guard is on the duck, never on the registration status. A reactivated
participant can be `SUBMITTED` again while still holding their duck, and
`SUBMITTED` alone never makes a registration deletable.

Because a participant with any heat entry is refused outright, deletion can never
reach the roster-lock trigger and can never remove a locked, running, or
finalized roster row, and no heat is ever renumbered by this path. The duck
assignment and heat entry are left exactly as they were on a refusal.

The staff participant list and detail projections both carry the two booleans the
console reads to choose between the actions:

- `currentlyPaired` — a duck assignment with `valid_to IS NULL` exists. It is
  exactly `assignment !== null` and is independent of registration status.
- `deletable` — the exact predicate the delete endpoint re-checks inside its
  guarded write: never paired, no heat place, and a deletable event status. Only
  a `deletable` participant may be offered a Delete control; every other
  participant is offered Withdraw or Disqualify instead.

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
duck during `DRAFT`, `REGISTRATION_OPEN`, `REGISTRATION_CLOSED`, `ROUND_ONE`, or
`FINAL`. Intake stays open through racing because deleting a duck mid-race hands
its participant back to the pairing queue, and a race with no spare duck in
inventory would have no way to finish. Only a completed event, or no event at
all, closes intake.

`/staff/inventory` also offers an **Add a duck by hand** form for a tag that is
already written, or a device that cannot scan. It takes a duck number, tag token,
optional storage location and notes, and a physical-presence confirmation; there
is no condition field. The blank-sticker station has no per-duck number, token,
URL, notes, or physical-presence inputs at all. Its operator selects the working
event and may set one station-level storage location of at most 100 characters,
and its client does not reveal or initialize the station until all Android Chrome
Web NFC and page-context requirements pass.

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
as physical-write verification and does not call `makeReadOnly`, so a sticker
stays writable for reuse after the event is deleted.

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
current dataset is a lookup rather than an error: the classification carries that
`duckId`, the page opens that duck's record in the detail panel below the
station, and the station immediately returns to **Ready** without allocating,
writing, confirming, or incrementing **Added this session**. This includes
active, retired, released, different-event, and another operator's pending tags,
regardless of whether an absent/reusable record appears before or after the known
record.

While this station owns a pending operation, only a reading containing exactly
its one pending URL can finish it. A pending URL mixed with a reusable URL, or
multiple inconsistent known URLs, fails safely after complete classification
without writing, confirming, clearing command IDs, or changing either count. If
the exact local pending URL now classifies as already, the station resolves the
same confirmation command instead of treating the tag as unrelated. A replayed
confirmation response completes that current addition exactly once, increments
session history/count once, enters **Remove duck**, and then returns to
**Ready**. Only a separately scanned current tag receives the count-neutral
already-in-inventory lookup.

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

### The Inventory Page

`/staff/inventory` holds all of inventory on one page: a working-event select,
the blank-sticker scanning station, the **Add a duck by hand** form, the duck
list, and the duck detail panel. It accepts `?duck=<id>` and `?raceEntry=<id>`,
so the console's heat roster and participant detail panel hand work to it: a
`duck` opens that duck's detail panel, and a `raceEntry` fills the assignment
form. Each is consumed once, so a later refresh does not keep pulling the panel
back.

The duck list groups the cards into labelled sections that are derived from the
inventory projection itself, not from any new state:

1. **In use** — the duck holds an unreleased event reservation, has an open
   participant assignment, or its inventory status is `IN_USE`. Reservation and
   pairing are checked first, so a reserved duck that is damaged or quarantined
   is still reported as in use.
2. **Ready to be reserved** — the duck is not reserved or paired and its
   inventory status is `AVAILABLE`, which is exactly the state assignment and
   scan-first pairing accept.
3. **Not ready to reserve** — every remaining status (`NEW`, `QUARANTINED`,
   `DAMAGED`, `MISSING`, `UNACCOUNTED_FOR`, `KEPT`) with no live reservation or
   assignment.

The first two sections are always rendered and state an explicit message when
they are empty; the third appears only when it holds ducks. Cards keep the
existing card grid, the sticky detail panel, selection and focus behaviour, the
detail request versioning, and live refresh. A `RETIRED` duck is excluded from
the list entirely; see **Deleting a Duck**.

### Duck Detail and Label Data

A duck's number cannot be changed, and there is no condition field anywhere staff
can see or set one. `ducks.physical_condition` remains in the schema and is
written only as the blank-sticker station's own `NEEDS_TAG`-then-`GOOD` marker; a
later migration drops it. The label-data action returns only the visible number
and canonical active tag URL; it does not generate or print a label.

Inventory detail includes current state and append-only views of inventory
events, tag versions, event reservations, and duck assignments, plus the duck's
stored name and whether the read-time filter is already hiding it. Raw tag tokens
are not returned in detail/history responses. Participant names are included
only when the actor also has `REGISTRATION`, has `RACE_DIRECTOR`, or is an
administrator.

### Deleting a Duck

Deleting is the one way a duck leaves inventory. It replaces the retired
pre-race inventory edit, tag replacement, and tag retirement commands, which
asked staff to reason about tag states that only ever meant "this duck is out of
the race".

`POST /api/v1/staff/inventory/ducks/<duck-id>/delete` requires the
`DUCK_MANAGER` or `RACE_DIRECTOR` role, which administrators pass implicitly, and
a body of `{ commandId, eventId, expectedRevision, reason }` with a 4-to-500
character reason. A stale revision returns `409` without deleting anything, and a
duck reserved for another event is not this event's to delete. The command row is
`DELETE_DUCK` and the redacted audit event is `DUCK_DELETED`, recording the
visible number, whether the rows were erased, the unpaired race entry, and the
staff reason. Because an erased duck leaves no inventory-event row to compare a
replay against, the command row itself is the idempotency record: a retry returns
`{ deleted: true, replayed: true }` and reuse for another duck returns `409`.

There are two write paths and they look identical to the actor:

- A duck with no published heat result is erased outright. One batch removes its
  `duck_tags`, `duck_assignments`, `event_ducks`, and `ducks` rows, after first
  clearing `duck_tags.supersedes_tag_id`, because that self-referencing
  restricted foreign key would otherwise refuse a multi-row tag delete.
  `duck_inventory_events` cascades with the duck; the audit event is what
  survives.
- A duck that appears in a published heat result keeps its rows so that result
  stays truthful. Its active tag is retired, its event reservation is released,
  and its inventory status becomes `RETIRED`. `RETIRED` ducks are excluded from
  the inventory list, so the duck is equally gone from every staff surface.

**A paired duck's participant is not deleted with it.** The assignment closes
with end reason `DUCK_DELETED`, the registration returns to `SUBMITTED`, and the
duck name is cleared, which is exactly the state a participant sits in before
pairing. They keep their place in the heat, because a heat entry names the race
entry and the duck is resolved through whichever assignment is currently open.
Staff then pair them with another duck through the normal flow, and no heat can
start while anyone on its roster holds nothing.

### Scan-First Pairing

The normal pairing workflow is:

1. The participant selects a physical duck.
2. Logged-in staff open that duck's NFC/QR URL.
3. QuickDucks verifies the tag and displays the exact duck.
4. Staff identify the participant by one of three paths:
   - **Scan QR:** scan the QR code on the participant's private status screen.
   - **Exact code:** type the participant's full lookup code and search.
   - **Search:** search by partial code, name, phone, or email, then select an
     unpaired registration and review participant plus duck.
5. A scan or an exact code pairs immediately, because each identifies exactly
   one participant. A non-exact search always requires selecting a result and
   pressing the one confirmation button.
6. QuickDucks atomically reserves the duck if needed, creates a current
   assignment, changes registration to `ACTIVE`, changes inventory to `IN_USE`,
   writes audit history, and assigns an immediate-mode heat when applicable.

Every path issues the identical guarded pairing command with a fresh command ID.
Scanning and exact-code entry only supply the lookup code; they never bypass
authentication, role checks, event scope, tag state, inventory state, or
registration state, and every rejection is reported the same way.

Pairing is allowed while the event is `REGISTRATION_OPEN`,
`REGISTRATION_CLOSED`, `ROUND_ONE`, or `FINAL`. The registration must be
`SUBMITTED` and unpaired. The duck must have an active tag, no current
assignment, an eligible inventory state, and no reservation for another event.

The two racing statuses are what make repairing a deleted duck possible: a
participant whose duck was deleted is `SUBMITTED` with no open assignment, which
is exactly the state pairing already expects, so replacing their duck is the
ordinary scan-first command and not a separate workflow.

Staff search accepts an empty query, an exact normalized code, or a
case-insensitive name or contact substring. Opening the pairing work area
immediately lists up to 100 participants who have no current duck assignment;
typing filters that same server-authoritative list. The SQL excludes paired
participants for both listing and search, and the response applies the same
exclusion defensively, so an assigned participant is never rendered. A truncated
list tells the operator to type to narrow it.

The search response reports `exactMatch` only when the normalized query is a
well-formed lookup code that equals an unpaired returned registration's code.
The console pairs that match directly instead of rendering a single-row list.
Submitting with Enter prevents native form navigation and blurs the search field
before the request so a mobile keyboard closes.

### Participant QR Codes

The private status page renders the participant's existing eight-character
lookup code both as readable text and as a QR code. The QR encodes only
`QD1:<lookup code>` and is generated on the server as a self-contained SVG, so
it carries no name, contact detail, private status token, event identifier, or
external reference. Photographing it reveals exactly what photographing the
printed code beside it would.

**Implemented:** `/my-ducks` renders the same QR on every registration this
device owns, in both the Awaiting Participants and My Ducks sections. That is
the surface a participant reliably still has at the duck table, because the
private status link only helps someone who bookmarked it, so pairing no longer
depends on having kept it. A followed entry has no lookup code and therefore no
QR, exactly as it has no readable code today.

Those cards are built in the browser, so the projection sends drawing geometry
— the symbol size and one SVG path — rather than markup, and the page builds
the symbol with `createElementNS` and `setAttribute`. No part of the response is
ever parsed as HTML, and the client redraws only geometry matching the encoder's
own alphabet. Server and browser encode through one function in
`participant-qr.ts`, so a card QR and the private page's QR are the same symbol.
A stored code the encoder cannot represent yields no QR for that one card
instead of failing the whole My Ducks response.

The staff pairing page shows a **Scan QR code** button whenever the browser has
a camera in a secure context. The scanner ignores any QR code that is not a
`QD1:` participant payload and keeps looking, so unrelated codes never reach the
pairing command. A failed pairing invites another scan or a manual search. The
camera is released on success, cancellation, page unload, or when the page stays
hidden past a short grace period. That grace period prevents mobile camera
permission UI from immediately closing a stream that has just started.

Decoding uses the browser's native `BarcodeDetector` where it exists, which is
Chrome on Android. Browsers without it, including **iOS browsers** and Firefox,
load a bundled decoder from same-origin `/assets/qr-decoder.js` on first scan and
work identically. Browsers with native detection never download it. Scanning
therefore works on iPhone and Android alike; only a device with no camera, or a
non-secure context, falls back to typing the code.

The decoder is minified browser source of the pinned `jsqr` development
dependency, generated into `src/qr-decoder-source.ts` by
`npm run build:qr-decoder` and committed. It is served, never executed in the
Worker, and never becomes a Worker runtime dependency. Tests regenerate it and
fail on any drift from the pinned package, assert it makes no network or `eval`
calls, and decode a rendered participant QR with the exact source that ships.

Camera access is granted by `Permissions-Policy: camera=(self)` on the
authenticated `/staff/ducks/:token` page only. Every other page, station, and API
response keeps `camera=()`.

A participant who already holds a heat place keeps it: the command reuses that
heat entry and books no second slot, and the response reports the heat they were
already in. Otherwise the command uses the lowest-numbered unlocked round-one
heat below the configured ducks-per-heat size or creates the next heat inside the
same atomic batch. It returns the heat number. Pairing rejects before creating a
new heat when the existing round-one heat count has reached final capacity, and
the atomic command re-checks both the open slot and that capacity with guarded
SQL. Pairing stays available through `REGISTRATION_CLOSED` so a participant
paired after the close still lands in a heat.

**Implemented:** because that duck immediately goes into a physical heat bag it
does not come out of, a successful pairing paints one large, high-contrast,
full-width callout at the very top of the pairing page and scrolls it into view.
It reads *Put this duck in HEAT 3 bag* with the heat number at display size, the
duck number beside it as secondary information, and a note that the duck stays in
that bag, in that position, for the rest of the race. It carries an assertive
`aria-live` announcement and stays on screen until the staffer presses **Done —
this duck is in the bag** or scans the next duck, so a live refresh cannot take
it away while they walk to the bags.

The bag is always the round and heat number the pairing command itself committed
and returned; the browser never counts entries or derives a number. A repair
pairing during racing can return the final, and the callout names the final heat
rather than a round-one one. When the response reports `heatAssignmentPending`
or no heat at all, the callout turns to its refused colours and says *Do not bag
this duck yet* with no number, directing the staffer to ask the race director
which heat it belongs to. QuickDucks still records no bag placement or physical
location confirmation.

### Assignment, Reassignment, and Unassignment

The inventory page can assign a selected good, actively tagged, available or
event-reserved duck to a race-entry ID. A reason and current duck revision are
required. This route also performs pre-race reassignment: it closes the prior
assignment, returns the old duck to event-reserved inventory, assigns the new
duck, and preserves the participant's heat entries.

Assignment changes are allowed only in `REGISTRATION_OPEN` or
`REGISTRATION_CLOSED` and are blocked once any participant heat is `CALLING`,
`RUNNING`, `AWAITING_RESULT`, or `FINALIZED`, or has a result. Once racing has
started, the repair is deleting the duck and pairing the participant with
another one through the scan-first flow.

Unassignment is subject to the same phase and dependency limits. It closes the
assignment, changes an `ACTIVE` registration to `SUBMITTED`, and either keeps
the duck reserved or releases the reservation according to the operator's
choice. A separate release action is available for an unassigned reservation
before racing.

**Deferred:** there is no two-participant duck swap, lost/found workflow,
finalist-replacement policy, or physical-location event model. Pre-race
reassignment and delete-then-pair are the two physical-duck replacement
workflows. Heat entries remain attached to the stable race entry.

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

Heats fill in pairing order, but pairing keeps running while registration is
closed, so a close/reopen cycle can leave more than one short heat in a row.
Closing registration therefore repeats a deterministic fold in the same guarded
batch as the status change:

> While some round-one heat holds fewer than three entries and more than one
> heat remains, move the last heat's entries to the end of the heat before it,
> which goes deliberately over its capacity, and delete the emptied heat row.

- With a capacity of 10 and a final heat of 2, the previous heat becomes a heat
  of 12 in one pass.
- A layout of 10 + 1 + 1 folds twice and becomes a single heat of 12, rather
  than stopping on 10 + 2 and leaving a heat round one would refuse forever.
- If the only heat left is still short, there is nothing to merge into. Nothing
  moves, and round one stays blocked until registration reopens and more
  participants sign up.

Every pass deletes exactly one heat, so the loop runs at most once per heat and
always ends. It can only end with no short heat left or with a single heat, and
a single short heat means the event has fewer than three entries in total, which
no layout can fix. Closing registration therefore always produces a layout every
heat of which can race, whenever the total makes that possible.

Reopening registration is the mirrored loop over the same marker:

> While some round-one heat holds more entries than its own `target_size`, move
> the entries past `target_size` into a new last heat that owns a full capacity
> of slots, and give the source heat its capacity back.

A pass leaves a heat of `target_size` and creates one of the moved remainder, so
the total overflow past `round_one_heat_capacity` strictly decreases and the
loop ends. The recovered layout holds every participant once, in slot order,
with no heat over capacity. It is not always the exact pre-close layout: a
two-pass fold deleted the intermediate heat that carried the second marker, so
10 + 1 + 1 reopens as 10 + 2. That is deliberate. The recovered layout is
raceable, and closing again converges on the same result, whereas remembering
the chain would need schema for a distinction no operator can observe.

`heats.target_size` is the merge marker and needs no extra state. It records how
many slots a heat owns: pairing sets it to `round_one_heat_capacity` and never
inserts past it, and roster replacement rewrites it to the roster it just wrote.
A merge is consequently the only writer that can leave a round-one heat holding
more entries than its own `target_size`. A fold chain overwrites markers rather
than stacking them, because each pass records the receiving heat's pre-merge
roster and then deletes the heat it emptied, so at most one heat is over its own
`target_size` at any moment. Comparing against the heat's own `target_size`
rather than the event capacity is what keeps the marker correct when pairing
continues after registration closes and opens a fresh short heat behind the
merged one.

Both operations are atomic without a post-commit repair step:

- A merge deletes the emptied tail heat last. `heat_entries` references `heats`
  `ON DELETE RESTRICT`, so an entry that failed to move aborts the delete and
  rolls the whole batch back.
- A split creates the restored heat only when exactly the expected entries are
  still past `target_size` and round-one heats still fit inside
  `final_heat_capacity`, which is the same guard pairing puts on its own heat
  insert. If it is not created, the moves reference a heat row that does not
  exist and the foreign key aborts the batch. When the plan can already see that
  a heat would not fit, it simply does not split; the reopen still succeeds and
  the next close folds the layout back together.

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

A race director or administrator can replace a nonempty roster while the heat is
`PLANNED` and unlocked and its round has not started yet:

| Heat round | Event status that accepts a replacement |
| --- | --- |
| `ROUND_ONE` | `REGISTRATION_CLOSED` |
| `FINAL` | `ROUND_ONE` |

Starting a round locks every planned heat of that round in the same batch as the
status change, so "planned and unlocked" and "the round is running" cannot both
be true; the editable window is the pre-start window and nothing else. Every
other lifecycle status is refused with `409` and a message naming the window.

Each entry must be active, currently assigned, absent from another heat in the
same round, and, for a final roster, a finalized round-one winner. Replacement
is revision-checked and audited, and every statement in its batch is guarded on
the command row the batch itself inserts, so a replacement that loses its race
writes nothing rather than emptying the heat first.

This repairs a heat that fell below the minimum before the round starts. It is
**not** the remedy for a withdrawn racer: their duck is already sealed in that
heat's bag, rewriting the roster would renumber slots the bags cannot follow, and
they block nothing anyway. Reactivation is the only remedy the eligibility
blocker names. The staff console offers the replacement form for exactly these
statuses, so it never presents a control the API would refuse.

## Heat Readiness and Running

For each round-one and final heat, station staff perform:

1. Review heat detail and the authoritative roster.
2. **Mark Heat Ready**: changes `LOADING` to `READY`.
3. **Heat Has Been Announced**: changes `READY` to `CALLING`.
4. **Start This Heat**: changes `CALLING` to `RUNNING`.
5. A result taker **Mark heat finished**: changes `RUNNING` to
   `AWAITING_RESULT`.
6. A result taker enters and publishes the required result.

A heat cannot lock or start while it holds no `ACTIVE` racer. `transitionHeat`
checks it before the write and repeats it as a SQL guard inside the atomic batch
of both transitions; the refusal is `409` and names reactivation as the remedy.
A heat that merely *contains* withdrawn or disqualified racers locks and starts
normally, with every entry, slot number, and duck assignment untouched.

A heat cannot start while any racer on its roster holds no duck. `transitionHeat`
checks it before the write and repeats it as a SQL guard inside the atomic batch,
so a duck deleted between the two aborts the start rather than sending a racer
out with nothing; the refusal is `409` and names pairing the waiting racers as
the remedy. This is what makes deleting a duck mid-race safe: the heat waits, and
the final in particular cannot run until a heat winner whose duck was deleted has
been paired with another one.

There is no operator lock step. Starting round one moves every planned round-one
heat to `LOADING`, stamps `roster_locked_at`, and permanently locks roster
editing, all in the same guarded batch as the event transition; starting the
final does the same for the final heat. The console and the start-line station
therefore ship no `Lock roster` control. The `announcer-roster` endpoint remains
available for the announcer surface, but the console button that refetched it
into the same element it already showed was a visible no-op and was removed.

A race director or administrator can **Reset Heat** from `READY`, `CALLING`,
`RUNNING`, or `AWAITING_RESULT` before any result is published. The confirmed,
revision-checked command returns the heat to `LOADING`, clears start, finish, and
finalization timestamps, and preserves the locked roster and its lock metadata.
`PLANNED`, `LOADING`, `FINALIZED`, `CANCELLED`, an unlocked or empty roster, and
any published result are refused. The atomic SQL repeats those state, event-round,
roster, and no-result guards and records `HEAT_RESET`; result history is never
deleted by reset.

### Console Roster Deep Links

Each console roster entry shows its slot, participant name, duck number, and the
race-entry identifier, plus up to two navigation buttons. **Participant details**
switches the console to the Participants view through the same `#participants`
hash the menu bar uses, scrolls to it, loads that registration through the
existing participant-selection path, and moves focus into the loaded detail panel.
**Duck # in inventory** navigates to `/staff/inventory?duck=<id>`, which opens
that duck's detail panel on arrival. The participant panel's **Use for duck
assignment** action navigates the same way with `?raceEntry=<id>`.

An entry with no assigned duck offers no duck link. Each link is offered only to
an actor whose roles can open the target surface — `REGISTRATION` or
`RACE_DIRECTOR` for the participant link, `DUCK_MANAGER` or `RACE_DIRECTOR` for
the duck link — and the target pages and APIs enforce the same requirement
regardless of the console. The announcer roster action still renders its own
plain list.

### Focused Start-Line Station

`/staff/start-line` prioritizes any heat awaiting publication, then the current
running heat, then the next unfinished heat in the event's active round. This
prevents a newer prepared or running heat from hiding a pending official result.
It shows event, round, heat number, status, roster names, and visible duck
numbers without contact data. Depending on authoritative status, it exposes
exactly one of **Mark Heat Ready**, **Heat Has Been Announced**, or **Start This
Heat**. A
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
projects exactly slot number, full participant name, visible duck number, and the
racer's `registrationStatus` with an `eligible` boolean. Announcers say the whole
name, so this projection is deliberately the full registered name rather than the
public name policy used on the race board; it carries no contact data, lookup
code, or inventory detail.

A withdrawn or disqualified racer stays on this roster and is marked ineligible
rather than hidden. Their duck is sealed into the heat bag the staff are
physically holding, so the roster has to match the bag, and the status is
precisely what tells the announcer not to call that name.

It also deliberately carries no participant-chosen duck name, even though that
name is public everywhere else. Reading a name aloud is the one place where one
that slipped past the filter becomes a public-address announcement with no undo,
while every written surface can be moderated in seconds; and the announcer needs
the duck number, not a second ambiguous label, to line racers up.

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
finished`. For round one, the station then tells the result taker to scan the
winning duck's permanent NFC or QR URL. Authenticated `GET /t/<tag>` remains
read-only and redirects to `/staff/ducks/<tag>`. If exactly one round-one heat is
awaiting a result and the duck's current participant is an active member of that
roster, the inspection page leads with **Mark Duck as Heat N Winner**. The
confirmed POST revalidates the tag, assignment, roster entry, event round, heat
revision, and sole awaiting heat inside the atomic result command before it
publishes the winner. A result taker receives no contact details, lookup code,
pairing control, or name-moderation control on that inspection page.

**A withdrawn or disqualified duck at the finish line is an expected outcome,
not an error.** A duck that has been paired is already inside a heat bag, and
nobody empties a bag on the bank to fish one duck out, so that duck keeps racing
and can cross the line first. Every finish-line surface that can meet it answers
the same way: `422` with a stable `reason` of `DUCK_NOT_ELIGIBLE` and an
`ineligible` projection carrying the race entry, the policy-filtered display
name, the visible duck number, and the real registration status. That covers
resolving a roster duck by tag URL or by visible number, confirming a scanned
round-one winner, and submitting a reviewed result whose racer was withdrawn in
between — the last of which also names the exact `ineligibleRaceEntryIds` to
drop. The projection adds no contact detail, lookup code, or tag token beyond
what an eligible scan already returns.

The station presents it as a plain statement — *Duck #12 is Withdrawn*, that
this duck stays in its heat, and *Scan the next duck to pass the finish line* —
and stays armed: the heat, the scan field, and the NFC reader are untouched and
nothing has to be dismissed. Scanning that duck's tag instead lands on its staff
inspection page, which shows the same statement in place of the winner action.
Nothing is written and **no heat entry is removed, reordered, renumbered, or
rebalanced**: the withdrawn duck keeps its heat and its slot, and so does every
other duck, both before and after a winner is recorded around it.

The final keeps the complete-podium station flow. It requires distinct places 1
through `min(3, final roster size)`. Every selection displays place,
policy-filtered participant name, and visible duck number before one **Submit
official podium** confirmation. Only one tag or number lookup can run at a time;
the station discards a response if event, heat, revision, or intended place
changed. The role-guarded result endpoint revalidates each selected registration
and current duck assignment. The station offers no result correction or
automatic retry/offline queue.

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
or administrator scans its winning duck and confirms the winner action on the
staff inspection page. A race director or administrator may use the console
result form as a recovery path. QuickDucks atomically:

- Writes one finalized first-place result linked to the current duck assignment.
- Changes the heat to `FINALIZED`.
- Creates the single planned final heat if needed.
- Adds the winner to the next final slot.
- Writes command and audit history.

The console's **Finalists** card appears during `ROUND_ONE`, `FINAL`, and
`COMPLETED` and lists the current promoted winners as they accumulate. There is
no Verify finalists button, verified state, verification wording, physical
winners-bag scan, or set-verification operator step. Final readiness is enforced
by the authoritative lifecycle checks instead.

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

A published winner can be directly replaced while the final heat is `PLANNED`
or locked and `LOADING`. QuickDucks moves the old result into
`heat_result_history` as `SUPERSEDED`, publishes a new revision, and atomically
replaces the exact corresponding finalist roster entry. This narrow correction
is the only update allowed through the locked-roster trigger. The API and its
guarded SQL reject the correction once the final reaches `READY`, `CALLING`,
`RUNNING`, `AWAITING_RESULT`, `FINALIZED`, or `CANCELLED`; the console follows a
server-projected capability and does not show the correction form then.

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
event, `/race` has nothing to report, so it redirects to the home page with a
`303` rather than rendering an empty race-status page. The board includes:

- Safe event lifecycle status and date. The board turns that status into a
  prominent plain-language stage chip and summary line beside the event name:
  `DRAFT` race being prepared, `REGISTRATION_OPEN` participant registration
  open, `REGISTRATION_CLOSED` registration closed while heats are finalized,
  `ROUND_ONE` round one under way, `FINAL` final under way, and `COMPLETED`
  results official. An unrecognized status falls back to neutral wording
  instead of raw enum text.
- Ordered round-one and final heats.
- Safe heat status, including calling, running, and awaiting-result emphasis.
- Policy-filtered participant display names and visible duck numbers, with the
  participant-chosen duck name beside the number when there is one the read-time
  filter allows. The link text stays the bare number; the name never replaces it.
- Finalized heat winners moved to the top of their heat roster with an accessible
  gold **Winner** ribbon beside the participant; all non-winners retain slot
  order. The ordered final podium carries the duck name on the same terms.

Visible duck numbers come only from a current assignment with `valid_to IS
NULL`; a historical assignment closed by pre-race unassignment is never revived
on the board. A roster entry with no current duck number carries no duck name
either. Racers whose registration is `WITHDRAWN` or `DISQUALIFIED` are omitted
from every roster, finalist list, and podium without shifting anybody else; see
Public Visibility of Withdrawn and Disqualified Participants.

The board returns no event, heat, race-entry, registration, assignment, or
result IDs; no contacts, lookup/private/tag tokens, staff data, notes, inventory,
or audit data; and no unfinalized place claims. Before heats exist it shows the
event with a plain-language empty state. With no current event it shows a usable
check-back message.

Participant-level race status remains available through an assigned active duck
tag, exact public name search, and browser collection cards. It exposes:

- Policy-filtered participant display name.
- Visible duck number when currently assigned, and the filtered participant-
  chosen duck name beside it.
- Round-one and final heat numbers and statuses.
- The event's one currently calling, running, or awaiting-result heat.
- Pairing pending, heat assignment pending, not raced, running, awaiting result,
  round-one winner, finalist, eliminated, withdrawn, disqualified, final
  complete, or first/second/third place outcomes.

The outcome gives withdrawal/disqualification priority, then podium, final
completion/finalist state, round-one winner/elimination, running state, pairing,
and heat assignment. Only the two owner-facing surfaces named below ever render
the withdrawn or disqualified outcome.

### Public Visibility of Withdrawn and Disqualified Participants

**Implemented:** a `WITHDRAWN` or `DISQUALIFIED` participant keeps their duck —
it is sealed in a heat bag and may still float past the finish line — but
publicly the application behaves as if they are not in the race. This is a
projection rule everywhere and a data change nowhere: no row is deleted, no heat
is reordered, and no recorded result is altered.

Hidden from them entirely:

| Surface | Behaviour |
| --- | --- |
| Public name search (`GET /api/v1/race-status/search`) | Not returned at all |
| Follow (`POST /api/v1/registrations/mine/follow`) | `404`, so they cannot be followed |
| Live race board and `/race` (`GET /api/v1/race-board`) | Omitted from every round-one and final roster |
| Podium and finalists on that board | Omitted, so they can never be published as a winner |
| Anonymous tag scan `/t/<tag-token>` and `GET /api/v1/ducks/<tag-token>` | Redirects home / `{ "destination": "HOME" }` |
| Public duck page `/duck/<number>` and `GET /api/v1/ducks/number/<number>` | The shared "Duck #N isn't racing." page and `404` |
| A **followed** card in another browser's My Ducks, and that browser's presence probe | The card is absent while they are away |

Still shown, because the participant is entitled to know their own status:

| Surface | Behaviour |
| --- | --- |
| Private status link `/r/<token>` and `GET /api/v1/registrations/<token>` | True `WITHDRAWN`/`DISQUALIFIED` status and outcome |
| My Ducks card for a registration **this device created** (`added_via = 'REGISTRATION'`) | True status and outcome, and the device's presence probe still reports it |
| Every staff surface | Unchanged |

Omitting an entry never shifts anything else. The remaining racers keep their
stored slot order, their printed duck numbers, and their official places: if the
finalist who withdrew held first place, second place is **not** promoted to
first, it is simply the only place still published. A heat whose whole roster
withdrew is still published as a heat, with its number and status and an empty
roster, because its bags physically still exist.

A followed collection link is never deleted by this rule, so reactivating the
participant restores the followed card by itself with nothing to re-follow.

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

Event configuration/deletion, participant edits/status, duck deletion and
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
- A duck name is the one piece of participant free text that is published. It
  passes an in-Worker profanity filter at write time and again on every read, it
  never replaces the canonical duck number, it is never sent to the announcer
  station, it is never written to a command row, an audit event, or a log, and
  staff with the registration or race-director role can set or clear it. A name
  staff set passes exactly the gates a participant's own name passes.
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
- Found-duck handling, two-duck swap, and finalist replacement policy. Replacing
  a duck mid-race is deleting it and pairing that participant with another one;
  there is no dedicated lost-duck command.
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
| Lost-duck replacement, swap, and location tracking work throughout the race | Pre-race reassignment and delete-then-pair are implemented; swap and location tracking are not. |
| Damaged ducks and tags are recorded as a condition, replaced, or retired | Duck condition, tag replacement, and tag retirement are removed. Deleting the duck is the one way out of inventory. |
| Result correction is administrator/race-director only | This is current behavior; result takers can finalize but cannot correct or reopen. |
| Announcer checklist and physical placement are recorded | Only read-only rosters exist; these are operator steps. |
| Multiple annual events/history are retained | Only one event dataset may exist, and the previous race is deleted before the next event. |

Infrastructure and domain setup documents remain authoritative for their own
deployment and permanent-origin subjects, but not for application workflows.
