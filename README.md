# Duck Race Manager

Duck Race Manager is a planned registration and race-operations system for an
annual physical duck race. Participants register through a public website,
staff pair each participant with a permanently tagged duck, race officials
load and run configurable heats, and the public follows heat winners and the
final podium online.

The project is designed as a mobile-first progressive web application. Each
duck's writable NFC tag is provisioned once with a permanent, random HTTPS
URL. Android Chrome is used for the one-time tag-writing workflow. During
normal registration and race operation, both iPhones and Android phones can
identify ducks by opening those URLs. QR codes and visible duck numbers provide
fallbacks.

The protected inventory station provisions a batch of 150-200 blank writable
NDEF stickers. A duck manager, race director, or administrator selects the race
and optional station location, presses Start once in Android Chrome over HTTPS,
and then taps one sticker per duck. QuickDucks generates the duck UUID, globally
unique internal number, random 32-byte tag token, and canonical
`https://quickducks.com/t/<token>` URL, writes that URL, confirms it only after
Web NFC reports a successful write, signals success, and immediately readies
the station for the next physical tap. No duck number needs to be printed or
entered.

Provisioning is online-only and has no pasted-token, manual-number, offline
queue, or service-worker fallback. A durable pending reservation survives a
reload or uncertain network result and must be retried with the same sticker
before another duck can be allocated. NFC hardware serials are used only as
transient in-memory read debouncing, never as duck identity. Tags remain
writable so a damaged mapping can be replaced through the controlled staff
workflow.

No participant information is stored on an NFC tag.

## Status

The project is in early implementation. See
[docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the product scope,
architecture, NFC design, race workflows, data model, security requirements,
delivery phases, and acceptance criteria.

## Key Decisions

- Use a hosted website/PWA rather than a custom mobile application.
- Permanently identify each duck with a random token embedded in its NFC URL.
- Provision tags through a protected Android Chrome staff page.
- Support registration and race operations from either iPhone or Android.
- Keep hardware serial numbers transient and in-memory only; never persist,
  transmit, display, or use them as duck identity.
- Support spotty race-day connectivity with cached data and an offline outbox.
- Preserve NFC-independent QR and manual-entry recovery paths.
- Keep continuous inventory intake online-only; never queue physical-intake
  mutations offline.
- Host the PWA, API, and database on Cloudflare's free developer platform.
- Push privacy-safe finite-domain invalidations through one hibernatable Durable
  Object while keeping D1-backed APIs authoritative on every device.
- Fill fixed-size heats (at least three ducks) as participants are paired.
- Send upcoming-heat email notifications to participants who provide email.
- Provide a read-only duck inspection workflow for misplaced ducks.
- Preserve a participant's heat and race status when replacing a lost duck.
- Optimize staff workflows for speed and people with limited technical skill.
- Create each annual race from non-race defaults after permanently deleting the prior race dataset.
- Re-register physically returned ducks from scratch for each new race.

## Planned Applications

- Public participant registration
- Staff registration lookup and walk-up registration
- Duck inventory and NFC provisioning
- Participant-to-duck assignment
- Two configurable round-one heat assignment and bagging workflows
- Participant heat assignment and upcoming-heat email notifications
- Pre-heat announcer roster
- Read-only duck status inspection and recovery tools
- Guided lost-duck replacement, tag replacement, and duck swapping
- Role-specific, scan-first staff screens with plain-language recovery
- Administrator delete-event cleanup and empty new-race setup
- Round-one winner recording and finalist promotion
- Final verification and first/second/third place recording
- Public heat results and final podium
- Administrative correction and audit tools

## Running it locally

The whole site runs on one machine with no network access, and seeds itself with
a race at any lifecycle state:

```sh
npm ci
npm run dev:local                          # http://localhost:8787
npm run dev:network                        # or serve it to your phone over https
npm run seed:local -- --state=round-one    # in a second terminal
```

See [local development](docs/LOCAL_DEVELOPMENT.md) for the seed states, the
offline sign-in accounts, and what is deliberately still not local.

## Documentation

- [Local development](docs/LOCAL_DEVELOPMENT.md)
- [Project plan](docs/PROJECT_PLAN.md)
- [Domain and hosting setup](docs/DOMAIN_SETUP.md)
- [Heat assignment, notifications, and duck inspection](docs/HEAT_ASSIGNMENT_AND_NOTIFICATIONS.md)
- [Staff UX and duck recovery](docs/STAFF_UX_AND_DUCK_RECOVERY.md)
- [Race lifecycle and duck reuse](docs/RACE_LIFECYCLE_AND_DUCK_REUSE.md)
- [Infrastructure](docs/INFRASTRUCTURE.md)
- [Registration API](docs/REGISTRATION_API.md)
- [Scan, pairing, and participant status](docs/SCAN_PAIRING_AND_PARTICIPANT_STATUS.md)

## License

No license has been selected yet. Until a license is added, all rights are
reserved.
