# LLMIngress V1 Release State

Updated: 2026-07-14 · Branch: `dev` · Version: V1 pre-release baseline with Docker lifecycle

## Release domains

Core Platform Security; Provider Model Management; Virtual Model Routing; Gateway Protocol Execution; Agent Access and Limits; Usage and Activity; Worker Model Operations; Console Core; Release Guards.

## Baseline

- Console pages: Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, Playground.
- Public protocols: Chat Completions, Responses, Messages, Embeddings, and model discovery.
- Worker jobs: `model_refresh`, `provider_connection_probe`, `price_sync`.
- Database: PostgreSQL 18.4 Alpine with `0001_core_baseline.sql`, 23 product tables plus migration history (24 total).
- Deployment: one release-bound command manages a single application image, separate PostgreSQL, verified upgrade snapshots, and automatic rollback.
- Historical removal/refactor tests are consolidated into current domain suites and release guards.

## Latest verification

- `pnpm run verify`: 18 suites / 329 tests; lint, typecheck, and build passed.
- Coverage: 49.34% statements, 41.86% branches, 53.30% functions, 49.41% lines.
- Console Core: focused Unit runs passed 104 assertions and 10 real E2E tests passed; Chrome exercised every supported page and visible workflow at 1440px/390px, and two consecutive post-fix rounds found no new issue, overflow, accessibility-contract failure, framework overlay, warning, or error.
- Provider management: 57 focused unit tests and 4 real E2E tests passed, including a custom template Provider display name persisted to PostgreSQL.
- Docker lifecycle: 5 focused unit and 3 real E2E tests passed across custom-port install, Master Key file access, a real fake-Provider Gateway request, no-op, repair, upgrade, rollback, retention, conflict/downgrade rejection, retry, and interruption recovery.
- Feature regression: all 9 standard domains passed; 18 unit and 17 E2E entrypoints, 0 legacy.
- Compose: one application image, PostgreSQL 18.4, migration plus repeat skip, 24 tables, Gateway readiness, Console HTTP, and Worker passed; application containers stopped after smoke.

## Latest changes

- Virtual Model strategy cards now have contained, keyboard-visible hit regions and correct filtered empty states; Playground uses `x-llmingress-request-id` plus bounded detail retries to populate routing metadata after asynchronous recording.
- Activity and Provider Model library now use one accessible shared Pagination component with consistent page/total summaries, query-preserving Previous/Next controls, disabled states, and responsive desktop/mobile alignment.
- Provider API Key Enable, Disable, and Delete refresh immediately or close their dialog; failures use an accessible, dismissible Toast without changing the Actions layout.
- Template Provider creation now trims and persists the submitted Display Name and rejects a blank value with a field error.
- `GATEWAY_PUBLIC_BASE_URL` was removed; Console reads the canonical `GATEWAY_URL`, including installer and Compose custom-port deployments.
- Managed Gateway, Console, and Worker containers receive `MASTER_KEY_FILE=/run/llmingress/master-key`; the secret value remains out of container environment variables and logs.

## Blockers

- None.
