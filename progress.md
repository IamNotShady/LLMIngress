# LLMIngress V1 Release State

Updated: 2026-07-14
Branch: `dev`
Version: V1 pre-release baseline with Docker lifecycle

## Release domains

1. Core Platform Security
2. Provider Model Management
3. Virtual Model Routing
4. Gateway Protocol Execution
5. Agent Access and Limits
6. Usage and Activity
7. Worker Model Operations
8. Console Core
9. Release Guards

## Baseline

- Console pages: Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, Playground.
- Public protocols: Chat Completions, Responses, Messages, Embeddings, and model discovery.
- Worker jobs: `model_refresh`, `provider_connection_probe`, `price_sync`.
- Database: PostgreSQL 18.4 Alpine with `0001_core_baseline.sql`, 23 product tables plus migration history (24 total).
- Deployment: one release-bound command manages a single application image, separate PostgreSQL, verified upgrade snapshots, and automatic rollback.
- Historical removal/refactor tests are consolidated into current domain suites and release guards.

## Latest verification

- `pnpm run verify`: 18 suites / 323 tests; lint, typecheck, and build passed.
- Coverage: 49.20% statements, 41.76% branches, 53.22% functions, 49.29% lines.
- Docker lifecycle: 4 focused unit and 3 real E2E tests passed across install, no-op, repair, upgrade, rollback, retention, conflict/downgrade rejection, retry, and interruption recovery.
- Feature regression: all 9 standard domains passed; 18 unit and 17 E2E entrypoints, 0 legacy.
- Compose: one application image, PostgreSQL 18.4, migration, 24 tables, Gateway readiness, Console HTTP, and Worker passed; application containers stopped after smoke.

## Blockers

- None.
