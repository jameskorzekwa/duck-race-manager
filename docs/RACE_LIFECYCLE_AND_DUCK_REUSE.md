# Race Lifecycle and Duck Reuse

## Purpose

Duck Race Manager supports a new event every year without overwriting previous
registrations, assignments, heats, results, notifications, or audit history.
Physical ducks and permanent NFC tag URLs exist independently from any one
event, so returned ducks can be reused in later races.

Participants may keep their duck. The system records both their preference and
the duck's actual end-of-event disposition so only physically returned,
eligible ducks become available for a future race.

## Permanent and Event-Specific Data

Permanent inventory data:

- Duck ID and visible number
- Permanent NFC tag history
- Permanent QR URL
- Inventory condition and global availability
- Cross-event location/disposition history

Event-specific historical data:

- Participant registration
- Race entry
- Duck assignment history
- Heat entries and bag locations
- Heat announcements
- Results and final qualification
- Email notifications
- Corrections and audit events
- End-of-event duck disposition

Creating a new race never clears or reuses event-specific rows. It creates a
new event and new race entries that can reference eligible existing ducks.

## Event Lifecycle

```text
DRAFT
  -> REGISTRATION_OPEN
  -> REGISTRATION_CLOSED
  -> ROUND_ONE
  -> FINAL
  -> COMPLETED
  -> RETURN_PROCESSING
  -> ARCHIVED
```

`COMPLETED` means results are final. `RETURN_PROCESSING` allows staff to collect
or disposition physical ducks. `ARCHIVED` makes normal event records read-only
while preserving administrative corrections through explicit audited tools.

An organization may prepare the next event while the previous event is
archived. A physical duck cannot be reserved for overlapping active events.

## New Race Wizard

The administrator home screen includes one prominent `Create new race` action.
The wizard uses plain language and a short sequence.

### Step 1: Basic Details

- Race name
- Event date
- Timezone
- Public URL slug
- Registration open and close dates

The slug must be unique. Prior public result URLs remain valid.

### Step 2: Start From Previous Race

The administrator chooses:

```text
COPY LAST RACE SETTINGS
START WITH DEFAULT SETTINGS
```

Copyable settings:

- Heat assignment mode
- First-round and final capacities
- Email required/optional setting
- Upcoming-notification lead
- Public-name policy
- Finalist replacement rule
- Bag label format
- Staff role invitations, after confirmation

Never copy:

- Registrations
- Race entries
- Duck assignments
- Heat entries or results
- Email delivery records
- Audit history
- Missing/location exceptions

The new event records `copied_from_event_id` for traceability.

### Step 3: Select Duck Inventory

The wizard displays counts:

```text
AVAILABLE FOR REUSE
NEW / NEVER USED
KEPT BY PARTICIPANTS
MISSING
DAMAGED OR QUARANTINED
RETIRED
```

Only `AVAILABLE` ducks can be selected. The administrator may select all
eligible ducks, a subset, or add newly provisioned ducks later.

The wizard compares selected inventory with expected registration capacity. It
warns when there are too few reusable ducks and reports how many new ducks must
be provisioned.

### Step 4: Review Race Rules

The wizard summarizes:

- Heat mode and size
- Maximum registrations supported by final capacity
- Participant email behavior
- Duck keep/return option
- Finalist replacement rule
- Selected reusable duck count

Invalid heat/final combinations block activation and explain the correction.

### Step 5: Create Draft

The administrator presses `Create race`. The system creates a `DRAFT` event,
copies only approved settings, reserves no participants, and leaves prior races
unchanged. A checklist identifies remaining setup before registration can open.

## Race History

Administrator history shows one card per event with:

- Event name and date
- Registration count
- Duck count
- Number of heats
- Final podium
- Returned, kept, missing, and retired duck counts
- Archive and data-retention status

Staff can open historical registrations, heat rosters, results, duck
assignments, and audit timelines according to role. Archived data is read-only
by default.

The public site can expose prior public results by year without exposing email,
phone, private registration links, staff identity, or internal location data.

Historical heat results retain the actual duck assignment used in that heat,
even if the participant later received a replacement or the duck was reused in
a future event.

## Participant Keep Preference

Registration or duck-pairing includes a simple option:

```text
After the race:
( ) I plan to keep my duck
( ) I plan to return my duck for a future race
( ) I am not sure yet
```

This is a planning preference, not proof of physical return. Staff record the
actual disposition after racing.

The preference may help estimate future inventory but never makes a duck
available automatically.

## End-of-Race Duck Return Workflow

The staff home screen includes `Return or keep a duck` during
`RETURN_PROCESSING`.

### Returned for Reuse

1. Staff scan the duck by NFC, QR, or visible number.
2. The app shows participant, event, result status, and expected location.
3. Staff select `Returned for reuse`.
4. Staff inspect its physical condition.
5. Staff choose `Good`, `Needs tag`, `Damaged`, or `Retire`.
6. The app confirms the inventory destination.
7. One command records the event disposition and inventory state.

Condition outcomes:

| Condition | Inventory state |
| --- | --- |
| Good | `AVAILABLE` |
| Needs tag | `QUARANTINED` until reprovisioned and verified |
| Damaged | `DAMAGED` |
| Retire | `RETIRED` |

Only a `Good` returned duck is immediately available for another race.

### Kept by Participant

1. Staff scan or locate the participant/duck.
2. Staff select `Participant keeping duck`.
3. The app shows that the duck will leave reusable inventory.
4. Staff confirm.
5. The event disposition becomes `KEPT_BY_PARTICIPANT`.
6. The global inventory state becomes `KEPT`.

The permanent tag can remain attached. Public scans reveal no participant
contact information. The duck is excluded from future race setup unless it is
physically returned and an administrator explicitly reactivates it.

### Not Accounted For

At the end of return processing, unresolved ducks are not assumed returned.
They remain `UNACCOUNTED_FOR` or `MISSING` and are excluded from future races.

The return dashboard lists every unresolved duck by participant, last expected
bag/location, and race result so staff can investigate before archiving.

## Bulk Return Mode

For speed, staff can start `Bulk return scan`:

1. The screen defaults each accepted scan to `Returned, good condition`.
2. Staff continuously scan returned ducks.
3. Each accepted duck produces immediate sound, vibration, visible number, and
   participant name.
4. `Undo last scan` is available until the batch is finalized.
5. Exceptions use a separate `Keep`, `Damaged`, or `Missing` action.

This mode is appropriate only when ducks are physically arriving at a return
station. It must not run concurrently with another mutating scan operation on
the same browser.

## Inventory States

```text
NEW
AVAILABLE
RESERVED_FOR_EVENT
IN_USE
QUARANTINED
DAMAGED
MISSING
UNACCOUNTED_FOR
KEPT
RETIRED
```

State meaning:

| State | Meaning |
| --- | --- |
| `NEW` | Provisioned but never approved for event inventory |
| `AVAILABLE` | Eligible for selection in a future event |
| `RESERVED_FOR_EVENT` | Selected for a draft/open event but not assigned |
| `IN_USE` | Actively assigned within an event |
| `QUARANTINED` | Requires inspection or tag repair |
| `DAMAGED` | Physically unsuitable until repaired |
| `MISSING` | Expected location is known but duck cannot be found |
| `UNACCOUNTED_FOR` | Event ended without confirmed return/keep disposition |
| `KEPT` | Confirmed as taken by participant |
| `RETIRED` | Permanently removed from use |

Inventory state is not inferred only from a participant's preference. It
changes through explicit physical workflows and audited commands.

## Reusing a Duck

When an available duck is selected for a new event:

1. The event creates a reservation for the existing permanent duck.
2. The NFC tag and QR URL remain unchanged.
3. No prior participant data is copied into the new event.
4. New pairing creates a new race entry and duck-assignment history row.
5. Inspection shows current-event status first and historical events only to
   authorized staff.

One physical duck may therefore have this history:

```text
2027: paired with Participant A, returned
2028: paired with Participant B, participant kept duck
2029: unavailable because inventory state is KEPT
```

## Corrections

Administrators can correct an incorrectly recorded return/keep disposition
with a reason. Corrections append new disposition and inventory events; they do
not delete history.

Examples:

- A duck marked kept is later returned.
- A returned duck fails inspection and moves to quarantine.
- A missing duck is found after the event is archived.
- A retired duck is repaired and explicitly reactivated.

Reactivation requires administrator permission and a successful identity/tag
verification.

## Archiving Gate

The event can be archived when:

- Final results are complete or administratively closed.
- Pending race commands are synchronized or resolved.
- Email jobs are delivered, failed, suppressed, or cancelled.
- Every event duck has an end-of-event disposition or is explicitly marked
  unaccounted for.
- Return counts have been reviewed.
- Backup/export has completed.

Archiving does not delete data or release unaccounted ducks into inventory.

## Privacy and Retention

Keeping previous race data does not require keeping all personal information
forever. The organization must define a retention policy for email, phone, and
private registration tokens.

Historical race structure, heat results, duck assignment history, and audit
records can remain while expired contact information is deleted or anonymized.
Public historical results continue to follow the event's public-name policy.

## Data Model Additions

| Table or field | Purpose |
| --- | --- |
| `events.copied_from_event_id` | Records which event supplied copied settings |
| `events.archived_at` | Marks archival time |
| `race_entries.duck_keep_preference` | Participant's planned keep/return choice |
| `event_ducks` | Reserves eligible permanent ducks for an event |
| `duck_event_dispositions` | Returned, kept, damaged, missing, or unresolved outcome |
| `duck_inventory_events` | Append-only global inventory-state history |
| `ducks.inventory_status` | Current materialized inventory state |

## Commands

| Command | Purpose |
| --- | --- |
| `createEventFromPrevious` | Copy allowed settings into a new draft event |
| `reserveEventDucks` | Select available inventory for an event |
| `openRegistration` | Validate setup and open the event |
| `recordDuckDisposition` | Record returned, kept, damaged, or unresolved outcome |
| `bulkReturnDucks` | Idempotently process a return-station scan batch |
| `correctDuckDisposition` | Append an audited correction |
| `archiveEvent` | Validate the archive gate and make the event historical |
| `reactivateDuckInventory` | Return a found/repaired duck to available inventory |

## Required Invariants

- Creating a new event never copies participants, assignments, heats, results,
  notifications, or audit rows.
- Archived race results retain their historical duck assignments.
- A duck cannot be reserved for overlapping active events.
- A duck is available for reuse only after confirmed return and condition check.
- A keep preference never changes inventory without physical disposition.
- `KEPT`, `MISSING`, `UNACCOUNTED_FOR`, `DAMAGED`, `QUARANTINED`, and `RETIRED`
  ducks cannot be paired in a new event.
- Reused ducks keep the same permanent NFC and QR identity.
- Disposition corrections append history rather than replacing it.

## Acceptance Tests

- Create a new race by copying settings without copying any participant data.
- Open historical heat results after creating and running a later event.
- Return a duck and make it selectable in the next event.
- Mark a duck kept and prevent selection in the next event.
- Keep preference alone does not make a duck unavailable before disposition.
- Bulk return scans are idempotent and support safe undo before finalization.
- Missing and unaccounted ducks remain unavailable after archive.
- A found duck can be inspected, corrected, and reactivated with an audit trail.
- A reused duck keeps its NFC URL but receives a new event assignment.
- Historical results identify the duck used in each race without exposing old
  participant contact information publicly.
