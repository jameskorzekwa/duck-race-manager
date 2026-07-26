# Duck Scan, Pairing, and Public Status

## Permanent Tag Behavior

Every NFC and QR tag contains the permanent URL `https://quickducks.com/t/<token>`.
Opening that URL is always a read-only navigation. A scan never pairs a duck,
changes a heat, or records a result by itself.

The response depends on assignment state and staff authentication:

| Duck state | Anonymous visitor | Authenticated staff |
| --- | --- | --- |
| Not paired for the current event | Redirect to the QuickDucks home page | Open the protected pairing page for that duck |
| Paired for the current event | Open the public race-status page | Open staff inspection with a link to the public status page |
| Unknown or invalid tag | Redirect to the QuickDucks home page | Show a protected invalid-tag explanation |

The paired public page may show participant name, visible duck number, assigned
heat, which heat is currently running, advancement/winner state, and published
race results. It never shows email, phone, staff lookup code, private status
token, inventory location, audit history, or staff-only notes.

## Staff Pairing

Pairing requires a verified staff session and an authorized event role. It is
never available through an anonymous route.

1. Staff scan the participant's selected duck.
2. The protected page shows the duck number and confirms that it is available.
3. Staff enter the participant's short lookup code.
4. If the participant lost the code, staff search by participant name and
   select the correct event registration.
5. The page shows participant and duck together.
6. Staff explicitly confirm the pairing.
7. One authenticated, idempotent command creates the assignment, changes the
   registration to `ACTIVE`, writes an audit event, and performs any
   mode-specific heat placement.

Name search on the staff page may include the lookup code. Public name search
must never return lookup codes or contact information.

## Shared Browser Registration List

A parent or group may register multiple participants from one phone. Email and
phone are not unique participant identifiers, and repeated registrations from
the same device are valid.

After each successful registration, the Worker appends a small record to the
host-only `__Host-quickducks-registrations` cookie. Each record contains:

- Participant display name
- Staff lookup code
- Private status path

The cookie is `Secure`, `HttpOnly`, `SameSite=Lax`, scoped to `/`, bounded in
size, deduplicated, and persistent across refreshes. The home page reads it
server-side and displays `Your registrations on this device`, including a link
to register another participant. The cookie is a convenience, not the system
of record or staff authorization.

## Public Name Search

If browser state is unavailable, anyone may search public race status by
participant name. Results may contain only:

- Participant display name
- Visible duck number, when paired
- Assigned heat and round
- Currently running heat
- Registration/race status
- Advancement, winner, and published placement state

Search never returns contact information, private status paths, staff lookup
codes, internal registration IDs, inventory state, or audit data. Duplicate
names remain separate results; the visitor uses duck and heat information to
identify the intended participant.

## Security Boundary

The public status and browser-list features can be implemented independently.
Staff pairing remains blocked until the application has verified Cognito
sessions, active staff-profile checks, event-role authorization, CSRF
protection, assignment constraints, and audit-backed commands.
