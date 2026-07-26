# RUNTIME AND TEST KNOWLEDGE

## SCOPE

`src` is one flat Worker application. Domain modules intentionally combine HTTP
validation, authorization, D1 SQL, idempotency, audit writes, and response
mapping. Tests are colocated `.test.mjs` files run directly by Node 24.

## ROUTING

`api.ts` composes authenticated handlers in this order:

1. `staff-lifecycle-operations.ts`
2. `event-operations.ts`
3. `participant-operations.ts`
4. `duck-operations.ts`
5. `heat-operations.ts`
6. `support-operations.ts`
7. `staff-api.ts`

Do not reorder casually. Some routes are intentionally excluded by an earlier
module and handled by the fallback, including registration search, return
review, scan-first pairing, single dispositions, and final purge.

## DOMAIN MAP

| Concern | Files |
| --- | --- |
| Worker/pages/assets | `index.ts`, `site.ts`, `client-scripts.ts` |
| Public registration/status | `api.ts`, `registration.ts`, `browser-collection.ts`, `race-status.ts` |
| Public live board/signaling | `race-board.ts`, `live-updates.ts` |
| Cognito/session/access | `auth.ts`, `staff-session.ts`, `staff-access.ts` |
| Staff roles/lifecycle | `authorization.ts`, `staff-lifecycle-operations.ts` |
| Event lifecycle | `event-operations.ts` |
| Participant operations | `participant-operations.ts` |
| Inventory/tags/assignments | `duck-operations.ts`, `staff-api.ts` |
| Heats/results | `heat-operations.ts` |
| Returns/support/purge | `support-operations.ts`, `staff-api.ts` |

## CODING CONVENTIONS

- Use Web Platform APIs and Worker bindings; there is no framework router.
- Bind all external SQL values. Dynamic placeholder lists must come only from
  validated arrays or fixed internal enums.
- Validate content type, body size, object shape, enums, lengths, and revisions
  before database access.
- Use `400` for malformed values, `403` for permissions/origin failures, `409`
  for lifecycle/revision/idempotency conflicts, and `422` for semantic form or
  result errors.
- Significant mutations accept an RFC 4122 v4 command ID. Matching retries
  return `replayed: true`; reuse for different material returns `409`.
- Preflight checks provide useful errors, but guarded SQL and schema constraints
  are authoritative.
- Audit safe identifiers and changed field names, never participant PII or raw
  credentials/tokens.
- An administrator implicitly passes role checks. Regular actors must have
  explicit validated roles; do not add a broad missing-role fallback.
- `RaceUpdates` accepts same-origin WebSockets and broadcasts refresh/version
  signals only. Successful mutations schedule best-effort publication; a
  publication failure must never replace the committed API response.
- Live clients use WebSockets for prompt refresh and polling for recovery. D1
  API responses, not socket order or delivery, decide every displayed state.

## UI RULES

- `site.ts` owns shared CSS and server markup; `client-scripts.ts` exports raw
  browser JavaScript strings served by `index.ts`.
- Escape every dynamic server value with `escapeHtml`.
- Browser scripts create nodes with safe DOM APIs. Do not introduce
  `innerHTML`, `outerHTML`, or `insertAdjacentHTML` for API data.
- Race-day controls use plain language, visible state, large touch targets, and
  one primary action. UI role filtering is convenience only; APIs enforce it.
- Keep participant pages free of contact, staff, inventory-location, and audit
  data even when a private status token is present.

## TESTS

```sh
npm test
node --test src/race-workflow.integration.test.mjs
node --test src/role-authorization.integration.test.mjs
```

- SQL-recording mocks validate query shape, bindings, and denied no-write paths.
- Real `node:sqlite` adapters validate migrated schemas and transactional
  workflows. Keep `PRAGMA foreign_keys = ON` and close each database.
- `race-workflow.integration.test.mjs` must continue to exercise registration,
  duck intake/pairing, every heat transition, final results, returns, and purge
  through real Worker handlers.
- `role-authorization.integration.test.mjs` is the least-privilege matrix.
- `race-board.test.mjs` protects board ordering/privacy/current assignments;
  `live-updates.test.mjs` protects signal/admission/capacity behavior.
- Browser-script tests must parse generated JavaScript and retain unsafe-sink
  assertions.
- New test files must remain directly under `src`; `src/*.test.mjs` is not
  recursive.
