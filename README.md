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

No participant information is stored on an NFC tag.

## Status

The project is currently in planning. See
[docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the product scope,
architecture, NFC design, race workflows, data model, security requirements,
delivery phases, and acceptance criteria.

## Key Decisions

- Use a hosted website/PWA rather than a custom mobile application.
- Permanently identify each duck with a random token embedded in its NFC URL.
- Provision tags through a protected Android Chrome staff page.
- Support registration and race operations from either iPhone or Android.
- Keep hardware serial numbers diagnostic only; never depend on them.
- Support spotty race-day connectivity with cached data and an offline outbox.
- Preserve NFC-independent QR and manual-entry recovery paths.
- Host the PWA, API, and database on Cloudflare's free developer platform.

## Planned Applications

- Public participant registration
- Staff registration lookup and walk-up registration
- Duck inventory and NFC provisioning
- Participant-to-duck assignment
- Configurable round-one heat planning and loading
- Round-one winner recording and finalist promotion
- Final verification and first/second/third place recording
- Public heat results and final podium
- Administrative correction and audit tools

## Documentation

- [Project plan](docs/PROJECT_PLAN.md)
- [Domain and hosting setup](docs/DOMAIN_SETUP.md)

## License

No license has been selected yet. Until a license is added, all rights are
reserved.
