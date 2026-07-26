# Scan, Pairing, and Participant Status

This document is the canonical design for duck-tag navigation, staff pairing,
participant status recovery, and multiple registrations from one browser. It
supersedes earlier statements that every public scan displays a generic duck
page.

## Core Decisions

- The permanent NFC/QR URL remains `GET /t/<tag-token>`.
- A GET is always read-only. Opening a tag never creates an assignment or
  changes race state.
- During one race, the server resolves the physical duck while the web
  application chooses the next page according to staff authentication and
  active assignment state. After purge, the token is unknown until staff
  register it again for the next race.
- Staff scan the selected duck first, then identify the participant by their
  short lookup code or a protected name, phone, or email search.
- One browser may register and retain status access for many participants.
- Anonymous users see race status only after a duck has an active assignment.
- Public status never exposes email, phone, staff-only history, inventory
  location, private registration links, or unassigned inventory.

## Role-Aware Tag Navigation

### Logged-In Staff

When a valid staff session opens an active tag:

| Duck state | Destination |
| --- | --- |
| Eligible and unassigned | Pairing page for that scanned duck |
| Already assigned | Staff inspection page with participant, heat, race state, location, and history |
| Assigned to another event | Staff conflict page; no mutation |
| Ineligible, missing, damaged, or retired | Staff inspection page explaining the safe next action |
| Unknown or invalid tag | Staff not-found/provisioning-help page |

The unassigned pairing page prominently shows the visible duck number and
offers two participant lookup methods:

1. Enter or scan the participant's short lookup code.
2. Search the current event by participant name.

Selecting a participant is read-only. Staff review the participant and duck
together, then submit one explicit, authenticated `ASSIGN_DUCK` command.

### Anonymous Participant or Spectator

When a browser without a staff session opens a tag:

| Duck state | Destination |
| --- | --- |
| No active assignment | QuickDucks home page |
| Active assignment | Public race-status page for that duck's race entry |
| Retired, unknown, or invalid tag | QuickDucks home page |

The anonymous response must not reveal whether an unassigned token maps to
inventory. Unknown, retired, and unassigned tags therefore have the same public
outcome.

## Staff Pairing Workflow

1. The participant selects a physical duck.
2. A logged-in staff member scans its NFC tag or QR code.
3. The app verifies the tag, inventory eligibility, and current assignment.
4. If unassigned, the app opens `Pair Duck <number>`.
5. Staff enter the participant's short code or search by name, phone, or email.
6. Search results are scoped to the current event and show enough information
   to disambiguate duplicate names, including registration status and current
   duck when one exists.
7. Staff select the registration and review participant plus duck together.
8. Staff confirm once.
9. One atomic command:
   - creates or confirms the duck's event reservation;
   - creates a versioned duck assignment;
   - changes the registration from `SUBMITTED` to `ACTIVE`;
   - changes the duck inventory projection to `IN_USE`;
   - assigns an immediate-mode heat slot when applicable; and
   - appends command and audit records.
10. The response shows the heat/bag instruction or clearly says that balanced
    heat assignment is pending.

Pairing fails without partial changes when either the duck or race entry gains
another active assignment concurrently. Replaying the same command returns the
original result.

## Participant Home-Page Status

After a successful registration, the browser receives an opaque,
high-entropy browser-collection cookie. The cookie is:

- `Secure`;
- `HttpOnly`;
- `SameSite=Lax`;
- named `__Host-quickducks_browser`;
- scoped to `/` on `quickducks.com`; and
- persistent across refreshes and browser restarts for the configured
  retention period.

The cookie contains only an opaque collection token. It does not contain names,
email addresses, phone numbers, lookup codes, database IDs, or private status
tokens. The database stores only the token hash and links the collection to
each registration created in that browser. Successful collection reads renew
both the cookie and server-side expiry.

The home page calls a same-origin `My registrations` endpoint. When the
collection contains registrations, the home page shows a status section with:

- one card per participant;
- participant display name;
- short lookup code to show registration staff;
- registration and duck-assignment state;
- assigned visible duck number;
- assigned heat or `Heat assignment pending`;
- event's current heat status; and
- winner, finalist, eliminated, disqualified, or podium state when known.

Registering another participant appends to the same collection. Shared email
or phone values are allowed and do not merge registrations. Each participant
keeps an independent registration, lookup code, race entry, private status
token, duck assignment, heat entry, and result history.

Clearing cookies removes the browser shortcut but does not delete registrations
or race history. The user can also explicitly remove a registration from the
local list without withdrawing it from the race.

## Recovery by Name

If browser state is lost, the home page offers participant-name search for the
current public event. Submitted entries may show `Awaiting duck pairing`;
assigned entries show public race status.

Public search obeys `events.public_name_policy`:

```text
FIRST_NAME_ONLY
FIRST_NAME_LAST_INITIAL
FULL_NAME
```

Results never include contact information, lookup codes, private status links,
registration IDs, staff notes, inventory state, expected physical location, or
audit history. An unassigned result contains no duck number or inventory data.

Search is normalized, exact-name matched, event-scoped, result-limited,
rate-limited, and protected against bulk enumeration. A query may exactly match
a first name, last name, or full name. Duplicate names remain separate results.
Assigned results include the visible duck number; unassigned results show only
the privacy-filtered display name and pairing-pending state.

Name search is a public-status recovery mechanism, not authorization. It does
not restore private registration access or add an entry to the browser
collection. Restoring private access requires the private link or a future
verified recovery workflow.

The registration form, confirmation, home-page status section, and public
search page display a plain-language privacy notice:

> Your email and phone number are visible only to logged-in authorized race
> staff. They are never shown in public search or race status. After duck return
> processing, QuickDucks permanently deletes the complete race, including
> participant, duck, tag, result, and audit data.

## Public Race Status

The same race-status representation is used by assigned NFC scans, browser
collection cards, private participant status, and safe public name search.
Role-specific fields are filtered at the API boundary.

Public fields may include:

| Area | Public information |
| --- | --- |
| Event | Name, date, and lifecycle state |
| Duck | Visible duck number |
| Participant | Display name according to event public-name policy |
| Assignment | Paired or heat assignment pending |
| Round one | Heat number and heat state |
| Current race | Round, heat number, and `CALLING`, `RUNNING`, or `AWAITING_RESULT` state |
| Progress | Not raced, currently racing, awaiting result, winner/finalist, eliminated, withdrawn, or disqualified |
| Final | Final heat state and first/second/third place when finalized |

The status page must distinguish the participant's assigned heat from the heat
currently running. A participant in Heat 8 should be able to see both `Your
heat: 8` and `Currently running: Heat 5`.

## API Contract

```text
GET  /api/v1/ducks/<tag-token>
GET  /api/v1/race-status/search?eventId=<id>&name=<query>
GET  /api/v1/registrations/mine

GET  /api/v1/staff/ducks/<tag-token>
GET  /api/v1/staff/registrations/search?eventId=<id>&q=<code-or-name>
POST /api/v1/staff/ducks/<tag-token>/assignments
POST /api/v1/staff/events/<event-id>/purge
POST /staff/logout
```

Staff endpoints require a verified Cognito access token and a matching
`staff_profiles` row. Pairing accepts a client command UUID, event ID, selected
lookup code, and scanned tag token. Staff authorization, event state,
assignment uniqueness, tag state, inventory eligibility, and command
idempotency are rechecked server-side.

The browser receives access and refresh tokens only as separate host-only
HttpOnly staff-session cookies after a Cognito authorization-code and PKCE
exchange. Access and ID tokens are valid for at most 15 minutes; the browser
silently rotates both cookies while the refresh token remains within its
absolute seven-day Cognito validity. Rotation never exposes the refresh token to
JavaScript, responses, URLs, logs, or D1. Definitive refresh rejection (`400`,
`401`, or malformed success) clears both cookies. Network, `408`, `429`, and
`5xx` failures preserve the existing refresh cookie unchanged for a later retry.
Staff APIs also accept an explicit Bearer token for trusted non-browser clients
and never refresh those requests. Mutations made with browser cookies require
the exact QuickDucks origin, preventing a cross-site form from submitting a
pairing or purge command.

Staff logout is a same-origin POST form. It requires an exact `Origin`, with a
strict same-origin `Referer` fallback only when `Origin` is absent. Accepted
logout clears both cookies and redirects through Cognito even if best-effort
refresh-token revocation fails over the network or returns non-2xx. Offline JWT
verification does not observe Cognito revocation immediately, leaving a copied
access token with at most 15 minutes of residual validity. Every request reloads
the live `staff_profiles.is_active` value from D1, so deactivation still fails
closed immediately; revocation and global sign-out prevent future refresh.

Authenticated staff registration search accepts lookup code, name, phone, or
email and may return full name, email, and phone for event operations. Those
columns are never selected by anonymous name search
or public duck status queries.

## Data Model

| Table or field | Purpose |
| --- | --- |
| `events.public_name_policy` | Controls names on public status/search |
| `event_ducks` | Reservation of a registered race duck for the active event |
| `duck_assignments` | Time-bounded race-entry-to-physical-duck history |
| `heats` | Authoritative round, number, and heat lifecycle state |
| `heat_entries` | Race-entry slot in a heat |
| `heat_results` | Finalized place plus physical duck assignment used |
| `browser_registration_collections` | Hashed opaque browser collection token and expiry |
| `browser_collection_registrations` | Many registrations retained by one browser |

All listed event, duck, tag, assignment, heat, result, browser, command, and
audit rows are purged after return processing. The next race re-registers its
physical ducks from scratch.

## Acceptance Tests

- An anonymous scan of an unassigned, retired, unknown, or invalid tag has the
  same home-page destination and exposes no inventory metadata.
- An anonymous scan of an assigned duck opens public race status without
  contact information or staff-only fields.
- A logged-in staff scan of an eligible unassigned duck opens pairing for that
  exact duck.
- Staff can locate a participant by exact lookup code, name, phone, or email and disambiguate
  duplicate names.
- Pairing creates one current assignment and changes the registration to
  `ACTIVE`; concurrent double assignment cannot partially save.
- Refreshing or reopening the same browser preserves all registrations in its
  collection.
- One browser can register at least ten participants and show all independent
  lookup codes.
- Public name search can find submitted and assigned participants after cookies
  are lost while private fields remain undiscoverable.
- Status distinguishes the participant's assigned heat from the event's
  currently running heat and updates after winner/final/podium records.
