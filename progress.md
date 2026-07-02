# LLMIngress Progress

## Current State

- Date: 2026-07-02
- Branch: `codex/ponytail-v1-history-compression`
- Base: `dev` at `dfe72244 fix: restore console polish box shadow helper`
- Status: V1 pre-release history compressed into milestone artifacts.

## Compression Summary

- `feature_list.json` now tracks 5 V1 milestone features instead of the previous 127 feature-by-feature delivery records.
- `tests/features` and `tests/e2e` now keep only the 5 V1 milestone unit/E2E specs.
- `packages/db/migrations` now ships one destructive pre-release baseline migration: `0001_v1_baseline.sql`.
- Historical session notes, old feature tests, and old migration steps are intentionally left to git history.

## Required Verification

Use the local PostgreSQL test database:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run db:migrate:check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify:features
```

## Operational Note

Existing local/dev databases created before this compression should be dropped and recreated. The single baseline is a pre-release reset path, not an upgrade path for already-used installations.
