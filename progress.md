# Session Progress Log

## Current State

**Last Updated:** 2026-06-12 19:02 AWST
**Active Feature:** None (feat-002 completed)

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

### What's In Progress

- [ ] No feature is currently active.

### What's Next

1. `feat-003` — Test PostgreSQL Fixture (isolated DB per test, migrate, reset, no leaked rows).
2. `feat-004` — Fake Provider Test Server (deterministic modes incl. streaming/timeout/first-byte failure).
3. `feat-005` — CI Verification Pipeline (now unblocked since `pnpm test:e2e` exists).
4. `feat-055` — CI Migration Validation after `feat-007` produces the migration check command.

## Blockers / Risks

- [ ] Playwright browsers are NOT installed (`pnpm exec playwright install chromium` not yet run). feat-002's E2E spec needs no browser, but Console-page E2E features (feat-013+) will need it.
- [ ] PostgreSQL fixture not implemented; database-backed feature work must wait for `feat-003`.
- [ ] `apps/console/next-env.d.ts` is now gitignored (generated, rewritten by `next dev`/`next build`). It imports types from `.next/`, so Console `typecheck` implicitly requires a prior dev/build. feat-005 CI must run `next typegen` (or a build) before typecheck on a clean checkout.

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

## Files Modified This Session

- `package.json` - Added `test:e2e` script and `@playwright/test` dev dependency.
- `playwright.config.ts` - New Playwright config scoped to `tests/e2e`.
- `tests/features/feat-002-test-harness.unit.test.ts` - New unit test for harness separation rules.
- `tests/e2e/feat-002-test-harness.e2e.spec.ts` - New E2E spec proving missing tests fail and commands are separate.
- `feature_list.json` - feat-002 marked `passing` with evidence.
- `feature_list.json` - Split migration validation from `feat-005` into new `feat-055`.
- `feature_list.json` - Added dependency closure fixes for `feat-006`, `feat-025`, `feat-042`, `feat-048`, and `feat-049`.
- `feature_list.json` - Added price-system dependencies to `feat-031`.
- `pnpm-lock.yaml` - Lockfile update for `@playwright/test`.

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

## Notes for Next Session

`pnpm test:e2e` now exists, so later feature verification commands can run their E2E half. Next features should follow the established TDD order: write `feat-XXX-<slug>.unit.test.ts` and `feat-XXX-<slug>.e2e.spec.ts` first, watch them fail, then implement. Before starting Console-page E2E work, run `pnpm exec playwright install chromium`.
