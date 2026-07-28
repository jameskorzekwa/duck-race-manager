# Race Lifecycle, Purge, and Duck Reuse

> **Design history.** This document predates the removal of duck-return
> tracking and the staged purge ceremony. Returns, dispositions, return
> batches, the `RETURN_STEWARD` role, and the `RETURN_PROCESSING`/`ARCHIVED`
> statuses no longer exist. The lifecycle is `DRAFT -> REGISTRATION_OPEN ->
> REGISTRATION_CLOSED -> ROUND_ONE -> FINAL -> COMPLETED`, and the
> administrator "Delete event" action is the only cleanup path.
>
> Duck condition is also gone. Staff never choose `Good`, `Needs tag`,
> `Damaged`, or `Retire`, and `ducks.physical_condition` is no longer a field
> staff see or set. Deleting a duck is the one way it leaves inventory. See
> `docs/WORKFLOWS.md` for implemented behavior.

## Purpose

QuickDucks supports one race dataset at a time. After physical duck collection
is complete, the system deletes the entire race dataset: participants, event,
ducks, NFC/QR tag mappings, assignments, heats, results, notifications, browser
links, commands, and audits.

Before the next race, staff start with empty race inventory and re-register
every physically returned duck that will be offered. A tag may remain attached
to the physical duck, but its token has no database meaning between races and
must be scanned, verified, and registered again.

## Retained Application Data Versus Purged Race Data

Retained application data:

- Database schema and migrations
- Staff Cognito accounts and active `staff_profiles`
- Organization-level non-race defaults needed to operate the application
- Infrastructure configuration and encrypted runtime credentials

Race data deleted during purge:

- Event configuration and dates
- Participant registration and all names/contact information
- Private registration tokens and short lookup codes
- Browser registration collections and links
- Race entries
- Event duck reservations
- Duck assignment history
- Heat entries, announcements, and results
- Email messages, attempts, and provider identifiers
- Event locations, dispositions, corrections, commands, and audits
- Public race status and name-search records
- Duck IDs, visible numbers, inventory states, and condition records
- Active and retired tag-to-duck mappings and provisioning records

No duck, tag, participant, event, or result row survives into the next race.

## Event Lifecycle

```text
DRAFT
  -> REGISTRATION_OPEN
  -> REGISTRATION_CLOSED
  -> ROUND_ONE
  -> FINAL
  -> COMPLETED
  -> RETURN_PROCESSING
  -> ARCHIVED (purge-ready, temporary)
  -> DELETED
```

`COMPLETED` means racing is complete. `RETURN_PROCESSING` reconciles every
physical duck. `ARCHIVED` is not a long-term history state; it is a brief,
read-only purge-ready state after all deletion gates pass. The final purge
deletes the event row itself.

Normal staff mutation is disabled in `ARCHIVED`. Only an administrator may
cancel purge readiness to correct unresolved inventory, or execute purge.

## Creating the Next Race

A new event starts from organization-level defaults, not historical event or
duck records. Staff then perform a physical inventory intake and re-register
every returned duck selected for the new race.

Copyable template settings:

- Heat assignment mode
- First-round and final capacities
- Email required/optional setting
- Upcoming-notification lead
- Public-name policy
- Finalist replacement rule
- Bag label format

Never copy or template:

- Names or contact information
- Registrations or lookup codes
- Race entries or duck assignments
- Heat entries or results
- Email delivery records
- Browser collections
- Commands, audits, or exceptions

The new race wizard begins with zero ducks. During inventory intake, staff scan
each physical duck, confirm or enter its visible number, verify the attached
NFC/QR tag, and create a new duck/tag mapping for the new race. Ducks that were
kept, missing, damaged, or not physically presented simply are not registered.

## End-of-Race Duck Reconciliation

Registration and pairing do not ask whether a participant plans to keep or
return a duck. Return staff record only the actual observed disposition. The
legacy `race_entries.duck_keep_preference` database column is retained for
compatibility but is ignored, and its rows are deleted in the final purge.

### Returned for Reuse

1. Staff scan the duck by NFC, QR, or visible number.
2. The app shows the temporary participant/event context needed to verify it.
3. Staff select `Returned for reuse`.
4. Staff inspect physical condition.
5. Staff choose `Good`, `Needs tag`, `Damaged`, or `Retire`.
6. One command records the temporary event disposition and updates the permanent
   duck inventory projection.

| Condition | Permanent inventory state |
| --- | --- |
| Good | `AVAILABLE` |
| Needs tag | `QUARANTINED` |
| Damaged | `DAMAGED` |
| Retire | `RETIRED` |

### Kept by Participant

1. Staff scan or locate the participant/duck.
2. Staff select `Participant keeping duck`.
3. Staff confirm that it leaves reusable inventory.
4. Permanent inventory becomes `KEPT`.

The tag may remain attached, but after purge its token is unknown and sends
anonymous users to the home page. It becomes meaningful again only if staff
register and verify that physical duck for the next race.

### Missing or Unaccounted For

Unresolved ducks are never assumed returned. Before purge, each must be marked
`MISSING` or `UNACCOUNTED_FOR` in permanent inventory. Both states prevent
future event reservation.

If a duck is found after the event was purged, it has no application record.
Staff physically inspect it and may register it during the next race's inventory
intake. No deleted participant or race history is reconstructed.

## Bulk Return Mode

For speed, staff may run a temporary event-scoped bulk return operation:

1. Each scan defaults to `Returned, good condition`.
2. Immediate feedback shows duck number and participant name while event data
   still exists.
3. `Undo last scan` is available before finalizing the batch.
4. Exceptions use explicit `Keep`, `Damaged`, or `Missing` actions.

The batch and its audit records are deleted with the event after their effects
have been materialized into permanent inventory state.

## Purge Gate

An event can become purge-ready only when:

- Racing is completed or administratively closed.
- No heat is `RUNNING` or awaiting an unresolved result.
- Pending commands have synchronized or been resolved.
- Email jobs are delivered, failed, suppressed, or cancelled.
- Every event duck has a confirmed disposition or is marked missing/unaccounted.
- Return counts and unresolved exceptions have been reviewed by an
  administrator.
- Staff acknowledge that participant, result, audit, duck, tag, and race data
  cannot be recovered after purge.

Purge is blocked rather than guessing when any gate fails.

## Purge Operation

`purgeEvent` is an administrator-only, online command with a strong confirmation
that names, contacts, results, and history will be permanently deleted.

The operation deletes event-scoped rows in dependency order, including:

1. Browser-collection links for the event's registrations
2. Email attempts and notifications
3. Heat results and heat entries
4. Heats and roster/announcement records
5. Duck assignments and event duck reservations
6. Registration status/private tokens and race entries
7. Event dispositions, locations, commands, and all race/duck/tag audits
8. Registrations and the event
9. Duck tags and duck inventory rows

All browser registration collections and cookies become invalid because the
system supports one race dataset at a time.

The purge is an atomic D1 transaction and is idempotent after the event has been
deleted. Any failed statement rolls back the entire deletion sequence.

## Privacy Promise

Public pages state plainly:

- Email addresses and phone numbers are visible only to logged-in authorized
  staff.
- Anonymous name search returns public race status only and never returns
  contact details, lookup codes, private links, or staff information.
- Personal, race, duck, and tag data are deleted after duck return processing
  completes.
- A physically attached NFC/QR tag is unknown to QuickDucks until staff
  re-register it for the next race.

No hidden analytics, backups, exports, or logs may silently preserve purged
participant or event data. Infrastructure logs must exclude request bodies,
private tokens, lookup codes, names, email addresses, and phone numbers.

## Data Model

Temporary event tables include:

```text
events
registrations
race_entries
event_ducks
duck_assignments
heats
heat_entries
heat_results
email_notifications
email_attempts
race_commands
audit_events
browser_collection_registrations
```

`ducks` and `duck_tags` are race-scoped inventory tables even though their
physical identifiers remain useful for the duration of one race. Their rows are
purged with all other race data. Browser collection rows are also deleted.

## Required Commands

| Command | Purpose |
| --- | --- |
| `createEventFromTemplate` | Create a draft from non-participant defaults |
| `registerRaceDuck` | Register and verify a physically presented duck/tag for the new race |
| `openRegistration` | Validate setup and open the event |
| `recordDuckDisposition` | Materialize returned/kept/damaged/missing inventory state |
| `bulkReturnDucks` | Idempotently process return scans |
| `markEventPurgeReady` | Validate every purge gate and make the event read-only |
| `cancelEventPurgeReady` | Reopen return processing for an explicit correction |
| `purgeEvent` | Permanently delete the complete event and all dependent data |

Implemented staff routes:

- `POST /api/v1/staff/ducks/{tagToken}/dispositions` records or corrects one
  physical disposition and materializes its inventory state.
- `POST /api/v1/staff/events/{eventId}/ducks/{visibleNumber}/dispositions`
  supports located, missing, and unaccounted ducks that cannot be tag-scanned.
- `GET /api/v1/staff/events/return-review` summarizes automated return gates.
- `POST /api/v1/staff/events/{eventId}/purge-ready` performs the administrator
  review acknowledgement and transitions the event to `ARCHIVED`.
- `POST /api/v1/staff/events/{eventId}/purge-ready/cancel` records a correction
  reason and reopens `RETURN_PROCESSING`.

## Acceptance Tests

- Purge is blocked until physical return processing and exception review are
  explicitly completed.
- No duck or tag row remains after purge, including returned, kept, missing,
  damaged, quarantined, and retired records.
- After purge, tag scans cannot recover participant names, contact details,
  assignments, heats, results, or the prior event.
- Public name search returns no results from a purged event.
- `My registrations` removes purged registrations and deletes empty browser
  collections.
- Staff search returns no names, lookup codes, email addresses, or phone numbers
  from a purged event.
- Replaying `purgeEvent` is safe after all race and inventory rows are gone.
- A later event starts with zero ducks and can register physically returned
  ducks without recovering or copying deleted data.
