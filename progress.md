# LLMIngress V1 Release State

Updated: 2026-07-14
Branch: `dev`
Version: V1 pre-release baseline

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
- Database: `0001_core_baseline.sql`, 23 product tables plus migration history (24 total).
- Historical removal/refactor tests are consolidated into current domain suites and release guards.

## Latest verification

- `db:migrate:check`: applied 1 migration; rerun skipped 1.
- `pnpm run verify`: 17 suites / 318 tests; build passed.
- Coverage: 49.08% statements, 41.73% branches, 53.07% functions, 49.19% lines.
- Parallel E2E: 85/85 passed with `--workers=50%`.
- Feature regression: 9 standard domains, 0 legacy; 17 unit and 16 E2E entrypoints.
- Isolated Compose: build, migration, Gateway readiness, Console HTTP, and cleanup passed.

## Blockers

- None.
