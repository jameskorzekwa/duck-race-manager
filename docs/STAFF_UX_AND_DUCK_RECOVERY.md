# Staff UX and Duck Recovery

## Purpose

Race-day staff must be able to operate Duck Race Manager quickly and safely
without technical training. Lost ducks, damaged tags, incorrect pairings, and
ducks placed in the wrong bag are expected operational events, not exceptional
database repairs.

The product must make the common path obvious and the recovery path guided. No
routine race-day task should require staff to understand NFC, tokens, database
IDs, synchronization internals, or state-machine terminology.

## Participant Identity Versus Physical Duck

A participant's place in the race must not be permanently tied to one physical
duck. The domain model separates:

| Concept | Meaning |
| --- | --- |
| Registration | The participant's submitted personal information |
| Race entry | The participant's identity and progression in one event |
| Duck assignment | A time-bounded link between a race entry and physical duck |
| Heat entry | The race entry's slot in a heat |
| Heat result | The result plus the physical duck assignment used in that race |

Heat assignment and qualification belong to the race entry. A physical duck
can therefore be replaced without moving the participant to another heat or
removing a round-one qualification.

Duck assignments are historical rather than overwritten:

```text
Race Entry #123
  Duck #41 from 9:14 AM to 10:32 AM, replaced because missing
  Duck #287 from 10:32 AM onward, current
```

If Duck #41 won Round 1 and Duck #287 later races in the final, the Round 1
result still records Duck #41 while the final records Duck #287.

## Recovery Operations

Staff see three separate actions with plain-language explanations:

| Action | Use |
| --- | --- |
| Replace lost duck | The physical duck is missing or unusable; assign an available replacement |
| Replace NFC tag | The physical duck remains correct but its tag is damaged or incorrect |
| Swap participants' ducks | Two active participants need to exchange physical ducks |

These operations must not be combined into one ambiguous administrator form.

## Replace a Lost Duck

### Entry Points

Staff can begin from any of these places:

- Scan the old duck if it is available but damaged for racing.
- Search the participant by name or registration code.
- Open the heat roster and select the participant.
- Search by visible duck number.
- Open a missing-duck alert from `Inspect Duck`.

The old duck does not need to be physically present.

### Guided Workflow

1. Staff select `Replace lost duck`.
2. The app shows the participant, current duck, heat, expected bag, and race
   status.
3. Staff select a simple reason: `Lost`, `Damaged`, `Wrong bag`, or `Other`.
4. The app asks staff to scan an available replacement duck.
5. The server verifies that the replacement is active, unassigned, and eligible.
6. The app shows one before/after confirmation screen.
7. Staff press `Confirm replacement`.
8. One atomic command ends the old assignment and creates the new assignment.
9. The new duck inherits the race entry's heat and qualification state.
10. The old duck becomes `MISSING` or `RETIRED` according to the selected reason.
11. The app gives a large physical instruction such as `Put Duck 287 in HEAT 4
    BAG` or `Put Duck 287 in WINNERS BAG`.
12. Staff confirm the physical placement.

The system records the reason, staff member, browser device, time, old duck, new
duck, heat, and affected physical locations.

### Allowed Race Phases

| Phase | Normal behavior |
| --- | --- |
| Before heat assignment | Replace duck; no heat state changes |
| Assigned or bagged, before `RUNNING` | Replace duck and preserve heat slot |
| Round-one winner, before final | Preserve qualification only when event rules allow finalist replacement |
| Heat currently `RUNNING` | Block normal replacement |
| Result already recorded | Require race-director correction or rerun workflow |
| Event completed | Inventory correction only; historical results remain unchanged |

The event must explicitly configure whether a round-one winner may use a
replacement duck in the final. If disabled, the app presents the applicable
withdrawal or race-director decision instead of silently transferring
qualification.

### If the Old Duck Is Found

Finding a replaced duck never automatically reactivates it. Staff inspect it,
select `Mark found`, and place it in an available, quarantine, or retired area.
The current replacement remains assigned unless an administrator intentionally
performs another replacement.

## Replace Only an NFC Tag

Use this operation when the duck is physically present and correct but its NFC
sticker no longer works or opens the wrong URL.

1. Staff identify the duck by visible number, QR, participant, or heat roster.
2. Staff select `Replace NFC tag`.
3. The app confirms that the physical duck and participant will not change.
4. On an Android provisioning phone, staff write and verify a new tag token.
5. The old tag mapping is retired.
6. The new mapping becomes active for the same duck.

Heat, participant, location, and race progression remain unchanged. Replacing a
tag is never represented as replacing a duck.

## Swap Two Participants' Ducks

This is a less common, higher-risk operation available only before either race
entry's current heat begins.

1. Staff select `Swap two ducks`.
2. Staff identify the first participant/duck.
3. Staff identify the second participant/duck.
4. The app shows both participants, both ducks, both heats, and both expected
   bags side by side.
5. The app explains where each physical duck must move after the swap.
6. Staff enter or select a reason.
7. Staff confirm the complete swap once.
8. One atomic command ends both assignments and creates both new assignments.
9. Each participant retains their original race entry, heat slot, and
   qualification.
10. Staff confirm both physical bag movements.

If either heat is running or finalized, the normal swap is blocked. A race
director must use result correction or rerun controls.

## Replacement Validation

A replacement command is rejected when:

- The new duck is already actively assigned.
- The new duck is retired, missing, or has no active tag/QR identity.
- The participant is withdrawn or disqualified.
- The heat is currently running.
- The result state would be rewritten without race-director authority.
- Finalist replacement is disabled by event rules.
- Another command changed either race entry after the confirmation screen loaded.
- Required offline changes have not synchronized.

The error must state what happened and the next safe action. Example:

```text
Duck 287 is already paired with Sam Lee in Heat 6.

Choose a different duck, or ask an administrator to swap both participants'
ducks.
```

## Atomicity and Audit

Replacement and swap commands are all-or-nothing. A failure cannot leave a
participant without a duck or leave one duck assigned to two people.

Required invariants:

- One active race entry per registration and event.
- One active duck assignment per race entry.
- One active race entry per duck and event.
- Heat entries reference race entries, not physical ducks.
- Every heat result records the duck assignment actually used for that heat.
- Replacing a duck does not silently change heat membership.
- Replacing a tag does not create a new duck assignment.
- Swapping two ducks preserves both race entries and both heat slots.
- Historical assignments and results are never overwritten.

Every change produces a human-readable audit event and machine-readable old/new
identifiers. Inspection shows the full timeline.

## Email Behavior After Replacement

If the participant's heat does not change, replacement does not send another
`HEAT_ASSIGNED` or `HEAT_UPCOMING` email. Existing notification uniqueness
remains valid.

If a race director explicitly moves the race entry to another heat, the system
cancels unsent old-heat notifications and queues one `HEAT_CHANGED` correction
message. This template is required only when heat-changing corrections are
implemented.

## Staff UX Principles

### Role-Specific Home Screens

Staff should see only the actions needed for their role.

Registration staff home:

```text
FIND PARTICIPANT
PAIR A DUCK
WALK-UP REGISTRATION
FIND / REPLACE A DUCK
```

Race official home:

```text
PREPARE NEXT HEAT
CALL PARTICIPANTS
RECORD WINNER
FIND / REPLACE A DUCK
```

Administrator home adds event setup, staff management, corrections, and
reports. Administrative controls stay out of routine staff screens.

### Scan First

Every duck-related screen provides one prominent `Scan duck` action plus
smaller `Scan QR` and `Enter duck number` fallbacks. Staff never type tag tokens
or database identifiers.

Opening a duck URL while authenticated and without another mutating operation
is role-aware. An eligible unassigned duck opens a pairing page for that duck;
staff must still identify the participant and explicitly confirm one
`ASSIGN_DUCK` command. An assigned or ineligible duck defaults to safe
inspection. A scan never guesses replacement, winner, or heat-loading intent.

### One Task Per Screen

Each screen has:

- One clear title describing the current task
- One primary action
- A visible event and heat number
- A short instruction in plain language
- A clear way to cancel or go home
- No unrelated settings

Use `Put this duck in HEAT 4 BAG`, not `Location transition completed`. Use
`This duck is already in Heat 3`, not `Unique constraint violation`.

### Progressive Disclosure

Routine staff see names, duck numbers, heat numbers, bag instructions, and
large action buttons. Technical details, audit IDs, raw provider errors, and
advanced corrections are hidden behind administrator-only details.

### Confirmation Policy

Avoid confirmation fatigue:

- Routine heat-loading scans are accepted immediately and support `Undo last
  scan` before roster lock.
- Pairing a participant and duck uses one concise confirmation.
- Replacement and swapping always show a before/after confirmation.
- Locked-roster or result corrections require a reason and stronger warning.
- No operation uses a generic `Are you sure?` message.

### Visual and Physical Consistency

- Heat number is the largest element on heat and bag screens.
- Bag labels use the same heat number and optional color as the app.
- Color is never the only identifier.
- Success, warning, and failure use text, icon, color, sound, and vibration.
- Participant names and duck numbers remain visible after a scan until staff
  acknowledge the physical instruction.

## Accessibility and Readability

- Target WCAG 2.2 AA for the web interface.
- Use touch targets at least 48 by 48 CSS pixels.
- Use a minimum 16-pixel text size, with larger defaults on operational screens.
- Maintain strong contrast in direct sunlight.
- Never encode state using color alone.
- Support browser text enlargement without clipping controls.
- Use plain verbs and short sentences.
- Avoid abbreviations, technical status codes, and unexplained icons.
- Keep critical controls away from browser edge gestures where practical.

## Speed Requirements

Common workflows should meet these design budgets on a prepared device:

| Workflow | Target |
| --- | --- |
| Open a primary role action | One tap from home |
| Pair participant and duck | Scan duck, enter code or find participant, confirm |
| Inspect duck | One scan from the global `Find duck` action |
| Replace lost duck | Select replacement, scan new duck, confirm |
| Load next heat duck on Android | Continuous scan with immediate local feedback |
| Open announcer roster | One tap from the current heat |
| Record winner | Select heat, scan winner, confirm |

After the browser reports a scan, the interface should provide local visual,
sound, and haptic feedback within 300 milliseconds. The online operation should
normally confirm within two seconds. If it takes longer, the app shows a clear
`Saving` or `Waiting for connection` state without allowing an accidental
duplicate action.

## Error and Offline Design

Every error answers three questions:

1. What happened?
2. Did the action save?
3. What should staff do next?

Examples:

```text
Already saved
Duck 41 is already in Heat 4. Nothing changed.
```

```text
Not saved yet
There is no internet connection. Keep this duck in the PENDING area and retry
when the connection returns.
```

```text
Wrong bag
Duck 82 belongs in HEAT 7 BAG, not Heat 6.
```

The app never displays raw stack traces, HTTP status codes, SQL errors, or NFC
exception names to race-day staff.

## Navigation Safety

- The current event is always visible.
- Race-day mode can lock the browser to one event.
- The active scan operation is shown in a persistent banner.
- Starting another scan operation requires cancelling the current operation.
- Browser refresh or an iPhone NFC-opened tab restores the current safe context.
- Back navigation cannot resubmit a command.
- Repeated scans are idempotent and explain the previous accepted action.

## Training and Help

- Provide a demo event with fake participants and ducks.
- Demo mode must be visually distinct and unable to alter the live event.
- Include a one-page quick-reference sheet for each role.
- Add a persistent `Help` action with task-specific instructions.
- Use screenshots and physical bag examples rather than technical explanations.
- Run a full rehearsal with the same phones, bags, labels, and staff roles.

## Usability Validation

Before production, test with at least five volunteers who did not build the
system and do not consider themselves technically proficient.

Each volunteer should complete without developer intervention:

- Find a participant and pair a duck
- Put the duck in the instructed bag
- Inspect a misplaced duck
- Replace a missing duck
- Prepare and announce a heat
- Record a winner
- Recover from a duplicate scan
- Recover from a simulated network outage

Acceptance targets:

- At least 95 percent of routine tasks complete correctly on the first attempt.
- No participant is assigned twice or placed in the wrong heat because of UI
  ambiguity.
- Staff can identify whether an action saved without asking for help.
- New staff can learn their role in no more than ten minutes.
- Common workflows meet the documented tap and response-time budgets.
- Every observed critical mistake results in a design change and another test.

## Data Model Additions

| Table or field | Purpose |
| --- | --- |
| `race_entries` | Stable participant identity and progression within an event |
| `duck_assignments.valid_from` | Assignment start time |
| `duck_assignments.valid_to` | Assignment end time; null for current assignment |
| `duck_assignments.end_reason` | Lost, damaged, swapped, corrected, or retired |
| `heat_entries.race_entry_id` | Keeps heat slot stable when the duck changes |
| `heat_results.duck_assignment_id` | Records the physical duck used for that result |
| `events.allow_finalist_replacement` | Race-rule decision for qualified participants |

## Commands and Queries

| Operation | Type | Purpose |
| --- | --- | --- |
| `inspectDuck` | Query | Return role-filtered status, location, and history |
| `replaceRaceEntryDuck` | Atomic command | End old assignment and attach an available duck |
| `replaceDuckTag` | Atomic command | Change tag mapping without changing physical duck |
| `swapRaceEntryDucks` | Atomic command | Exchange physical ducks while preserving race entries |
| `markDuckMissing` | Command | Record expected-location exception |
| `markDuckFound` | Command | Resolve missing state without reactivating assignment |
| `undoLastUnlockedScan` | Command | Reverse a safe pre-lock scan |

## Acceptance Tests

- Replacing a missing duck preserves participant, heat, and bag instruction.
- Replacing a qualified duck follows the configured finalist-replacement rule.
- A round-one result retains the original duck after a later replacement.
- Swapping two ducks preserves both participants' heat slots.
- Replacing a tag leaves duck assignment and heat state unchanged.
- Concurrent replacement requests cannot assign one duck twice.
- A found old duck does not automatically replace the current duck.
- Routine staff cannot perform locked-roster or result corrections.
- Every replacement and swap produces a complete audit timeline.
- Common actions are reachable within the documented tap budgets.
- Errors use plain language and state whether the action saved.
- Non-technical usability testing meets the documented acceptance targets.
