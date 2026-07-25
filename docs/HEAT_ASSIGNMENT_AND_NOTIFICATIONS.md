# Heat Assignment, Notifications, and Duck Inspection

## Purpose

Each event selects one of two first-round heat assignment modes. Both modes use
the same participant registration, permanent duck tags, results, final, public
pages, and staff permissions. They differ in when a duck receives its heat and
how the physical heat bags are assembled.

This document also defines upcoming-heat email notifications, the pre-heat
announcer roster, and the read-only duck inspection workflow.

## Event Configuration

The event stores an immutable `heat_assignment_mode`:

```text
IMMEDIATE_FIXED_HEATS
POST_CLOSE_BALANCED_DRAW
```

The mode is selected before registration opens. It cannot change after the
first duck is paired because changing modes would invalidate physical bag
locations, heat rosters, and participant notifications.

Shared settings include:

| Setting | Purpose |
| --- | --- |
| `round_one_heat_capacity` | Maximum or fixed first-round heat size |
| `final_heat_capacity` | Maximum number of round-one winners in the final |
| `notify_heats_ahead` | How many heats before racing to send an upcoming notice |
| `email_required` | Whether registration requires email |
| `public_name_policy` | How participant names appear publicly |

`IMMEDIATE_FIXED_HEATS` uses a fixed first-round capacity of 10 ducks.
`POST_CLOSE_BALANCED_DRAW` calculates balanced targets after registration
closes.

Because one winner from every first-round heat advances, both modes must
validate that the number of first-round heats fits in the final.

## Mode A: Immediate Fixed Heats

### Intent

Assign a participant and duck to a heat at the registration station. Every heat
has ten slots except the final, partially filled heat. The duck is immediately
placed in that heat's physical bag and does not need to be scanned again before
the first-round race.

Benefits:

- The participant knows their heat as soon as their duck is paired.
- Heat-assignment and upcoming-heat emails can be sent with useful notice.
- Heat bags are assembled during participant check-in.
- Race officials do not need to scan every duck again before each heat.

Tradeoffs:

- The last heat will usually contain fewer than ten ducks.
- Withdrawals or misplaced ducks can make earlier heats uneven.
- Multiple registration stations require online coordination or preallocated
  heat bags during an outage.
- Ten-duck heats can create a large final because every heat contributes one
  winner.

### Atomic Assignment Workflow

1. Staff retrieve or create the participant registration.
2. Staff start `ASSIGN_DUCK` and scan the selected duck.
3. The server validates the registration and duck.
4. The server finds the lowest-numbered open heat with fewer than ten entries.
5. If no open heat exists, the server creates the next numbered heat.
6. One atomic command creates the duck assignment and heat entry.
7. The response identifies the heat number and physical bag label.
8. Staff show the assignment to the participant.
9. Staff place the duck in the matching heat bag.
10. Staff confirm physical placement before completing the workflow.

The database and command handler must prevent concurrent stations from taking
the same final slot. Conditional writes, uniqueness constraints, and command
retries must preserve exactly ten slots per full heat.

When a heat reaches ten entries, it closes to new assignments. Registration
closure locks the final underfilled heat at its actual count. No automatic
rebalancing occurs because the ducks are already separated into physical bags
and participants may already have been notified.

### Offline Registration Stations

Immediate assignment normally requires an online server decision. If multiple
stations independently choose the next heat while offline, they can overfill a
bag or assign the same slot.

The supported outage procedures are:

- Use one designated assignment device until connectivity returns.
- Pre-claim separate heat numbers and physical bags for each station while
  online.
- Pair the participant and duck offline but leave heat assignment pending until
  synchronization, keeping the duck in a clearly labeled pending area.

The PWA must never silently guess an immediate heat while offline.

### Participant Communication

After the assignment synchronizes, the participant's private status page shows
their heat. If an email address is present and notifications are enabled, the
system queues a `HEAT_ASSIGNED` email.

## Mode B: Post-Close Balanced Draw

### Intent

Pair participants and ducks during registration without assigning heats. After
registration closes, calculate balanced heat targets. Race officials randomly
draw and scan ducks into each heat before it runs.

Benefits:

- First-round heats are as even as mathematically possible.
- Physical random drawing determines heat membership.
- Late registration changes do not require moving ducks between existing heat
  bags before registration closes.

Tradeoffs:

- Participants do not know their heat during registration.
- Every first-round duck must be scanned again when loading a heat.
- Upcoming email notice may be short if heats are loaded just before racing.

### Registration Workflow

1. Staff retrieve or create the participant registration.
2. Staff pair the participant and selected duck.
3. The duck assignment becomes active without a heat entry.
4. Staff place the duck in the common random-draw pool or bag.
5. The participant's status page says that heat assignment is pending.

### Balanced Plan

After registration closes, let:

- `N` be the number of active duck assignments.
- `C` be the configured maximum first-round heat size.
- `F` be the final heat capacity.
- `H = ceil(N / C)` be the first-round heat count.

The plan is valid only when `H <= F`. Target sizes are:

```text
base = floor(N / H)
extra = N mod H
```

`extra` heats contain `base + 1` ducks. The rest contain `base`. Sizes differ
by at most one.

### Random Draw and Bagging

1. A race official selects and claims the next heat.
2. The PWA displays that heat's target count.
3. Officials randomly draw a duck from the common pool.
4. Staff scan it by NFC, QR, or visible number.
5. The server validates and creates the heat entry.
6. Staff place the accepted duck in the heat bag.
7. The process repeats until the target count is reached.
8. Staff lock the synchronized roster and seal the bag.
9. The system queues heat-assignment emails for newly identified participants.

Officials may preload several heat bags to provide more notification lead time.
If a heat is loaded immediately before racing, the interface warns staff that
participants will receive little advance notice.

## Shared Pre-Heat Workflow

Every heat uses the same start procedure regardless of assignment mode:

1. Race control selects the heat that is coming up.
2. The app confirms that its roster is locked and synchronized.
3. The app opens a high-contrast `Announcer View`.
4. The view lists the heat number, duck count, participant names, and duck
   numbers.
5. The announcer reads the participants before the race.
6. Staff can check off names as they are announced.
7. The app records who marked the roster announced and when.
8. The heat moves from `CALLING` to `RUNNING`.

The announcer roster is generated from authoritative heat entries, never from a
separate manually maintained list. Full names are visible only to authorized
staff. Public pages follow the configured public-name policy.

The heat state model becomes:

```text
PLANNED
  -> LOADING
  -> READY
  -> CALLING
  -> RUNNING
  -> AWAITING_RESULT
  -> FINALIZED
```

## Upcoming-Heat Email Notifications

### Notification Rules

Email is sent only when a valid address is present and race notifications are
enabled for the registration. The form clearly states that supplied email may
be used for operational race updates and provides a way to disable future
notices.

Initial transactional templates:

| Type | Trigger |
| --- | --- |
| `HEAT_ASSIGNED` | A synchronized duck assignment receives a heat |
| `HEAT_UPCOMING` | Race progress reaches the configured number of heats ahead |

Potential later templates include registration confirmation, final
qualification, results, cancellation, and schedule change. They are not needed
to implement the first upcoming-heat workflow.

### Timing

The event setting `notify_heats_ahead` controls lead time. For example, with a
value of two, starting Heat 3 queues notifications for Heat 5.

Mode-specific behavior:

| Mode | Assignment notice | Upcoming notice |
| --- | --- | --- |
| Immediate fixed heats | Immediately after duck pairing and heat assignment | When race progress reaches the configured lead |
| Post-close balanced draw | Immediately after the heat roster is locked | At the configured lead, or immediately if the heat is already within it |

Advancing the current heat must be an explicit race-control command. It updates
race progress and creates any newly due notification records in the same
logical operation.

### Message Contents

Each message includes:

- Event name
- Participant name
- Heat number
- Current race progress or number of heats remaining
- Instructions for where the participant should go
- Link to the participant's private status page
- Link to public race status/results
- Notification preference link

Do not promise a precise start time unless the event is operating against a
maintained schedule. Heat order and current progress are more reliable.

### Queue and Delivery Architecture

1. A domain command inserts one unique `email_notifications` row.
2. The command publishes the notification ID to Cloudflare Queues.
3. A queue consumer loads the current registration and heat data.
4. The consumer renders text and HTML from a versioned template.
5. The provider adapter sends one message to one participant.
6. The provider message ID and result are recorded.
7. Temporary failures retry with backoff.
8. Permanent failures and exhausted retries become visible to staff.

Cloudflare Queues Free includes 10,000 operations per day. A successful message
normally consumes three operations, so 500 notifications consume about 1,500
operations before retries and fit comfortably within that allowance.

Delivery must not occur inside the heat-state HTTP request. Queuing keeps race
controls responsive and makes retries safe.

### Delivery Provider and Cost

The application uses an `EmailSender` interface so provider choice does not
affect race rules.

Amazon SES is the recommended production provider for this event size. Pricing
reviewed in July 2026 is approximately $0.10 to $0.16 per 1,000 outbound
recipient messages, depending on the account pricing mode, with no required
monthly minimum for a-la-carte sending. A 500-to-1,500-message event should cost
roughly $0.05 to $0.24, excluding unusual attachment or transfer charges.

Alternatives:

| Provider | Relevant limitation |
| --- | --- |
| Resend Free | 100 emails per day; insufficient for race day |
| Brevo Free | 300 emails per day; insufficient for 500 participants |
| Cloudflare Email Service | Arbitrary recipients require Workers Paid; 3,000 messages included monthly |

The sending domain must be verified and configured with the provider-required
SPF, DKIM, and DMARC records. Production access, sending quotas, bounce handling,
and complaint handling must be verified before rehearsal.

### Idempotency and Delivery State

The database enforces one logical message per event, registration, heat, and
notification type. Queue retries cannot create a second logical notification.
Provider idempotency keys are used when available, but local uniqueness remains
authoritative.

Delivery states:

```text
PENDING
  -> QUEUED
  -> SENDING
  -> SENT
  -> DELIVERED
```

Failure states:

```text
RETRY_PENDING
FAILED
BOUNCED
COMPLAINED
SUPPRESSED
CANCELLED
```

Staff can see aggregate counts and individual failures. A failed email never
blocks a heat from running; the announcer view remains the authoritative onsite
notification method.

### Offline Behavior

Email cannot be delivered while the event system is disconnected. Commands
created offline show notification state `WAITING_FOR_SYNC`. They are queued only
after the server accepts the assignment or race-progress command.

Staff must be able to distinguish:

- Participant has no email
- Notifications disabled
- Waiting for synchronization
- Queued
- Sent
- Failed or suppressed

## Duck Inspection and Recovery

### Safe Inspection

Authorized staff can select `Inspect Duck` and scan by NFC, QR, or visible duck
number. An authenticated staff member who opens a duck tag without an active
mutating scan operation is also taken to the read-only inspection page.

Inspection never changes assignment, heat, location, or result state. All
corrective actions require separate role-checked commands and confirmation.

Public users who scan the same tag see only the generic public duck page and no
participant, operational, or location information.

### Inspection Summary

The page shows:

| Area | Information |
| --- | --- |
| Duck | Visible number, active/retired state, tag provisioning state |
| Tag | Active/replaced status and last successful scan; raw token is masked |
| Participant | Paired/unpaired state, participant name, registration status |
| Heat | Assigned/unassigned, heat number, round, roster and race state |
| Location | Expected physical pool, heat bag, winners bag, or completed area |
| Race | Not raced, winner, finalist, eliminated, disqualified, or podium place |
| Synchronization | Pending local/server commands or known conflict |
| History | Timestamped assignment, bag, scan, result, correction, and staff actor |

Race officials see the participant name needed for announcements. Contact
details remain restricted to registration staff and administrators.

### Expected Physical Location

Location states include:

```text
AVAILABLE_FOR_PICKUP
PENDING_ASSIGNMENT_SYNC
RANDOM_DRAW_POOL
HEAT_BAG
AT_START
WINNERS_BAG
COMPLETED_AREA
MISSING
RETIRED
```

Each physical movement appends a `duck_location_events` record with event,
duck, location, related heat when applicable, staff/device actor, timestamp,
and source command. The latest accepted event is the expected location shown by
inspection.

### Recovery Actions

Based on role and race state, the inspection page may offer:

- Open the paired registration
- Show the expected heat bag label
- Mark the duck missing
- Mark the duck found in its expected location
- Correct a pre-lock heat assignment
- Remove or replace a failed tag
- Open the heat or result record
- Review pending synchronization conflicts

Every mutation requires confirmation and an audit reason when it changes a
locked roster, assignment, or result. The read-only inspection result remains
available even when no corrective action is permitted.

### Offline Inspection

The PWA can resolve known ducks from its cached event data. Offline inspection
shows the cache timestamp and a prominent warning that another device may have
newer information. Contact information is not included in the general race-day
cache.

## Data Additions

| Table or field | Purpose |
| --- | --- |
| `events.heat_assignment_mode` | Selects immediate or balanced-draw behavior |
| `events.notify_heats_ahead` | Configures notification lead |
| `registrations.email_notifications_enabled` | Participant notification preference |
| `heat_entries.assignment_source` | Records pairing-time or draw-time assignment |
| `heat_entries.assigned_at` | Authoritative heat assignment time |
| `heat_roster_calls` | Records announcer completion and actor |
| `duck_location_events` | Append-only expected physical location history |
| `email_notifications` | One logical notification and current status |
| `email_attempts` | Provider attempts, IDs, errors, and timestamps |

## Required Invariants

- Event heat-assignment mode cannot change after the first duck pairing.
- Immediate mode creates no heat with more than ten entries.
- Closing immediate registration locks the last partial heat without balancing.
- Balanced mode creates no first-round entry before the post-close plan exists.
- One duck can appear in only one first-round heat.
- Every heat roster shown to the announcer comes from authoritative entries.
- A participant receives at most one email of each type for a heat.
- Email failure cannot change race state or block the onsite announcement.
- Duck inspection is read-only and safe to repeat.
- Public duck inspection reveals no participant or operational information.

## Acceptance Tests

- Concurrent immediate assignments fill Heat 1 with exactly ten ducks before
  creating Heat 2.
- Closing immediate registration preserves an underfilled final heat.
- Balanced planning produces sizes differing by at most one.
- Mode A pairs, assigns, and identifies the correct bag in one workflow.
- Mode B leaves the duck unassigned until a random draw scan.
- Both modes produce the same announcer view before `RUNNING`.
- Advancing race progress queues only newly due upcoming notices.
- Replaying commands or queue messages does not duplicate emails.
- Provider failure retries and appears in staff delivery status.
- A no-email participant remains visible in the announcer roster.
- Inspecting an unpaired duck shows its availability and provisioning state.
- Inspecting a paired duck shows participant, heat, expected bag, and history.
- Inspecting a winner shows the winners bag and final qualification.
- Public tag scans never expose staff-only inspection data.

## References

- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- [Cloudflare Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Email Service pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
- [Amazon SES pricing](https://aws.amazon.com/ses/pricing/)
- [Resend pricing](https://resend.com/pricing)
