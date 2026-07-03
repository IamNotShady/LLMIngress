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
- Follow-up shell cleanup: removed the duplicate topbar gateway status pill, removed the non-essential Help link, removed the sidebar `Signed in as admin` row, and enlarged the sidebar runtime card.
- Follow-up runtime-card height tweak: raised the sidebar runtime card minimum height from `7rem` to `7.75rem`.
- Follow-up runtime-card spacing tweak: raised the sidebar runtime card minimum height to `8.5rem` and loosened the runtime summary line spacing.
- Follow-up Agents filter polish: renamed the Agents filter submit button from `Apply filters` to `Query` and aligned its height with the search input.
- Follow-up Agents button icon cleanup: removed the filter icon from `Query` and the add icon from `Create Agent`.
- Follow-up Agents detail polish: removed the right-side selected agent card and moved read-only agent details into a dialog opened from Agent list rows, letting the Agents KPIs, filters, and list span the full content width.
- Follow-up Agents detail dialog layout: tightened the read-only dialog to the existing 42rem dialog width and grouped fields into aligned cards.
- Follow-up Agents detail field layout: changed the read-only dialog summary fields to full-width label/value rows.
- Follow-up Provider cleanup: removed provider `default_priority` from Provider detail, Console provider types/queries, Gateway credential ordering, and the baseline schema.
- Follow-up Provider list selection: moved Provider list/detail/model-library selection into a client island so row clicks update the selected provider locally without writing `selected` to the URL or rerunning the page route.
- Follow-up Provider inline detail: removed the right-side Provider detail card and moved the selected provider's stats plus API key/OAuth/local connection list into an expanded row inside Provider list.
- Follow-up Provider inline detail compacting: removed the inline Provider details title, refresh/status summary, available model count, and last connected fields so the expanded row starts directly at the credential list with reduced vertical padding.
- Follow-up Provider refresh action: moved the model refresh affordance into each Provider list row's Actions area and kept it backed by the existing `/api/provider-model-refresh` form endpoint.
- Follow-up Provider row toggle: clicking an already-expanded Provider row now collapses its inline credential detail instead of keeping it open.
- Verification completed:
  - `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`
  - `pnpm --filter @llmingress/console run typecheck`
  - `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts tests/e2e/v1-console.e2e.spec.ts --workers=1`
  - `pnpm run verify`
  - `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify:features`
  - Temporary Playwright route scan: 10 Console routes checked at 1280px and 390px with no horizontal overflow.
  - Follow-up layout check: `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts`, `pnpm run verify`, and `pnpm run verify:features` passed; browser measured `Recent requests` at 1096.98px wide with `Gateway status` below it at 1407px viewport.
  - Follow-up runtime-card check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts`, `pnpm run verify`, and `pnpm run verify:features` passed; browser confirmed no Overview gateway card, sidebar URL `127.0.0.1:4000`, uptime, and provider counts `12` green / `3` red with no visible healthy/unhealthy words.
  - Follow-up shell cleanup check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts`, `pnpm --filter @llmingress/console run typecheck`, `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify`, and `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify:features` passed; browser confirmed no `.topbar-status`, `.topbar-link`, `.sidebar-account`, `Help`, or `Signed in as admin`, runtime card height `117.98px`, no horizontal overflow, and no console warnings/errors.
  - Follow-up runtime-card height check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts` passed; browser confirmed runtime card height `124px`, no horizontal overflow, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up runtime-card spacing check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts` passed; browser confirmed runtime card height `141.48px`, summary gap `2.88px`, line-height `19.2px`, no horizontal overflow, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Agents filter check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts` passed; browser confirmed `Query` button text, button/search input height `38.80px`, no horizontal overflow, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Agents button icon cleanup check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts` passed; browser confirmed `Query` and `Create Agent` each have only text, no `.flat-icon`/`svg`, centered flex alignment, no horizontal overflow, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Agents detail dialog check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed `.agents-main-column`, `.agents-stat-grid`, `.agents-filter-bar`, and `.agents-list-card` all span `1112px`, no right-side `.agent-detail-card`, clicking an Agent list row opens one read-only `.agent-view-dialog` with no form controls, close removes it, no horizontal overflow, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Agents detail dialog layout check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the dialog width is `672px`, fields render as two equal `288px` columns, label/value left edges align, no form controls, no horizontal overflow, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Agents detail field layout check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the read-only dialog summary uses one field-grid column, four full-width rows with label/value on the same line, no horizontal overflow, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Provider cleanup check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/db run typecheck`, `pnpm --filter @llmingress/console run typecheck`, `pnpm run lint`, `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run db:migrate:check`, `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify`, and `TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify:features` passed; browser confirmed Provider detail no longer shows `Default priority`, with no horizontal overflow and no console warnings/errors.
  - Follow-up Provider list selection check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed clicking `Anthropic111` changes the Provider detail heading locally while URL remains `http://127.0.0.1:3000/providers`, `selected` remains absent, the selected row updates, and there are no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Provider inline detail check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed clicking `MiniMax` opens one `.provider-inline-detail-row` inside Provider list, removes `.provider-detail-card`, keeps the list full-width at `1097px`, keeps URL `http://127.0.0.1:3000/providers` without `selected`, shows API key status details, has no horizontal overflow, no Next.js overlay, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Provider inline detail compacting check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed `MiniMax` opens one inline detail row that starts with API keys, has no Provider details heading, no provider-detail-stats, no Available models/Last connected text, height `154px`, URL unchanged, no horizontal overflow, no Next.js overlay, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Provider refresh action check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed 17 Provider list rows all show a row-level refresh button posting to `/api/provider-model-refresh` with a hidden provider id, `MiniMax` selection still opens the compact API keys detail, no horizontal overflow, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Provider row toggle check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed an expanded Provider row has one inline detail row, clicking the same row collapses to zero inline detail rows and zero expanded buttons, clicking it again restores one inline detail row, with no horizontal overflow and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.

## Required Verification

Use the local PostgreSQL test database:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run db:migrate:check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify:features
```

## Operational Note

Existing local/dev databases created before this compression should be dropped and recreated. The single baseline is a pre-release reset path, not an upgrade path for already-used installations.
