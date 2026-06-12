# Session Progress Log

## Current State

**Last Updated:** 2026-06-12 22:03 AWST
**Active Feature:** None (feat-003 through feat-006 completed)

## Status

### What's Done

- [x] Built the minimum monorepo scaffold for Gateway, Console, Worker, and shared packages (feat-001).
- [x] Split the MVP scope from `docs/PLAN.md` into 54 independently developable and testable features.
- [x] Standardized feature tracker schema on `description` / `status` with strict verification contracts.
- [x] **feat-002 — Unit and E2E Test Harness (passing)**:
  - Added `tests/features/` (unit) and `tests/e2e/` (E2E) directories.
  - Added `test:e2e` script backed by Playwright (`playwright.config.ts`, testDir `tests/e2e`, testMatch `**/*.e2e.spec.ts`).
  - Vitest stays scoped to `tests/**/*.test.ts` with `passWithNoTests: false`, so a missing feature test fails instead of silently passing.
  - TDD: unit test and E2E spec were written first and observed failing before implementation.
- [x] Split CI migration validation into a separate future feature:
  - `feat-005` remains the early base CI gate.
  - New `feat-055` owns adding migration validation to CI after `feat-007` exists.
  - `feat-054` now waits for `feat-055` before local deployment smoke.
- [x] Re-audited feature dependency graph after CI migration split:
  - `feat-006` now depends on `feat-002`, so `feat-010` reaches the E2E harness transitively.
  - Added semantic dependencies for budget reservations, model soft delete routing, runtime reload status, and Playground usage recording.
- [x] Re-audited `feat-031` price-system dependencies:
  - `feat-031` now depends on `feat-014` for `unknown_price` classification.
  - `feat-031` now depends on `feat-015` for manual price override before enabling cost budgets.
- [x] Clarified `feat-003` test PostgreSQL configuration contract:
  - `feat-003` now explicitly reads `TEST_DATABASE_URL`.
  - Its verification command checks the env var before running unit and E2E tests.
- [x] **feat-003 — Test PostgreSQL Fixture (passing)**:
  - Added `packages/db` test fixture helpers for `TEST_DATABASE_URL`, isolated database creation, fixture migration, reset, and cleanup.
  - Added feat-003 unit and E2E tests; both were observed failing before implementation and passing after implementation.
  - Verified against Docker Postgres on `127.0.0.1:55432`.
- [x] **feat-004 — Fake Provider Test Server (passing)**:
  - Added a reusable fake provider test server with deterministic JSON, streaming, error, timeout, and first-byte-failure modes.
  - Request capture records method, path, mode, headers, raw body, and parsed JSON body.
  - Added feat-004 unit and E2E tests; both were observed failing before implementation and passing after implementation.
- [x] **feat-005 — CI Verification Pipeline (passing)**:
  - Added GitHub Actions workflow for install, lint, typecheck, unit tests, E2E smoke, and build.
  - Added CI PostgreSQL service and `TEST_DATABASE_URL`, so database-backed E2E tests execute in CI instead of silently skipping.
  - Added pnpm setup/cache in the workflow.
  - Kept migration validation out of base CI; `feat-055` still owns that later.
- [x] **feat-006 — Bootstrap Runtime Configuration (passing)**:
  - Added `packages/config` bootstrap runtime loader for environment and JSON bootstrap config files.
  - Covers gateway/console ports, worker heartbeat, PostgreSQL `DATABASE_URL`, and inline/file master key sources.
  - Invalid ports, database URLs, and missing master key sources fail with explicit errors.
  - Wired the loader into Gateway, Worker, and Console startup paths.
  - Tightened integer parsing so values like `4101abc` fail instead of being truncated.

### What's In Progress

- [ ] No feature is currently active.

### What's Next

1. `feat-007` — PostgreSQL Connection and Migration Runner.
2. `feat-008` — Core Configuration Schema.
3. `feat-009` — Runtime Records and Jobs Schema.
4. `feat-055` — CI Migration Validation after `feat-007` produces the migration check command.

## Blockers / Risks

- [ ] Playwright browsers are NOT installed (`pnpm exec playwright install chromium` not yet run). feat-002's E2E spec needs no browser, but Console-page E2E features (feat-013+) will need it.
- [ ] Real GitHub Actions evidence for `feat-005` still requires pushing the current commit and observing the workflow run on GitHub.
- [ ] Console page E2E features (feat-013+) will need Playwright browser installation before browser-driven tests are added.

## Decisions Made

- **`test:e2e` is Playwright, not a second vitest config**:
  - Context: feature verification commands use `--grep '<scenario>'`, which is Playwright CLI syntax (vitest uses `-t`); Console-page features need a real browser later.
  - Decision: `"test:e2e": "playwright test"` with `playwright.config.ts` scoped to `tests/e2e/**/*.e2e.spec.ts`.
- **File naming keeps runners disjoint**:
  - Unit: `tests/features/feat-XXX-<slug>.unit.test.ts` (matches vitest `tests/**/*.test.ts`).
  - E2E: `tests/e2e/feat-XXX-<slug>.e2e.spec.ts` (matches only Playwright's testMatch).
- **Feature list is the MVP source of execution truth** (unchanged from previous session).
- **Missing tests must fail**: `passWithNoTests: false` retained; now also asserted by feat-002's own tests.
- **Gateway auth behavior is owned by `feat-034`** (unchanged from previous session).
- **CI migration validation is not part of base CI**:
  - Context: base CI should land early, but migration validation needs the PostgreSQL fixture and migration runner.
  - Decision: `feat-005` covers install/lint/typecheck/unit/E2E/build; `feat-055` later wires migration validation into CI.
- **Feature dependencies must cover their verification harness and referenced runtime data**:
  - Context: `feat-006` and `feat-010` verification commands run `pnpm test:e2e`, but the dependency graph previously allowed them before `feat-002`.
  - Decision: `feat-006` now depends on `feat-002`; semantic dependencies were added where descriptions or verification depend on earlier schema/runtime outputs.
- **Cost budget configuration depends on the price system**:
  - Context: `feat-031` blocks cost budgets for unknown-price models until a manual price exists.
  - Decision: `feat-031` depends on both `feat-014` and `feat-015`, so its E2E setup can classify unknown prices and exercise manual price override.
- **Test PostgreSQL fixture uses test-specific config, not runtime bootstrap config**:
  - Context: `feat-003` is earlier than `feat-006`, so it cannot depend on the runtime bootstrap configuration feature.
  - Decision: `feat-003` reads `TEST_DATABASE_URL` directly as a test-only Postgres connection string.

## Files Modified This Session

- `package.json` - Added `test:e2e` script and `@playwright/test` dev dependency.
- `playwright.config.ts` - New Playwright config scoped to `tests/e2e`.
- `tests/features/feat-002-test-harness.unit.test.ts` - New unit test for harness separation rules.
- `tests/e2e/feat-002-test-harness.e2e.spec.ts` - New E2E spec proving missing tests fail and commands are separate.
- `feature_list.json` - feat-002 marked `passing` with evidence.
- `feature_list.json` - Split migration validation from `feat-005` into new `feat-055`.
- `feature_list.json` - Added dependency closure fixes for `feat-006`, `feat-025`, `feat-042`, `feat-048`, and `feat-049`.
- `feature_list.json` - Added price-system dependencies to `feat-031`.
- `feature_list.json` - Clarified that `feat-003` reads `TEST_DATABASE_URL`.
- `packages/db/src/index.ts` - Added Test PostgreSQL fixture helpers.
- `tests/features/feat-003-postgres-fixture.unit.test.ts` - New unit contract tests for test database URL handling.
- `tests/e2e/feat-003-postgres-fixture.e2e.spec.ts` - New E2E fixture smoke test against real PostgreSQL.
- `packages/db/package.json` - Added `pg` dependency.
- `tests/support/fake-provider.ts` - New reusable fake provider server for feature tests.
- `tests/features/feat-004-fake-provider.unit.test.ts` - New unit contract tests for fake provider behavior.
- `tests/e2e/feat-004-fake-provider.e2e.spec.ts` - New E2E fake provider mode test.
- `.github/workflows/ci.yml` - New base CI workflow.
- `tests/features/feat-005-ci-pipeline.unit.test.ts` - New CI workflow unit checks.
- `tests/e2e/feat-005-ci-pipeline.e2e.spec.ts` - New CI workflow E2E smoke check.
- `.github/workflows/ci.yml` - Added PostgreSQL service, `TEST_DATABASE_URL`, and pnpm cache setup.
- `apps/gateway/src/main.ts` - Startup now loads bootstrap runtime config before listening.
- `apps/gateway/package.json` - Added workspace dependency on `@llmingress/config`.
- `apps/worker/src/main.ts` - Startup now loads bootstrap runtime config before heartbeat scheduling.
- `apps/worker/package.json` - Added workspace dependency on `@llmingress/config`.
- `apps/console/src/main.ts` - New Console startup wrapper that validates bootstrap runtime config before launching Next.
- `apps/console/package.json` - Routed dev/start scripts through the Console startup wrapper and added `@llmingress/config`.
- `packages/config/package.json` - Export now resolves to source for pre-build workspace consumers.
- `tests/e2e/feat-003-postgres-fixture.e2e.spec.ts` - Added opt-in skip when `TEST_DATABASE_URL` is absent.
- `packages/config/src/index.ts` - Added bootstrap runtime config loader.
- `tests/features/feat-006-bootstrap-config.unit.test.ts` - New config unit tests.
- `tests/e2e/feat-006-bootstrap-config.e2e.spec.ts` - New config E2E smoke test.
- `pnpm-lock.yaml` - Lockfile updates for `@playwright/test`, `pg`, `@types/pg`, and workspace app dependencies.

## Evidence of Completion

- [x] feat-002 verification chain passed end to end on 2026-06-12:
  - `! pnpm exec vitest run tests/features/__missing__.unit.test.ts` (missing test exits nonzero).
  - `! rg -n "passWithNoTests.*true" vitest.config.ts package.json` (no silent-pass config).
  - `test -d tests/features && test -d tests/e2e`.
  - `pnpm exec vitest run tests/features/feat-002-test-harness.unit.test.ts` → 4 passed.
  - `pnpm test:e2e tests/e2e/feat-002-test-harness.e2e.spec.ts --grep 'missing tests fail and unit e2e commands are separate'` → 1 passed.
- [x] Full gate clean: `pnpm run verify` (lint → typecheck → test → build) passed after the change.
- [x] Dependency graph check after adding `feat-055`: `55 features`, no missing dependencies, no self-dependencies, no cycles.
- [x] Full gate clean after split: `pnpm run verify` passed.
- [x] E2E smoke after split: `pnpm test:e2e tests/e2e/feat-002-test-harness.e2e.spec.ts --grep 'missing tests fail and unit e2e commands are separate'` passed.
- [x] Baseline before dependency audit: `pnpm run verify` passed.
- [x] Dependency graph check after audit: `55 features`, no missing deps, no self-deps, no cycles, no E2E verification outside `feat-002` closure.
- [x] Full gate clean after dependency audit: `pnpm run verify` passed.
- [x] E2E smoke after dependency audit: `pnpm test:e2e tests/e2e/feat-002-test-harness.e2e.spec.ts --grep 'missing tests fail and unit e2e commands are separate'` passed.
- [x] Baseline before `feat-031` dependency audit: `pnpm run verify` passed.
- [x] Dependency graph check after `feat-031` audit: `feat-031` directly depends on `feat-014` and `feat-015`; `55 features`, no missing deps, no self-deps, no cycles, no E2E verification outside `feat-002` closure.
- [x] Full gate clean after `feat-031` dependency audit: `pnpm run verify` passed.
- [x] E2E smoke after `feat-031` dependency audit: `pnpm test:e2e tests/e2e/feat-002-test-harness.e2e.spec.ts --grep 'missing tests fail and unit e2e commands are separate'` passed.
- [x] Baseline before `feat-003` config contract audit: `pnpm run verify` passed.
- [x] Dependency graph check after `feat-003` config contract audit: `feat-003` description and verification mention `TEST_DATABASE_URL`; `55 features`, no missing deps, no self-deps, no cycles, no E2E verification outside `feat-002` closure.
- [x] Full gate clean after `feat-003` config contract audit: `pnpm run verify` passed.
- [x] E2E smoke after `feat-003` config contract audit: `pnpm test:e2e tests/e2e/feat-002-test-harness.e2e.spec.ts --grep 'missing tests fail and unit e2e commands are separate'` passed.
- [x] feat-003 red phase observed:
  - `pnpm exec vitest run tests/features/feat-003-postgres-fixture.unit.test.ts` failed because fixture exports were missing.
  - `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e tests/e2e/feat-003-postgres-fixture.e2e.spec.ts --grep 'postgres fixture migrates resets and prevents leaked rows'` failed because fixture export was missing.
- [x] feat-003 verification passed:
  - `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' bash -lc 'test -n "$TEST_DATABASE_URL"' && pnpm exec vitest run tests/features/feat-003-postgres-fixture.unit.test.ts && TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e tests/e2e/feat-003-postgres-fixture.e2e.spec.ts --grep 'postgres fixture migrates resets and prevents leaked rows'`.
  - `pnpm run verify` passed after feat-003 implementation.
- [x] feat-004 red phase observed:
  - `pnpm exec vitest run tests/features/feat-004-fake-provider.unit.test.ts` failed because `tests/support/fake-provider` was missing.
  - `pnpm test:e2e tests/e2e/feat-004-fake-provider.e2e.spec.ts --grep 'fake provider returns fixed body stream error timeout and first byte failure'` failed because `tests/support/fake-provider` was missing.
- [x] feat-004 verification passed:
  - `pnpm exec vitest run tests/features/feat-004-fake-provider.unit.test.ts` → 2 passed.
  - `pnpm test:e2e tests/e2e/feat-004-fake-provider.e2e.spec.ts --grep 'fake provider returns fixed body stream error timeout and first byte failure'` → 1 passed.
  - `pnpm run verify` passed after feat-004 implementation.
- [x] feat-005 red phase observed:
  - `pnpm exec vitest run tests/features/feat-005-ci-pipeline.unit.test.ts` failed because `.github/workflows/ci.yml` was missing and the DB E2E was not opt-in.
  - `pnpm test:e2e tests/e2e/feat-005-ci-pipeline.e2e.spec.ts --grep 'ci workflow contains install lint typecheck unit e2e and build gates'` failed because `.github/workflows/ci.yml` was missing.
- [x] feat-005 verification passed:
  - `pnpm exec vitest run tests/features/feat-005-ci-pipeline.unit.test.ts` → 3 passed.
  - `pnpm test:e2e tests/e2e/feat-005-ci-pipeline.e2e.spec.ts --grep 'ci workflow contains install lint typecheck unit e2e and build gates'` → 1 passed.
  - Full feat-005 verification passed: workflow checks, `pnpm install --frozen-lockfile`, `pnpm run lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm build`.
- [x] feat-005 review fix verification passed:
  - Red phase: updated workflow unit test failed because CI lacked `services: postgres` and `TEST_DATABASE_URL`.
  - `pnpm exec vitest run tests/features/feat-006-bootstrap-config.unit.test.ts tests/features/feat-005-ci-pipeline.unit.test.ts` → 9 passed.
  - `pnpm test:e2e tests/e2e/feat-005-ci-pipeline.e2e.spec.ts --grep 'ci workflow contains install lint typecheck unit e2e and build gates'` → 1 passed.
  - `pnpm install --frozen-lockfile` passed.
- [x] feat-006 red phase observed:
  - `pnpm exec vitest run tests/features/feat-006-bootstrap-config.unit.test.ts` failed because `loadBootstrapRuntimeConfig` was missing.
  - `pnpm test:e2e tests/e2e/feat-006-bootstrap-config.e2e.spec.ts --grep 'env and bootstrap config load ports database url master key and reject invalid config'` failed because `loadBootstrapRuntimeConfig` was missing.
- [x] feat-006 verification passed:
  - `pnpm exec vitest run tests/features/feat-006-bootstrap-config.unit.test.ts` → 3 passed.
  - `pnpm test:e2e tests/e2e/feat-006-bootstrap-config.e2e.spec.ts --grep 'env and bootstrap config load ports database url master key and reject invalid config'` → 1 passed.
- [x] feat-006 review fix verification passed:
  - Red phase: updated tests failed because trailing-garbage integers were accepted and Gateway startup timed out instead of rejecting invalid bootstrap config.
  - `pnpm exec vitest run tests/features/feat-006-bootstrap-config.unit.test.ts tests/features/feat-005-ci-pipeline.unit.test.ts` → 9 passed.
  - `pnpm test:e2e tests/e2e/feat-006-bootstrap-config.e2e.spec.ts --grep 'app startup entries reject invalid bootstrap config before serving'` → 1 passed.
- [x] Final full gate after feat-003 through feat-006: `pnpm run verify` passed.
- [x] Final E2E smoke after feat-003 through feat-006: `pnpm test:e2e` passed with 4 passed and 1 skipped (PostgreSQL fixture remains opt-in without `TEST_DATABASE_URL`).
- [x] Review fix final gate: `pnpm run verify` passed.
- [x] Review fix database E2E gate: `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e` passed with 6/6 tests executed.

## Notes for Next Session

`pnpm test:e2e` now exists, so later feature verification commands can run their E2E half. Next features should follow the established TDD order: write `feat-XXX-<slug>.unit.test.ts` and `feat-XXX-<slug>.e2e.spec.ts` first, watch them fail, then implement. Before starting Console-page E2E work, run `pnpm exec playwright install chromium`.
