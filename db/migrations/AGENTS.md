# D1 MIGRATION KNOWLEDGE

## RULES

- Migrations are append-only and ordered by four-digit prefix. Never change or
  renumber a migration that production has recorded.
- Add the next migration for every schema, index, trigger, or data-backfill
  change. Fix forward rather than attempting a down migration.
- Release automation applies D1 migrations before deploying the new Worker, so
  every migration must work with both the old Worker and the new Worker.
- Preserve foreign keys, `CHECK` constraints, partial unique indexes, and
  triggers that enforce current assignments, immutable rosters, final-admin
  safety, and purge read-only behavior.
- Backfills must be deterministic, preserve shipped authorization/data
  semantics, and avoid inventing historical audit facts.
- D1/SQLite batches are authoritative for multi-row domain changes. Do not rely
  only on application preflight checks.

## CURRENT SEQUENCE

- `0001`-`0005`: staff identity, registration/race core, assignments, heat/status,
  browser collections, staff grants.
- `0006`-`0009`: participant notes, inventory history, event revisions/defaults,
  heat/result corrections and constraints.
- `0010`-`0012`: staff lifecycle, support/returns/purge claims, composable staff
  role assignments.
- `0013`: browser-collection link source (`added_via`).

`0013` adds `browser_collection_registrations.added_via` with a
`'REGISTRATION'` default so links written by the previously deployed Worker keep
today's projection. `'FOLLOWED'` marks a link added from the public name search;
that source must never be projected with a staff lookup code or an unmasked
name.

`0012` intentionally grants no operational roles to pre-existing regular staff.
The release preflight blocks that migration when an unmapped non-administrator
exists, requiring an explicit reviewed role mapping rather than broad access or
silent lockout.

## REQUIRED VERIFICATION

```sh
npm test
npm run db:migrate:local
```

- Update exact migration-name assertions in `src/migrations.test.mjs` and
  `src/race-workflow.integration.test.mjs` when adding a migration.
- Test fresh application and any populated upgrade/backfill behavior.
- End SQLite scenarios with `PRAGMA foreign_key_check`.
- Validate constraints with both accepted and rejected rows, including
  concurrency/revision behavior when relevant.
- Local Wrangler state may already contain migrations; use an isolated local
  persistence directory when a genuinely fresh run is required.
