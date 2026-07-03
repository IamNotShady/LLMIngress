# LLMIngress Progress

## Current State

- Date: 2026-07-03
- Branch: `worktree-console-dark-restyle`
- Base: `dev` at `d28e21ac`
- Status: Console dark restyle implemented and verified.

## Compression Summary

- `feature_list.json` now tracks 5 V1 milestone features instead of the previous 127 feature-by-feature delivery records.
- `tests/features` and `tests/e2e` now keep only the 5 V1 milestone unit/E2E specs.
- `packages/db/migrations` now ships one destructive pre-release baseline migration: `0001_v1_baseline.sql`.
- Historical session notes, old feature tests, and old migration steps are intentionally left to git history.

## 2026-07-03 Console Dark Restyle

- Implemented `console-dark-restyle`: Console now serves a dark-only violet skin with Geist / Geist Mono, compact 30px primary buttons, no theme toggle, fixed chart tokens, and responsive no-overflow checks at 1280px and 390px.
- Moved `v1-console` from theme-toggle behavior to the dark-only shell contract.
- Updated release guard expectations for 6 passing feature contracts.
- Follow-up layout polish: Overview `Recent requests` now spans the content width, with `Gateway status` stacked below it instead of beside it.
- Follow-up runtime polish: removed the Overview `Gateway status` detail card and moved gateway URL, config version, uptime, and provider health counts into the sidebar runtime card with green/red count dots.
- Verification completed:
  - `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`
  - `pnpm --filter @llmingress/console run typecheck`
  - `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts tests/e2e/v1-console.e2e.spec.ts --workers=1`
  - `pnpm run verify`
  - `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify:features`
  - Temporary Playwright route scan: 10 Console routes checked at 1280px and 390px with no horizontal overflow.
  - Follow-up layout check: `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts`, `pnpm run verify`, and `pnpm run verify:features` passed; browser measured `Recent requests` at 1096.98px wide with `Gateway status` below it at 1407px viewport.
  - Follow-up runtime-card check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts`, `pnpm run verify`, and `pnpm run verify:features` passed; browser confirmed no Overview gateway card, sidebar URL `127.0.0.1:4000`, uptime, and provider counts `12` green / `3` red with no visible healthy/unhealthy words.

## Required Verification

Use the local PostgreSQL test database:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run db:migrate:check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify:features
```

## Operational Note

Existing local/dev databases created before this compression should be dropped and recreated. The single baseline is a pre-release reset path, not an upgrade path for already-used installations.
