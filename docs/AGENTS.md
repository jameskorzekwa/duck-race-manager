# DOCUMENTATION KNOWLEDGE

## AUTHORITY

- `WORKFLOWS.md` is canonical for currently implemented participant, staff,
  administrator, lifecycle, role, security, and recovery behavior.
- `INFRASTRUCTURE.md` is canonical for GitHub, AWS, Cloudflare, D1, release,
  rollback, and credential-placement procedures.
- `DOMAIN_SETUP.md` controls the permanent production origin and physical NFC
  tag gate.
- `PROJECT_PLAN.md`, `REGISTRATION_API.md`,
  `SCAN_PAIRING_AND_PARTICIPANT_STATUS.md`,
  `HEAT_ASSIGNMENT_AND_NOTIFICATIONS.md`,
  `STAFF_UX_AND_DUCK_RECOVERY.md`, and
  `RACE_LIFECYCLE_AND_DUCK_REUSE.md` contain design history. They are not proof
  that a feature is operational when code or `WORKFLOWS.md` says otherwise.

## UPDATE RULES

- Update `WORKFLOWS.md` in the same change as user-visible behavior,
  authorization, lifecycle, failure recovery, or intentionally deferred scope.
- Update `INFRASTRUCTURE.md` with every binding, migration-order, workflow,
  secret/variable, platform, smoke-test, release, or rollback change.
- Clearly label implemented behavior, manual operator steps, deferred behavior,
  and known limitations.
- Document exact current role boundaries; never describe hidden UI as an
  authorization control.
- Do not include credentials, participant examples based on real data, private
  URLs, tokens, account recovery details, or raw provider errors.
- Keep commands copy-safe and identify destructive or production-affecting
  commands immediately before they appear.
- When an old design becomes implemented, reconcile the canonical workflow;
  do not silently leave contradictory claims in multiple documents.
