# LLMIngress Progress

## Current State

- Date: 2026-07-10
- Branch: `codex/high-priority-hardening`
- Base: `9a80b4b8`
- Status: High-priority hardening plan restarted from clean HEAD. Features 1-5 are implemented and verified; feature 6 has not started.

## 2026-07-10 High Priority Hardening 5 - Gateway Fallback Health

- Unified JSON and Streaming Provider fallback semantics behind `executeProviderFallbackAttempts`.
- Added shared classification for credential retry versus candidate fallback: 401/402/403/429 try the same candidate's next credential before moving to the next candidate; other 4xx, 5xx, timeout, network, and first-byte failures skip remaining credentials and move to the next candidate.
- Refactored Streaming provider execution so fetch, HTTP error handling, and first-byte read-ahead run through the shared attempt executor; a Streaming candidate only succeeds after the first provider chunk is read.
- Failed candidates now record exactly one Provider-level and one Model-level health decision through the shared executor path; recognized client bad-request/unsupported-parameter failures still fall back but do not pollute health.
- Preserved final Provider error fidelity by keeping last-provider status/body passthrough for exhausted 4xx and safe Gateway errors for network/5xx/redirect cases.
- Added fake-provider `unsupported-parameter` mode plus feature unit coverage for 401 credential retry, 5xx credential skipping with health, recognized 400 fallback without health, and Streaming executor ownership.
- Added real Gateway E2E for JSON unsupported-parameter fallback without health records and Streaming first-byte failure fallback with Provider+Model health records.
- Verification passed: `pnpm exec vitest run tests/features/gateway-fallback-health.unit.test.ts`, `pnpm test:e2e tests/e2e/gateway-fallback-health.e2e.spec.ts`, related Gateway unit/E2E regression, `pnpm run lint`, `pnpm run typecheck`, `pnpm run verify`, pre-mark `pnpm run verify:features` for the existing 43 passing features, and final `pnpm run verify:features` for all 44 passing features.

## 2026-07-10 High Priority Hardening 4 - Provider Authenticated HTTP Safety

- Added a shared Provider credential-bearing HTTP helper that forces `redirect: "manual"` and rejects all 3xx responses as `provider_redirect_rejected` without exposing or following `Location`.
- Routed OpenAI, Anthropic, subscription OAuth, provider model-list, connectivity probe, and Gateway streaming provider requests through the helper when they carry Provider credentials.
- Added Gateway support for the stable `provider_redirect_rejected` error code, mapped to 502 for client responses.
- Changed Anthropic connectivity probes to the official Messages shape: `POST /v1/messages`, `x-api-key`, `anthropic-version: 2023-06-01`, `max_tokens: 1`, and `messages: [{ role: "user", content: "ping" }]`, with no Bearer Authorization.
- Verification passed: `pnpm exec vitest run tests/features/provider-authenticated-http-safety.unit.test.ts`, `pnpm test:e2e tests/e2e/provider-authenticated-http-safety.e2e.spec.ts`, focused provider descriptor/dialect regression, `pnpm run lint:fix`, `pnpm run typecheck`, `pnpm run verify`, pre-mark `pnpm run verify:features` for the existing 42 passing features, and final `pnpm run verify:features` for all 43 passing features.
- Environment note: first `pnpm run verify` attempt failed because local OrbStack/Postgres stopped accepting new connections; after restarting OrbStack and restoring the local Postgres compose service on `127.0.0.1:55432`, the same command passed.

## 2026-07-10 High Priority Hardening 3 - Console Provider Dependency Guard

- Added `0008_provider_dependency_lookup.sql` with a reverse lookup index for `route_policy_candidates(provider_model_id)` and updated migration status guards.
- Added `ProviderDependencyImpact` for affected Provider Models, Route Policies, Virtual Models, Agents, and API key/OAuth/pending/running job counts.
- Provider disable/delete now lock Providers in stable sorted order and reject active Route Policy dependencies with `provider_dependency_conflict`; delete rechecks in the same transaction, blocks running provider jobs, cancels pending provider jobs, soft-deletes Provider/Models, removes key/OAuth/health runtime data, and clears Activity/Fallback key IDs.
- Route Policy create/update locks Providers for candidate Provider Models before writing candidates, preventing dependency TOCTOU races with Provider deletion.
- Gateway activity recording validates `provider_api_key_id` values before writing `request_activity` and `fallback_events`, preserving metadata snapshots while avoiding dangling deleted key UUIDs.
- Provider delete API now returns structured 409 JSON for delete/disable conflicts, and the delete dialog shows real dependencies with links/counts while suppressing the confirm button when blockers exist.
- Verification passed: `pnpm exec vitest run tests/features/console-provider-dependency-guard.unit.test.ts`, `pnpm test:e2e tests/e2e/console-provider-dependency-guard.e2e.spec.ts`, `pnpm run db:migrate:check`, `pnpm run lint:fix`, focused migration guard unit, `pnpm run verify`, pre-mark `pnpm run verify:features` for the existing 41 passing features, and final `pnpm run verify:features` for all 42 passing features.

## 2026-07-10 High Priority Hardening 2 - Console Secure Bootstrap

- Removed public Compose defaults for `MASTER_KEY`, `POSTGRES_PASSWORD`, and `CONSOLE_SETUP_TOKEN`; Compose now fails config resolution when they are absent.
- Host-published Compose ports for Gateway, Console, and Postgres bind `127.0.0.1` by default through independent publish-host variables, while container-internal Gateway/Console listeners remain `0.0.0.0`.
- Added shared Console setup mode handling: loopback direct runs keep password-only setup, configured setup tokens require at least 32 characters, and non-loopback setup without a token renders `Setup locked` and returns 503 on setup POST.
- Setup POST now checks initialized state before token validation, returns 403 for wrong tokens, and returns 409 for already-initialized setup; concurrent admin creation remains race-safe through the insert conflict path.
- Production startup now rejects the old public default `MASTER_KEY=test-master-key-change-me` unless `LLMINGRESS_ALLOW_INSECURE_DEFAULT_MASTER_KEY=true` is explicitly set, in which case Gateway/Console/Worker log a high-priority security warning.
- Updated `.env.example`, README, PRODUCT, and ARCHITECTURE with URL-safe random generation commands, public-origin/setup-token notes, and publish-host behavior.
- Verification passed: `pnpm exec vitest run tests/features/console-secure-bootstrap.unit.test.ts`, `pnpm test:e2e tests/e2e/console-secure-bootstrap.e2e.spec.ts`, focused release guard unit/E2E, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`, `pnpm run verify`, and `pnpm run verify:features`.
- Note: final optimized `verify:features` E2E batch hit the known `v1-gateway-routing` activity-row timing flake; fallback re-ran all 41 passing feature verifications successfully.

## 2026-07-10 High Priority Hardening 1 - Console Request Security Contract

- Added a shared Console Origin guard for all mutating API requests, including setup, login, and logout. `GET`/`HEAD`/`OPTIONS` skip CSRF checks; unsafe methods require an exact `Origin` match against `CONSOLE_PUBLIC_BASE_URL` or the current request origin when no public URL is configured.
- Introduced explicit `ConsoleOperationError` kinds (`validation`, `not_found`, `conflict`) and mapped them to stable 400/404/409 JSON responses while preserving the legacy string `error` field and adding `code`, optional `details`, and `errorId` for unknown 500s.
- Removed constructor-based generic `Error` classification; unexpected exceptions now return `internal_error` and log the original error server-side only.
- Converted Console-facing DB validation/not-found/conflict paths used by guarded API routes to typed operation errors, including provider, route policy, agent, config import, OAuth, key, price, notification, activity, and analytics validation.
- Updated docs and `.env.example` for `CONSOLE_PUBLIC_BASE_URL` and reverse-proxy Origin requirements.
- Verification passed: `pnpm exec vitest run tests/features/console-request-security-contract.unit.test.ts`, `pnpm test:e2e tests/e2e/console-request-security-contract.e2e.spec.ts`, focused Console E2Es, `pnpm run lint`, `pnpm run typecheck`, `pnpm test`, `pnpm run verify`, and `pnpm run verify:features`.
- Note: the final optimized `verify:features` E2E batch hit the known `v1-gateway-routing` activity-row timing flake; the runner fell back to original per-feature verification and all 40 passing features re-verified successfully.

## 2026-07-10 Drop Database Foreign Keys

- Added `0007_drop_foreign_keys.sql`, dropping all 46 foreign key constraints that remained after the current migration chain.
- Updated migration tracking and platform coverage so the migrated public schema must have zero `pg_constraint` foreign keys.
- Replaced behavior that previously depended on FK cascade/set-null:
  - retention cleanup now explicitly removes expired request usage, cost, fallback, and webhook rows and clears runtime error request links;
  - Provider API key deletion now explicitly clears historical `request_activity` and `fallback_events` key references before deleting keys.
- Updated architecture docs to state that schema integrity is now enforced by application dependency checks, soft deletes, and explicit cleanup rather than database foreign keys.
- Applied `0007` to the local `127.0.0.1:55432/postgres` development database; migration status is up to date and `pg_constraint` reports `0` public-schema foreign keys.
- Verification passed: `pnpm run db:migrate:check`, focused v1-platform unit/E2E, focused v1-worker-ops unit/E2E, `pnpm run lint`, `pnpm run typecheck`, `pnpm run verify`, and `pnpm run verify:features` with all 39 passing features re-verified.

## 2026-07-05 Gateway Agent Limits Single-Read Follow-up

- Added one shared Gateway enabled-limits reader for `agent_limits`; JSON and streaming request paths now read enabled Agent limits once and pass the same snapshot to rate-limit and budget execution.
- Kept rate-limit window updates and budget reservation/finalization in their existing synchronous transactions; only the duplicated `agent_limits` lookup moved.
- Added structural fitness coverage that keeps `from agent_limits` out of the separate rate-limit and budget executors.
- Verification passed: `pnpm exec vitest run tests/features/gateway-cohesion-refactor.unit.test.ts`, focused settlement/error-fidelity unit tests, DB typecheck, Gateway typecheck, `pnpm run lint`, `pnpm run verify`, and `pnpm run verify:features` with all 18 passing features re-verified.

## 2026-07-05 Gateway Observability Writes Async Follow-up

- Made provider trace export, fallback attempt event inserts, provider API key `last_used_at` updates, and streaming runtime error inserts best-effort in-process background tasks.
- Kept budget reservation/finalization/release, rate-limit/concurrency control, provider fetch, stream first-byte read-ahead, `createActivity`, and stream budget settlement on the synchronous control path.
- Added unit coverage for blocked fallback event writes, fallback continuation after blocked failure recording, nonblocking stream runtime error propagation, and static fitness preventing awaited observability writes from returning to the Gateway request path.
- Extended the Gateway resilience E2E with slow OTEL, slow `fallback_events`, and slow `provider_api_keys` triggers for both non-streaming response latency and streaming first-chunk latency.
- Verification passed: `pnpm exec vitest run tests/features/gateway-recording-resilience.unit.test.ts`, `pnpm test:e2e tests/e2e/gateway-recording-resilience.e2e.spec.ts`, `pnpm --filter @llmingress/db typecheck`, `pnpm --filter @llmingress/gateway typecheck`, `pnpm run verify`, and `pnpm run verify:features` with all 18 passing features re-verified.

## 2026-07-05 Gateway Activity Recording Async Follow-up

- Kept `createActivity` synchronous, then scheduled JSON `completeActivity`, successful JSON usage/cost recording, and trace recording as best-effort background tasks with shared error logging by `requestId` and `activityId` where available.
- Kept streaming budget settlement awaited before EOF, then scheduled successful stream usage/cost recording and Activity completion in the background; streaming non-ok Activity completion is also scheduled without blocking the error response.
- Added resilience tests for blocked background completion, rejected usage/trace writes, streaming non-ok response latency, and successful stream EOF latency; added a real Gateway E2E with a 2s `request_activity` update trigger proving non-streaming HTTP 200 returns before Activity completion finishes.
- Verification passed: `pnpm exec vitest run tests/features/gateway-recording-resilience.unit.test.ts`, `pnpm test:e2e tests/e2e/gateway-recording-resilience.e2e.spec.ts`, `pnpm --filter @llmingress/gateway typecheck`, `pnpm run verify`, and `pnpm run verify:features` with all 18 passing features re-verified.

## 2026-07-05 Gateway Cohesion Follow-up

- Fixed the S7 rename regression where ActivitySection still sent `agentApiKeyId` to `countConsoleActivities` / `listConsoleActivities`; the Console Activity agent filter now passes `agentId` and keeps the selected value from the same field.
- Added E2E coverage to `console-ui-audit-confirmed-fixes.e2e.spec.ts`: `/activity?agentId=...` keeps only that agent's request rows visible.
- Expanded `gateway-cohesion-refactor.unit.test.ts` agent-name fitness coverage to scan `apps/console/src` and `apps/worker/src` in addition to `packages/db/src` and `apps/gateway/src`; the only allowed `agentApiKeyId` occurrence is the existing `agent-limits` HTTP form compatibility alias.
- Verification passed: focused fitness test, focused Console audit E2E, Console typecheck, `pnpm run verify`, and `pnpm run verify:features`.

## 2026-07-05 Gateway Cohesion Refactor

- Implemented `gateway-cohesion-refactor` as seven scoped commits:
  - `951dd98c` extracted provider credential and OAuth loading from the chat endpoint module.
  - `db25a1c6` unified Gateway endpoint error codes behind one `GatewayErrorCode` union.
  - `93307302` split streaming usage collection from usage recording and moved budget actual-usage conversion to the budget owner.
  - `9d7ce2a2` folded the four JSON protocol endpoints into `GatewayProtocolSpec` plus `executeGatewayProtocolRequest`.
  - `b0f9ba1f` introduced the provider streaming dialect registry.
  - `ae7e817b` centralized stream wrapper composition and stream budget settlement ownership.
  - `f47ea659` centralized Gateway env readers and renamed runtime `agentApiKeyId` usage to `agentId`.
- Behavior alignment was intentionally limited to two inconsistencies from the plan:
  - `messages`, `responses`, and `embeddings` now match chat by passing sanitized non-retry provider 4xx failures through as `provider_rejected_request` with the upstream status.
  - Chat all-subscription candidate failures now return `provider_protocol_unsupported` instead of the misleading `provider_credentials_missing`.
- `tests/features/gateway-cohesion-refactor.unit.test.ts` is the structural fitness test for future changes. New code that moves credentials back into endpoint modules, reintroduces endpoint-local error unions/casts, bypasses the protocol template, branches streaming behavior on provider-key strings, or reintroduces `agentApiKeyId` naming will fail there before runtime behavior drifts.
- Non-goals remain unchanged: splitting `packages/db` into a dedicated runtime/routing package is still a separate architecture plan, and provider adapter optional capability splitting stays deferred because S4 now centralizes the runtime capability check.
- Final verification passed: `pnpm run db:migrate:check`, `pnpm run verify`, and `pnpm run verify:features` with all 18 passing feature verifications re-run.

## 2026-07-04 PR #15 CI Fix

- Investigated GitHub Actions run `28668889005` / job `85027269182`: CI failed in `tests/e2e/console-p0-layout.e2e.spec.ts` because the Limits rules table wrapper measured `scrollWidth - clientWidth = 1` on the runner while the test required `0`.
- Kept the product contract intact (page-level no-overflow and action visibility still asserted) and relaxed only the wrapper measurement to a 1px rounding tolerance, matching the existing action-cell tolerance.
- Verification: `pnpm exec vitest run tests/features/console-p0-layout.unit.test.ts`, `pnpm test:e2e tests/e2e/console-p0-layout.e2e.spec.ts`, `pnpm run lint`, and full `pnpm test:e2e` passed.

## 2026-07-03 UI/UX Review → console-providers-ia-and-forms (batch 4 of 4)

- Implemented `console-providers-ia-and-forms` (TDD red→green, seeded-data E2E):
  - Providers page keeps one representation: the duplicate provider summary-card grid (name/status/keys/models repeated above the actionable list) is removed with its CSS and orphaned helpers.
  - Model library is client-searchable and capped at 50 visible rows with a "Showing first N of M" note — a 60-model provider no longer renders an 8500px page (E2E asserts < 4500px).
  - `.agents-stat-grid` collapses to 2 columns at ≤56rem; KPI values no longer truncate at 390.
  - `input/select/textarea:disabled` get real disabled styling (opacity + not-allowed cursor) so Settings' display-only selects read as such; the webhook form carries example placeholders.
  - Virtual Model dialog submit reads `Create` when creating, `Save` when editing.
  - Batch-2 contracts updated for the deleted duplicate pill implementation (provider list-row locator; pill check now targets providers-client-section only).
- Release guards now accept 10 feature contracts.

### Review items intentionally not adopted / deferred
- "Filter" filter-button wording and right-aligned dialog submit actions stay: both were explicit decisions recorded in the dark-restyle follow-up pass.
- Deferred (P2, unscheduled): topbar/h1 title duplication + eyebrow system, nav two-letter icon tiles, request-ID/gateway-URL copy affordances, "High risk"/"Connected" metric tooltips, single-segment donut degradation, playground note tone, Usage vs Activity default-window unification.

## 2026-07-03 UI/UX Review → console-shared-formatters (batch 3 of 4)

- Implemented `console-shared-formatters` (TDD red→green, seeded-data E2E):
  - New shared module `packages/db/src/console-format.ts` (`@llmingress/db/console-format`): `MISSING_VALUE` (em dash), `formatConsoleCount` (full locale), `formatConsoleCompactCount` (KPI-only 92.5K/1.3M), `formatConsoleUsd` (≥1¢ two decimals, sub-cent three significant digits, $0.00 for zero), `formatConsoleTimestamp` (date-qualified outside the current day).
  - `sections.tsx` dropped seven local look-alike formatters and the `N/A`/`Unavailable`/`-` null mix; overview recent-requests tokens now show full counts matching Activity.
  - `formatConsoleUsageCost`/`formatConsoleActivityCost` in packages/db delegate to the shared USD rule (no more 8-decimal noise).
- Release guards now accept 9 feature contracts.

## 2026-07-03 UI/UX Review → console-semantic-status (batch 2 of 4)

- Implemented `console-semantic-status` (TDD red→green, seeded-data E2E):
  - `StatCard` delta tones are valence (`good`/`bad`/`neutral`) chosen per metric polarity — cost down and over-limit down are good, requests/tokens/savings up are good, zero change is neutral gray; new optional `valueTone` colors KPI values.
  - `failureRateTone` (≥5% warn, ≥20% danger) drives the Overview/Usage/Virtual Models failure-rate KPIs and the VM list + Usage summary table cells (`.num-warn`/`.num-danger`).
  - Runtime: stale/missing heartbeat value renders warn; `db:migrate:check` renders `Ready`/`Blocked` as ok/danger pills.
  - Intentionally disabled providers/models/candidates show neutral gray chips instead of danger red (both `ProviderStatusPill` copies + `ModelAvailabilityPill` + VM candidate card).
  - Row-level Delete actions are quiet (transparent at rest, danger-soft on hover); the Limits row Delete now opens a `LimitsDeleteDialog` confirm instead of posting `deleteLimitRules` directly.
- Release guards now accept 8 feature contracts.

## 2026-07-03 UI/UX Review → console-p0-layout (batch 1 of 4)

- Ran a designer review of the live console (11 pages, 1280/390 screenshots, dialogs, focus states). Fix plan has 4 batches: P0 layout → semantic colors/destructive actions → shared formatters → filters/forms polish. Batches 2–4 are not started.
- Implemented `console-p0-layout` (TDD red→green, E2E seeds request + limit data because a fresh DB hides all four defects):
  - `.chart-card` gets `min-width: 0` and the 56rem `.detail-layout` override uses `minmax(0, 1fr)`, so the Overview recent-requests table scrolls inside its card instead of widening the page by 458px at 390.
  - Limits rules table now fits the 1280 content column with row actions fully visible: cell `padding-inline` md→sm, actions gap sm→xs, headers `Cost limit`→`Budget` and `Token limit`→`Tokens`, table `min-width` 64rem→56rem.
  - `TrendLineChart` renders a `.chart-empty` message (per-call-site copy) instead of a blank card when the window has no data points.
  - Sidebar collapses behind a text `Menu` toggle at ≤56rem (aria-expanded/aria-controls, drawer closes after navigation); desktop layout unchanged.
- Release guards now accept 7 feature contracts (added `console-p0-layout`).

## Compression Summary

- `feature_list.json` now tracks 5 V1 milestone features instead of the previous 127 feature-by-feature delivery records.
- `tests/features` and `tests/e2e` now keep only the 5 V1 milestone unit/E2E specs.
- `packages/db/migrations` now ships one destructive pre-release baseline migration: `0001_v1_baseline.sql`.
- Historical session notes, old feature tests, and old migration steps are intentionally left to git history.

## 2026-07-03 Console Dark Restyle

- Implemented `console-dark-restyle`: Console now serves a dark-only violet skin with Geist / Geist Mono, compact 30px primary buttons, no theme toggle, fixed chart tokens, and responsive no-overflow checks at 1280px and 390px.
- Follow-up brand icon: selected the policy-slots mark, converted it to maintainable SVG, removed generated PNG drafts, and wired the SVG into the Console sidebar mark plus metadata favicon.
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
- Follow-up Provider local refresh: Provider row refresh now submits through a local client fetch and the existing endpoint returns JSON for that path, so clicking refresh no longer navigates or reloads the page.
- Follow-up Provider header/runtime polish: aligned the sidebar gateway status dot with its status label and removed the leading icon from the `Add Provider` button.
- Follow-up Virtual Models button polish: removed the leading icon from `Create Virtual Model`, changed the filter submit button to text-only `Query`, and aligned it with the search input.
- Follow-up Virtual Models detail dialog: removed the right-side Virtual Model detail card and moved read-only model details into a row-click dialog, letting the Virtual Model list span the page width.
- Follow-up Virtual Models route editor layout: removed the right-side current-strategy note from the route editor dialog and let the editor form occupy the full dialog width.
- Follow-up Virtual Models detail dialog layout: widened the read-only detail dialog and arranged its cards in a two-column grid.
- Follow-up Virtual Models route editor width: narrowed the edit route dialog to the editor content width and kept horizontal scrolling inside the candidates table.
- Follow-up Virtual Models route editor width/action polish: widened the edit route dialog to 56rem and centered the Cancel / Save action row.
- Follow-up Activity detail dialog: removed the right-side Request detail panel and moved request details into a read-only dialog opened from Request ID links, letting the Request list span the page width.
- Follow-up Activity filter button polish: changed the Activity filter submit button to text-only `Query` and aligned it with the Request ID input height.
- Follow-up Usage filter button polish: changed the Usage filter submit button to text-only `Query` and aligned it with the adjacent Provider select height.
- Follow-up Limits rule dialog: removed the right-side Rule configuration panel and added row-level `Edit` actions that open the existing rule form in a modal dialog.
- Follow-up Limits save button text: shortened the rule dialog submit button from `Save rules` to `Save`.
- Follow-up Playground action order: moved `Clear` before the submit action and shortened `Send test` to `Send`.
- Follow-up Playground action alignment: removed the Playground action icons and centered the `Clear` / `Send` action row.
- Follow-up Limits action alignment: centered the rule dialog `Cancel` / `Save` actions and removed the `Save` icon.
- Follow-up Limits action width: made the rule dialog `Cancel` and `Save` actions use the same width.
- Follow-up Provider disabled refresh guard: disabled row-level model refresh for disabled Providers while keeping enabled Providers refreshable.
- Follow-up Virtual Models edit action style: changed Virtual Model row `Edit` links to reuse the Agents row edit button styling.
- Follow-up Limits edit action style: changed Limit Rules row `Edit` links to reuse the Agents row edit button styling.
- Follow-up Settings notification button polish: shortened the webhook notification submit button to `Save`, removed the icon, and centered it at normal button width.
- Follow-up Console UI consistency sweep: fixed the remaining Usage query height mismatch and compacted text-only submit buttons in Agent/Provider dialogs plus the Virtual Model Add Model action.
- Follow-up Agent create action alignment: right-aligned compact single-submit dialog actions while leaving centered multi-action rows unchanged.
- Follow-up Virtual Models action alignment: right-aligned the route editor dialog `Cancel` / submit action row.
- Follow-up filter button wording: renamed all Console filter-submit buttons from `Query` to `Filter`.
- Follow-up Limits action realignment: right-aligned the rule dialog `Cancel` / `Save` action row while preserving equal button widths.
- Follow-up Limits header cleanup: removed the API key prefix from the rule configuration dialog header.
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
  - Follow-up Provider local refresh check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed clicking `Refresh models for OPEN AI1` from clean `/providers` keeps the URL unchanged at `/providers`, preserves the selected row and inline detail, keeps the page nonblank, has no horizontal overflow, and produces no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Provider header/runtime polish check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed `Add Provider` has no icon, the button remains 30px tall, the sidebar gateway status dot/title center delta is `0px`, no horizontal overflow, and no console errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Virtual Models button polish check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed `Create Virtual Model` and `Query` have no icons, `Query` matches the search input height at `38.8px`, no horizontal overflow, no framework overlay, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Virtual Models detail dialog check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed clicking a Virtual Model row opens one `.vm-view-dialog`, removes `.vm-detail-card`, keeps `.vm-shell` as `block`, expands the list card to `1100.73px`, close returns to `/models`, no horizontal overflow, no framework overlay, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Virtual Models route editor layout check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the route editor dialog has no `.vm-policy-note`, no `Current strategy` text, `.vm-editor-grid` is `display: block`, form/dialog width ratio is `0.957`, Add Model opens and closes normally, no framework overlay, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Virtual Models detail dialog layout check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the read-only `.vm-view-dialog` is `1024px` wide, uses `display: grid` with `479px 479px` columns, places Summary/Candidates and Warnings/Fallback as two cards per row, Close returns to `/models`, no horizontal overflow, no framework overlay, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Virtual Models route editor width check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the edit `.vm-route-dialog` is `768px` wide, the form fills it at `0.935` ratio, outer overflow-x is hidden, candidates table overflow-x remains internal auto, Close returns to `/models`, no page horizontal overflow, no framework overlay, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Virtual Models route editor width/action check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the edit `.vm-route-dialog` is `896px` wide, the form fills it at `0.944` ratio, `.vm-dialog-actions` is centered with `0px` center delta against the dialog, the candidates table keeps internal horizontal scroll, there is no page horizontal overflow, and there are no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Activity detail dialog check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed `/activity` defaults to zero `.activity-detail-dialog` and zero `.activity-detail-panel`, `.activity-shell` is `display: block`, the list region is `1296px` wide at a `1597px` viewport, clicking the first Request ID opens one `role=dialog` / `aria-modal=true` `.activity-detail-dialog` at `768px`, Close returns to `/activity`, there is no page horizontal overflow, and there are no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Activity filter button check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the Activity filter submit button reads `Query`, has zero `.flat-icon`/`svg` icons, has height `38.8px` matching the Request ID input at `38.8px`, submits without breaking the page, has no horizontal overflow, and has no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Usage filter button check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the Usage filter submit button reads `Query`, has zero `.flat-icon`/`svg` icons, has height `37.59px` matching the Provider select at `37.59px`, submits to `/usage` with form params, has no horizontal overflow, no visible framework overlay, and no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Limits rule dialog check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed `/limits` defaults to zero `.limits-config-panel`, zero `.limits-config-dialog`, three row-level `Edit` actions, zero stale row links, zero clickable table rows, `.limits-main` is `display: block`, the Limit Rules card spans the main width at `1295.91px`, clicking `Edit` opens one `role=dialog` / `aria-modal=true` `.limits-config-dialog` at `672px`, Close removes `limitDialog`, and there are no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Limits save button text check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the Limits rule dialog submit button reads `Save`, no `Save rules` text remains, and there are no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Playground action order check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the Playground actions render as `Clear`, then `Send`, no `Send test` text remains, and there are no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Playground action alignment check: targeted unit, Console typecheck, lint, and browser checks passed; browser confirmed the Playground actions render as `Clear`, then `Send`, have zero icons, are centered, no `Send test` text remains, and there are no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Limits action alignment check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the Limits rule dialog actions are centered with `0px` center delta, render as `Cancel`, `Save`, have zero icons, and have no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Limits action width check: targeted unit, Console typecheck, and lint passed; CSS now applies the same fixed width to both `.limits-config-actions button` and `.limits-config-actions .secondary-button`. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Provider disabled refresh check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed disabled Provider `Z.ai` has disabled refresh with `Enable provider to refresh models`, enabled Provider `OPEN AI1` remains refreshable, and there are no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Virtual Models edit action style check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed Virtual Model row `Edit` actions use `link-button agent-action-edit`, old `.vm-table .table-action-link` count is `0`, the button is 28px tall with accent background/border, and there are no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Limits edit action style check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed Limit Rules row `Edit` actions use `link-button agent-action-edit`, old `.limits-rule-table .table-action-link` count is `0`, Delete remains visible, and there are no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Settings notification button check: targeted unit, Console typecheck, lint, and SSR/source checks passed; markup and CSS confirm the webhook notification submit button renders as text-only `Save`, uses normal centered button width, has zero icons, and no old long label remains. In-app Browser control timed out during navigation/DOM reads, so full visual browser validation was not completed. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Console UI consistency sweep check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser swept the 10 main Console routes with zero horizontal overflow, zero persistent right-side detail panels, text-only Query buttons with `0px` height delta, no console warnings/errors, and confirmed Agent/Provider create plus Virtual Model Add Model dialog actions are compact and icon-free. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Agent create action alignment check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the New agent `Create` action is text-only, has zero icons, has `0px` right delta against the form, has no horizontal overflow, and has no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Virtual Models action alignment check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the Virtual Model route editor actions render as `Cancel` / `Create`, use `flex-end`, have zero icons, have `0px` right delta, and have no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up filter button wording check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed Agents, Virtual Models, Activity, and Usage filter buttons all render `Filter`, have zero icons, have no remaining visible `Query` buttons, have no horizontal overflow, and have no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Limits action realignment check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the Limits rule dialog actions render as `Cancel` / `Save`, use `flex-end`, keep equal `116px` widths, have zero icons, have `0px` right delta, and have no horizontal overflow or console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Follow-up Limits header cleanup check: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`, `pnpm --filter @llmingress/console run typecheck`, and `pnpm run lint` passed; browser confirmed the Limits rule dialog header has no `.mono` key prefix, still shows `Rule configuration`, `test1`, and `Close`, has no horizontal overflow, and has no console warnings/errors. Full regression intentionally skipped for this UI-only tuning pass.
  - Full regression merge check: initial `pnpm run verify:features` exposed stale local Next dev PID `47013` holding the Console dev lock and making Console E2E startup exit with code 1. After stopping that process, `pnpm test:e2e tests/e2e/v1-console.e2e.spec.ts` passed and the rerun `pnpm run verify:features` passed with all 10 passing features re-verified.

## 2026-07-04 Console UI Audit Confirmed Fixes

- Created isolated worktree `.worktrees/console-ui-audit-confirmed-fixes` on branch `codex/console-ui-audit-confirmed-fixes` and copied the ignored root `.env.local` into it.
- Baseline before edits: `pnpm run verify:features` passed with all 10 existing passing features re-verified.
- Added `console-ui-audit-confirmed-fixes` tracker entry and TDD coverage:
  - `tests/features/console-ui-audit-confirmed-fixes.unit.test.ts`
  - `tests/e2e/console-ui-audit-confirmed-fixes.e2e.spec.ts`
- Confirmed red phase:
  - Focused unit failed on the expected static contracts before implementation.
  - Focused E2E failed because Overview still showed old all-time recent activity beside `Requests 24h 0`.
- Implemented the confirmed audit fixes only: Activity Time/Request ID overflow protection, Overview 24h-only recent/top-cost data, Usage 7d default window, Agents `Online` and `Cost 24h` labels, Virtual Models `Failure rate total` labels, compact icon row action classes, Agent checkbox virtual-model grants, form display labels, Limits close icon, removed isolated page eyebrows, and `llmi_` Playground placeholder.
- Updated older regression contracts to match the new confirmed behavior:
  - Release guard feature ID/count expectations now include `console-ui-audit-confirmed-fixes`.
  - Semantic-status E2E now checks `Failure rate total`.
  - Shared-formatters E2E now verifies old requests are not shown in Overview 24h recent requests while Activity still verifies date-qualified timestamps.
- Verification completed:
  - `pnpm exec vitest run tests/features/console-ui-audit-confirmed-fixes.unit.test.ts`
  - `pnpm test:e2e tests/e2e/console-ui-audit-confirmed-fixes.e2e.spec.ts`
  - `pnpm --filter @llmingress/console typecheck`
  - `pnpm run lint`
  - `pnpm test:e2e tests/e2e/console-semantic-status.e2e.spec.ts`
  - `pnpm test:e2e tests/e2e/console-shared-formatters.e2e.spec.ts`
  - `pnpm test:e2e tests/e2e/v1-release-guards.e2e.spec.ts`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 11 passing features re-verified.
- Rendered verification used the repo Playwright E2E path; no in-app Browser fallback was needed. No unresolved blockers.

## 2026-07-04 Playground Action Alignment Follow-up

- Changed the Playground `Clear` / `Send` action row from centered to right-aligned in `.playground-actions`.
- Updated `tests/features/console-dark-restyle.unit.test.ts` to assert `justify-content: flex-end`.
- Browser verification on `http://localhost:3000/playground` measured `.playground-actions` as `justifyContent: flex-end` with `rightGap: 0` between the action row and Send button right edges; captured viewport evidence after scrolling to the action row.
- Verification completed:
  - `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`
  - `pnpm run lint`
  - `pnpm --filter @llmingress/console typecheck`
  - `pnpm run verify`
  - `pnpm test:e2e tests/e2e/v1-console.e2e.spec.ts` after the first full feature run hit transient Console startup contention
  - `pnpm run verify:features` passed with all 11 passing features re-verified.

## 2026-07-04 Gateway Pipeline Hardening F1

- Worktree `.claude/worktrees/gateway-pipeline-hardening` is on branch `worktree-gateway-pipeline-hardening`; local `dev` was merged before implementation so the branch includes the latest Console fixes.
- Baseline before Gateway edits:
  - `pnpm install`
  - `pnpm run verify`
  - `pnpm run verify:features` passed after the optimized E2E batch fell back to per-feature reruns; final result was all 11 passing features re-verified.
- Registered the six Gateway pipeline hardening tracker entries from the implementation plan. `gateway-db-pool` is now passing; the remaining five Gateway entries stay `failing` until their slices are implemented.
- Implemented `gateway-db-pool`:
  - Added process-level `pg.Pool` helpers in `packages/db/src/client.ts`: `getPostgresPool`, `closePostgresPools`, `withPooledPostgresClient`, and `withPostgresTransaction`.
  - Migrated Gateway request-path DB operations to pooled access for auth, virtual-model access, activity recording, rate limits, budget reservations, usage recording, provider credential reads, fallback events, streaming runtime errors, provider health event writes, and provider API key last-used updates.
  - Kept dedicated/low-frequency paths out of scope: config LISTEN, provider health LISTEN, gateway metrics, and runtime heartbeat/status writes.
  - Added `closePostgresPools()` to Gateway Fastify `onClose`.
  - Extracted reusable Gateway process helpers to `tests/support/gateway-process.ts`.
  - Added focused unit coverage and an E2E 30-request burst that holds `request_activity` inserts briefly and asserts Postgres backend count remains bounded under the pool.
- Verification completed:
  - Red phase: `pnpm exec vitest run tests/features/gateway-db-pool.unit.test.ts` failed on missing `getPostgresPool`.
  - `pnpm exec vitest run tests/features/gateway-db-pool.unit.test.ts`
  - `pnpm test:e2e tests/e2e/v1-gateway-routing.e2e.spec.ts`
  - `pnpm test:e2e tests/e2e/gateway-db-pool.e2e.spec.ts`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 11 previously passing features re-verified.
- Release guard tests now allow the registered Gateway hardening entries to be `failing` while still requiring the previously accepted feature contracts to stay `passing`; the E2E dry-run assertion reads the current passing count from `feature_list.json`.
- Remaining risks/non-goals: streaming/non-streaming provider runtime is still split, Console and Worker DB paths are not pooled in this slice, and F2-F6 remain unimplemented.

## 2026-07-04 Gateway Pipeline Hardening F2

- Implemented `gateway-recording-resilience`:
  - Moved the Gateway JSON/streaming recording wrappers from `apps/gateway/src/main.ts` into `apps/gateway/src/request-recording.ts`.
  - Added recorder injection for focused unit tests and made activity creation, activity completion, usage recording, and trace recording failures log at error level without changing the LLM response.
  - Allows provider execution to continue with `requestActivityId: undefined` when activity creation fails; usage recording is skipped without an activity id because request usage has an activity FK.
  - Changed chat completion concurrency release cleanup to avoid throwing from the finally path.
  - Removed provider response body from streaming provider failure `console.error` payloads.
  - Added `tests/support/gateway-route-seed.ts` for compact Gateway E2E route seeding.
- Verification completed:
  - Red phase: `pnpm exec vitest run tests/features/gateway-recording-resilience.unit.test.ts` failed because `apps/gateway/src/request-recording.ts` did not exist.
  - `pnpm exec vitest run tests/features/gateway-recording-resilience.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-recording-resilience.e2e.spec.ts`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 12 previously passing features re-verified before marking F2 passing.
- Remaining risks/non-goals: recording failures are now non-fatal, but budget settlement semantics and stream timeout/backpressure remain for F3/F4.

## 2026-07-04 Gateway Pipeline Hardening F3

- Implemented `gateway-stream-robustness`:
  - Added provider request timeouts for non-streaming OpenAI chat, embeddings, responses, and Anthropic messages adapter calls via `PROVIDER_REQUEST_TIMEOUT_MS`.
  - Added Gateway streaming connect timeout via `GATEWAY_STREAM_CONNECT_TIMEOUT_MS`, kept the existing first-chunk timeout, and added mid-response idle timeout via `GATEWAY_STREAM_IDLE_TIMEOUT_MS`.
  - Exported the readahead stream helper for focused coverage and made it fail stalled provider bodies instead of hanging forever after the first chunk.
  - Changed activity stream completion wrapping to use `pipe` backpressure, collect usage as an observer, and destroy upstream provider streams when the client side closes.
  - Added fake provider `stream-stall` mode and E2E coverage for hung non-streaming providers and streaming providers that stall after one chunk.
- Verification completed:
  - Red phase: `pnpm exec vitest run tests/features/gateway-stream-robustness.unit.test.ts` failed on missing timeout behavior/export and on unbounded/manual stream forwarding.
  - `pnpm exec vitest run tests/features/gateway-stream-robustness.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-stream-robustness.e2e.spec.ts`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 13 previously passing features re-verified before marking F3 passing.
- Remaining risks/non-goals: settlement finalization, reservation TTL/reconciliation, typed error fidelity, and request hygiene remain for F4-F6.

## 2026-07-04 Gateway Pipeline Hardening F4

- Implemented `gateway-settlement-integrity`:
  - Added actual-usage budget finalization: pending reservations charge provider actual cost/tokens when available and fall back to the reserved estimate when not.
  - Added late finalize for `expired`/`released` reservations with actual usage so long streams can still record true cost after stale-reservation cleanup returned the reserved amount.
  - Parameterized reservation TTL with `GATEWAY_BUDGET_RESERVATION_TTL_SECONDS` and defaulted it to 30 minutes.
  - Added `buildGatewayBudgetActualUsage` and wired non-streaming fallback success paths to finalize with provider usage.
  - Moved streaming budget settlement ownership to `apps/gateway/src/request-recording.ts`, where stream completion has access to collected SSE usage.
  - Added `stale_concurrency_reconcile` job type migration, worker handler, periodic task registration, and `reconcileGatewayConcurrencyWindows` for quiet concurrency-window self-healing.
  - Documented budget late-finalize and stale concurrency reconciliation tradeoffs in `docs/ARCHITECTURE.md`.
- Verification completed:
  - Red phase: `pnpm exec vitest run tests/features/gateway-settlement-integrity.unit.test.ts` failed because `worker-stale-concurrency` did not exist.
  - `pnpm exec vitest run tests/features/gateway-settlement-integrity.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-settlement-integrity.e2e.spec.ts`
  - `pnpm run db:migrate:check`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 14 previously passing features re-verified before marking F4 passing.
- Remaining risks/non-goals: typed provider error fidelity and request hygiene remain for F5-F6.

## 2026-07-04 Gateway Pipeline Hardening F5

- Implemented `gateway-error-fidelity`:
  - Added typed `GatewayPipelineError` response conversion so Gateway runtime errors no longer depend on string matching.
  - Added `provider_rejected_request` handling for non-retryable provider 4xx responses, preserving upstream status and a sanitized/truncated provider message.
  - Added `provider_rate_limited` handling for upstream 429 responses.
  - Changed non-streaming credential attachment to skip candidates with missing credentials and continue through the fallback chain; all-missing routes still fail with `provider_credentials_missing`.
  - Changed streaming fallback attempts to iterate every provider API key for a candidate, matching the non-streaming retry semantics and recording the key actually used.
  - Added fake provider `bad-request` mode and coverage for provider 400 passthrough, missing credential fallback, typed fallback errors, provider-message sanitization, and streaming multi-key retry.
- Verification completed:
  - `pnpm exec vitest run tests/features/gateway-error-fidelity.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-error-fidelity.e2e.spec.ts`
  - `pnpm run lint`
  - `pnpm --filter @llmingress/db typecheck`
  - `pnpm --filter @llmingress/gateway typecheck`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 15 previously passing features re-verified before marking F5 passing.
- Remaining risks/non-goals: request hygiene remains for F6; the broader streaming/non-streaming provider adapter unification remains intentionally out of scope.

## 2026-07-04 Gateway Pipeline Hardening F6

- Implemented `gateway-request-hygiene`:
  - Added configurable Gateway `bodyLimit` with a 10 MiB default so normal multi-megabyte chat requests are accepted.
  - Validated client `x-request-id` against a bounded safe-character pattern and generated a Gateway request id for malformed values.
  - Fixed baseline candidate selection to sort a copy instead of mutating the config snapshot.
  - Changed text token estimation so CJK characters count as one token each while non-CJK text still uses the 4-character estimate.
  - Protected `/metrics` with optional `GATEWAY_METRICS_TOKEN` bearer-token enforcement.
  - Added OpenAI chat completions passthrough for the documented whitelist and made `max_completion_tokens` take precedence over `max_tokens`; streaming chat payloads use the same passthrough behavior.
  - Refreshed expired provider OAuth tokens inside a `provider_oauth` row-lock transaction so concurrent requests refresh once, and bounded OAuth token HTTP requests with a 30 second timeout.
  - Documented chat passthrough scope, multimodal and TPM non-goals, and the current Gateway runtime package boundary in `docs/ARCHITECTURE.md`.
- Verification completed:
  - Red phase: `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts` failed on missing request-id export, CJK estimator export, mutating sort, max token precedence, and OAuth row-lock helper.
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts`
  - `pnpm run lint`
  - `pnpm --filter @llmingress/db typecheck`
  - `pnpm --filter @llmingress/provider typecheck`
  - `pnpm --filter @llmingress/gateway typecheck`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 16 previously passing features re-verified before marking F6 passing.
- Remaining risks/non-goals: streaming and non-streaming provider execution still have separate implementations; complete adapter unification, chat multimodal support, and pooling low-frequency Console/Worker DB paths remain out of scope for this plan.

## 2026-07-04 Virtual Models Page Alignment Follow-up

- Changed `/models` from the centered generic `.page` shell to `.page models-page`, reusing the Agents/Providers left-aligned width rule.
- Browser verification on `http://localhost:3000/models` measured `.models-page` with `leftGap: 0`, `marginLeft: 0px`, and no console warnings/errors; captured viewport evidence.
- Verification completed:
  - `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`
  - `pnpm run lint`
  - `pnpm --filter @llmingress/console typecheck`
- Full regression intentionally skipped per user request for this UI-only tuning pass.

## 2026-07-04 Gateway Runtime Page Alignment Follow-up

- Changed `/runtime` from the centered generic `.page` shell to `.page runtime-page`, reusing the Agents/Providers left-aligned width rule.
- Browser verification on `http://localhost:3000/runtime` measured `.runtime-page` with `leftGap: 0`, `marginLeft: 0px`, no horizontal overflow, and no console warnings/errors; captured viewport evidence.
- The in-app Browser DOM snapshot API returned an interface error, so rendered verification used the same in-app Browser's read-only DOM evaluate plus screenshot path.
- Verification completed:
  - `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`
  - `pnpm run lint`
  - `pnpm --filter @llmingress/console typecheck`
- Full regression intentionally skipped for this UI-only tuning pass.

## 2026-07-04 Settings Page Alignment Follow-up

- Changed `/settings` from the centered generic `.page` shell to `.page settings-page`, reusing the Agents/Providers left-aligned width rule.
- Browser verification on `http://localhost:3000/settings` measured `.settings-page` with `leftGap: 0`, `marginLeft: 0px`, no horizontal overflow, no visible framework overlay, and no console warnings/errors; captured viewport evidence.
- The in-app Browser DOM snapshot API remained unavailable, so rendered verification used the same in-app Browser's read-only DOM evaluate plus screenshot path.
- Verification completed:
  - `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`
  - `pnpm run lint`
  - `pnpm --filter @llmingress/console typecheck`
- Full regression intentionally skipped for this UI-only tuning pass.

## 2026-07-05 Agent Budget Period Label Follow-up

- Fixed the missed Agent limit `Budget period` option display labels in Create/Edit Agent dialogs from `day` / `week` / `month` to `Day` / `Week` / `Month`; submitted values remain unchanged.
- Browser verification on `http://localhost:3000/agents?agentDialog=...` measured Edit Agent `Budget period` options as `Day`, `Week`, `Month`, with no raw lowercase labels, no visible framework overlay, no horizontal overflow, and no console warnings/errors.
- Verification completed:
  - `pnpm exec vitest run tests/features/console-ui-audit-confirmed-fixes.unit.test.ts`
  - `pnpm run lint`
  - `pnpm --filter @llmingress/console typecheck`
- Left out by scope: Activity timestamp ellipsis at 1280, older time/header/status consistency P2s, and Usage negative-savings copy.

## 2026-07-04 Gateway Pipeline Hardening Follow-up

- Fixed post-merge audit follow-ups for the Gateway hardening branch:
  - Client abort now propagates through the nested stream wrappers and cancels the readahead provider reader instead of stopping at the intermediate PassThrough.
  - Codex subscription responses and Claude Code subscription messages now use the shared provider request timeout behavior.
  - Subscription OAuth credential loading releases the outer pooled client before reading/refreshing OAuth tokens, so expired-token refresh does not require a second pool slot while the first is held.
- TDD red phase completed:
  - `pnpm exec vitest run tests/features/gateway-stream-robustness.unit.test.ts tests/features/gateway-request-hygiene.unit.test.ts` failed on missing subscription timeouts, missing nested stream cancellation, and OAuth pool exhaustion with `LLMINGRESS_DB_POOL_MAX=1`.
  - `pnpm test:e2e tests/e2e/gateway-stream-robustness.e2e.spec.ts --workers=1` failed because client abort did not close the fake provider stream.
- Verification completed:
  - `pnpm exec vitest run tests/features/gateway-stream-robustness.unit.test.ts tests/features/gateway-request-hygiene.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-stream-robustness.e2e.spec.ts --workers=1`
  - `pnpm --filter @llmingress/provider typecheck`
  - `pnpm --filter @llmingress/db typecheck`
  - `pnpm run lint`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 17 passing features re-verified on the current post-merge HEAD.
  - `git diff --check`
  - `jq empty feature_list.json`
- Remaining risks/non-goals: no new tracker feature was added; broader streaming/non-streaming adapter unification and Console/Worker DB pooling remain out of scope.

## 2026-07-05 Gateway Agent Limits Unified Enforcement Follow-up

- Replaced the split Gateway request-start limit path with `gateway-agent-limits`:
  - `enforceGatewayAgentLimits` reads enabled `agent_limits` once and handles budget, per-request token, RPM, TPM, and concurrency checks in one transaction.
  - JSON and streaming Gateway request paths no longer call `reserveGatewayBudget`, `finalizeGatewayBudgetReservation`, `releaseGatewayBudgetReservation`, `settleGatewayStreamBudget`, or `enforceGatewayRateLimits`.
  - Budget start checks use current `budget_periods.cost_used_usd` only. Successful JSON/streaming responses schedule `recordGatewayBudgetUsage` in the background after completion; failures and aborted streams do not charge budget.
- Deleted the legacy budget reservation runtime surface:
  - Removed `packages/db/src/gateway-budgets.ts`, `packages/db/src/gateway-rate-limits.ts`, and `packages/db/src/worker-stale-reservations.ts`.
  - Removed stale reservation worker scheduling/handler registration and package exports.
  - Added migration `0003_remove_budget_reservations.sql` to drop `budget_reservations`, `budget_periods.reserved_*`, and `stale_reservation_cleanup` job type.
  - Updated Console/Worker budget usage queries, backup table list, architecture docs, and settlement tests to the post-charge budget-period model.
- Verification completed:
  - `pnpm exec vitest run tests/features/gateway-cohesion-refactor.unit.test.ts tests/features/gateway-settlement-integrity.unit.test.ts tests/features/gateway-recording-resilience.unit.test.ts`
  - `pnpm exec vitest run tests/features/v1-platform.unit.test.ts`
  - `pnpm --filter @llmingress/db typecheck`
  - `pnpm --filter @llmingress/gateway typecheck`
  - `pnpm test:e2e tests/e2e/gateway-settlement-integrity.e2e.spec.ts`
  - `pnpm run db:migrate:check`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 18 passing features re-verified.
- Remaining risks/non-goals: budget now uses accepted post-charge semantics, so concurrent successful requests can briefly exceed the configured budget before their background usage writes land. Historical migrations still create then remove reservation schema via migration `0003`; old migrations were not rewritten to avoid checksum mismatch.

## 2026-07-05 Gateway Completed Activity Recording Follow-up

- Removed the Gateway request-start `request_activity` insert from the Activity recording path:
  - Gateway now generates an in-memory Activity id and started timestamp before execution, then schedules one best-effort completed Activity transaction after JSON response or streaming completion/error.
  - `recordCompletedGatewayRequestActivity` inserts `request_activity`, `fallback_events`, and successful `request_usage`/`request_costs` in order inside one transaction.
  - Fallback execution no longer writes `fallback_events` immediately; failed attempts stay in memory for the Activity route summary and final timeline persistence.
  - Streaming finalization no longer waits for Activity recording before ending or erroring the output stream.
- TDD red phase:
  - `pnpm exec vitest run tests/features/gateway-recording-resilience.unit.test.ts` failed on the old `createActivity`/`completeActivity` recorder API, old immediate fallback writes, and remaining `requestActivityId` runtime usage.
- Verification completed:
  - `pnpm exec vitest run tests/features/gateway-recording-resilience.unit.test.ts`
  - `pnpm --filter @llmingress/db typecheck`
  - `pnpm --filter @llmingress/gateway typecheck`
  - `pnpm test:e2e tests/e2e/gateway-recording-resilience.e2e.spec.ts`
  - `pnpm exec vitest run tests/features/gateway-stream-robustness.unit.test.ts`
  - `pnpm exec vitest run tests/features/gateway-cohesion-refactor.unit.test.ts tests/features/gateway-settlement-integrity.unit.test.ts tests/features/gateway-recording-resilience.unit.test.ts`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 18 passing features re-verified.
- Remaining risks/non-goals: Activity/usage/cost/fallback persistence is still in-process best-effort; a process crash immediately after response can lose these observability rows. DB schema is intentionally unchanged.

## 2026-07-05 Schema Refactor 0004 Vocabulary Checks

- Implemented `0004_relax_vocab_checks.sql`:
  - Dropped product vocabulary CHECK constraints for `jobs.job_type`, `agents.integration_platform`, and `providers.provider_template_id`.
  - Kept machine-state database constraints, including job status/trigger and agent type checks.
  - Confirmed the write-path still validates current Console/provider-template vocabularies in application code.
- TDD red phase:
  - `pnpm exec vitest run tests/features/schema-vocab-checks-relaxed.unit.test.ts` failed on `jobs_job_type_check`, `agents_integration_platform_check`, and `providers_template_id_whitelisted`.
- Verification completed:
  - `pnpm exec vitest run tests/features/schema-vocab-checks-relaxed.unit.test.ts tests/features/v1-platform.unit.test.ts tests/features/v1-release-guards.unit.test.ts`
  - `pnpm test:e2e tests/e2e/schema-vocab-checks-relaxed.e2e.spec.ts`
  - `pnpm run db:migrate:check`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 19 passing features re-verified.
- Remaining risks/non-goals: direct database writes can now insert future product vocabulary values; supported application write paths remain guarded.

## 2026-07-05 Schema Refactor 0005 Notification Deliveries

- Implemented `0005_drop_notification_deliveries.sql`:
  - Dropped the write-only `notification_deliveries` audit table.
  - Notification dispatch now updates retry state directly on `notification_events` without inserting per-attempt audit rows.
  - Backup artifacts no longer include or skip `notification_deliveries`; `webhook_deliveries` remains unchanged as the webhook export dedup ledger.
- TDD red phase:
  - `pnpm exec vitest run tests/features/schema-notification-deliveries-removed.unit.test.ts` failed because old dispatcher still inserted into the dropped table, migrated schema still had the table, and backup still listed it.
  - `pnpm test:e2e tests/e2e/schema-notification-deliveries-removed.e2e.spec.ts` failed because the table still existed after migrations.
- Verification completed:
  - `pnpm exec vitest run tests/features/schema-notification-deliveries-removed.unit.test.ts tests/features/v1-platform.unit.test.ts tests/features/v1-release-guards.unit.test.ts`
  - `pnpm test:e2e tests/e2e/schema-notification-deliveries-removed.e2e.spec.ts`
  - `pnpm run db:migrate:check`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 20 passing features re-verified.
- Remaining risks/non-goals: historical notification delivery audit rows are intentionally removed by the migration; retry status retained on `notification_events` is the surviving operational state.

## 2026-07-05 Schema Refactor 0006 Fallback Single Source

- Implemented `0006_fallback_single_source.sql`:
  - Added `fallback_events.retryable` and `fallback_events.status_code`.
  - Dropped `request_activity.fallback_attempts`; fallback retry chains now use `fallback_events` as the single persisted source.
  - Gateway Activity recording writes retry metadata to `fallback_events` only.
  - Console activity list/detail, JSONL export legacy `fallbackAttempts`, and fallback exhaustion alerts all derive failed attempts from `fallback_events`.
  - `docs/ARCHITECTURE.md` table inventory was aligned with the current schema names and removed planned-only content tables from the current V1 data-group list.
- TDD red phase:
  - `pnpm exec vitest run tests/features/schema-fallback-single-source.unit.test.ts` failed on the old `request_activity.fallback_attempts` column, missing retry metadata, old recorder writes, Console fallback counts, JSONL legacy `fallbackAttempts`, and alert payload derivation.
  - `pnpm test:e2e tests/e2e/schema-fallback-single-source.e2e.spec.ts` failed because migrated schema still exposed `request_activity.fallback_attempts`.
- Verification completed:
  - `pnpm exec vitest run tests/features/schema-fallback-single-source.unit.test.ts tests/features/v1-platform.unit.test.ts tests/features/v1-release-guards.unit.test.ts`
  - `pnpm test:e2e tests/e2e/schema-fallback-single-source.e2e.spec.ts`
  - `pnpm run db:migrate:check`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 21 passing features re-verified.
- Remaining risks/non-goals: JSONL keeps the legacy `fallbackAttempts` output contract, but it is now reconstructed from `fallback_events`. `0007_drop_concurrency_windows` remains unimplemented pending the multi-instance Gateway product decision documented in `docs/SCHEMA_REFACTOR.md`.

## 2026-07-05 Provider Connectivity Probe Model Fix

- Fixed false unhealthy OpenAI provider probes:
  - `selectProviderProbeModel` now skips completion-only `instruct` models for chat-completions probes.
  - OpenAI GPT-5-style probes use `max_completion_tokens` and a small 16-token cap, avoiding both unsupported `max_tokens` and too-low output-limit failures.
- TDD red phase:
  - `pnpm exec vitest run tests/features/provider-dialect.unit.test.ts` first failed because `gpt-3.5-turbo-instruct` was selected ahead of `gpt-3.5-turbo`.
  - The same focused test then failed because GPT-5 probes sent `max_tokens`, and again because `max_completion_tokens` was too low for the live probe behavior.
- Verification completed so far:
  - `pnpm exec vitest run tests/features/provider-dialect.unit.test.ts`
  - Local live OpenAI provider probe returned HTTP 200 and wrote `provider_health_summary.status=healthy` plus `provider_api_keys.last_test_status=healthy`.
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 21 passing features re-verified.

## 2026-07-05 Anthropic Sonnet 5 Sampling Parameter Fix

- Fixed Claude Sonnet 5 `/v1/messages` requests rejected with deprecated sampling parameters:
  - Root cause: Playground/Gateway accepted common sampling inputs, but the shared Anthropic payload cleanup did not strip `temperature`, `top_p`, or `top_k` for `claude-sonnet-5`.
  - `omitUnsupportedAnthropicSamplingParameters` now removes those fields for Sonnet 5 before non-streaming, streaming, and Claude Code messages requests reach the provider.
- TDD red phase:
  - `pnpm exec vitest run tests/features/provider-dialect.unit.test.ts` failed while `claude-sonnet-5` payloads still included `temperature`, then failed again after live verification showed `top_p` was also deprecated.
- Verification completed so far:
  - `pnpm exec vitest run tests/features/provider-dialect.unit.test.ts`
  - Live local Gateway request to `POST /v1/messages` with `temperature` and `top_p` in the caller payload routed to `claude_code / claude-sonnet-5` and returned HTTP 200 with response text `ok`.

## 2026-07-05 Route Warning Stale Noise Cleanup

- Fixed misleading Virtual Model route warnings:
  - Route policy health warnings no longer treat stale probe timestamps as route warnings.
  - Route warnings still report non-healthy provider/model statuses such as quota limited or network error.
  - Virtual Model detail candidate badges now label available candidates as `Available` instead of `Healthy`.
- TDD red phase:
  - `pnpm exec vitest run tests/features/console-route-policy-warnings.unit.test.ts` failed while stale flags still produced route warnings and the detail badge still said `Healthy`.
- Verification completed so far:
  - `pnpm exec vitest run tests/features/console-route-policy-warnings.unit.test.ts`
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm test`
  - `pnpm run verify`
  - `pnpm test:e2e tests/e2e/v1-console.e2e.spec.ts` passed after the first `verify:features` attempt hit a transient Console startup conflict.
  - Second `pnpm run verify:features` passed with all 21 passing features re-verified.

## 2026-07-06 Provider Endpoint Registry Refactor

- Refactored Console provider templates:
  - `packages/db/src/console-provider-templates.ts` now uses one `providerTemplates: Record<ProviderTemplateId, ProviderInfo>` registry keyed by provider id.
  - Provider-level `capabilities` were removed from templates and selector items.
  - Provider API surface is represented as `endpoints` keyed by Gateway protocol names such as `chat_completions`, `responses`, `messages`, and `models`.
  - Model-level capability fields remain on provider model data; this change does not expand actual provider support.
- TDD red phase:
  - `pnpm exec vitest run tests/features/console-provider-templates.unit.test.ts` failed while selector items lacked `endpoints` and still exposed the old capability-shaped contract.
- Verification completed:
  - `pnpm exec vitest run tests/features/schema-vocab-checks-relaxed.unit.test.ts tests/features/v1-gateway-routing.unit.test.ts tests/features/console-provider-templates.unit.test.ts`
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm run verify`
  - First `pnpm run verify:features` attempt hit an existing local Console dev process holding the Next dev workspace; `pnpm test:e2e tests/e2e/v1-console.e2e.spec.ts` passed after stopping that Console process.
  - Second `pnpm run verify:features` passed with all 21 passing features re-verified.

## 2026-07-06 Provider Endpoint Coverage Refresh

- Updated Console provider template endpoint metadata from the provider docs traversal:
  - Added `embeddings` endpoint metadata for Google Gemini templates.
  - Added `responses` endpoint metadata for xAI, Qwen, and MiniMax templates.
  - Added `embeddings`, `messages`, and `responses` endpoint metadata for OpenRouter and the local Ollama, LM Studio, and llama.cpp templates.
  - Kept DeepSeek, Moonshot/Kimi, and Z.ai scoped to the same-base OpenAI-compatible chat/models endpoints already represented by the templates.
- Scope note:
  - Did not add unsupported Gateway protocol families such as legacy completions, images, videos, files, admin endpoints, or Anthropic-compatible alternate-base endpoints to templates whose base URL remains OpenAI-compatible.
- TDD red phase:
  - `pnpm exec vitest run tests/features/console-provider-templates.unit.test.ts` failed while the new provider endpoint expectations were not yet represented in `console-provider-templates.ts`.
- Verification completed:
  - `pnpm exec vitest run tests/features/console-provider-templates.unit.test.ts`
  - `pnpm exec vitest run tests/features/schema-vocab-checks-relaxed.unit.test.ts tests/features/v1-gateway-routing.unit.test.ts tests/features/console-provider-templates.unit.test.ts`
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 21 passing features re-verified.

## 2026-07-06 Virtual Model Endpoint Routing

- Added endpoint selection for Virtual Models and Route Policies:
  - Supported endpoint values are `chat_completions`, `responses`, `messages`, and `embeddings`.
  - The selected endpoint is stored in `route_policies.rules.endpointProtocol`; no migration was added.
  - Provider model options now expose `supportedEndpoints`, derived from provider templates plus direct OpenAI and Anthropic providers.
  - Virtual Model and Route Policy candidate pickers filter out provider models that do not support the selected endpoint.
  - `createRoutePolicy` and `updateRoutePolicy` reject candidates whose provider does not support the selected endpoint.
  - Gateway JSON and streaming request paths reject requests whose endpoint does not match the saved route-policy endpoint.
  - Existing policies without `endpointProtocol` remain runtime-compatible.
- TDD red phase:
  - `pnpm exec vitest run tests/features/virtual-model-endpoint-routing.unit.test.ts` failed while endpointProtocol was not preserved, provider endpoint support was not derived, candidate filtering did not apply, and Gateway mismatch requests still continued to provider execution.
- Verification completed so far:
  - `pnpm exec vitest run tests/features/virtual-model-endpoint-routing.unit.test.ts`
  - `pnpm test:e2e tests/e2e/virtual-model-endpoint-routing.e2e.spec.ts --workers=1`
  - `pnpm exec vitest run tests/features/v1-release-guards.unit.test.ts`
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 22 passing features re-verified.

## 2026-07-06 Docker Console Relative Redirect Fix

- Fixed Docker-hosted Console auth/form redirects:
  - Root cause: API routes built absolute redirects from `request.url`; in the Docker container Next resolves that as the internal listener `http://0.0.0.0:3000`, so a host request to `http://127.0.0.1:13000` could jump to the wrong local process after login.
  - Added `redirectToConsolePath()` for same-app redirects and switched Console API auth/form routes to relative `Location` headers.
  - External OAuth authorization URLs remain untouched; only redirects back into the Console app were changed.
- Verification completed:
  - `pnpm exec vitest run tests/features/v1-console.unit.test.ts`
  - `pnpm --filter @llmingress/console typecheck`
  - `pnpm run lint`
  - Rebuilt and restarted Docker project `llmingress_docker_local`.
  - `curl -I -X POST http://127.0.0.1:13000/api/auth/logout` now returns `location: /`.
  - Docker Gateway `/health` returned HTTP 200 and Docker Console root returned HTTP 200.
  - `pnpm run verify`

## 2026-07-06 Responses Tool Passthrough Follow-up

- Fixed Gateway `/v1/responses` tool passthrough for Hermes/Codex-style tool loops:
  - `normalizeOpenAIResponsesRequest` now validates and preserves `tools`, `tool_choice`, and `parallel_tool_calls`.
  - Responses `input` arrays now preserve raw typed items such as `function_call_output` instead of forcing every item into a text message shape.
  - Generic OpenAI Responses, streaming Responses, and Codex subscription `/codex/responses` payloads now forward the tool fields.
  - Codex subscription input normalization only converts plain string/text messages to `input_text`; typed Responses items remain unchanged.
- TDD red phase:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts tests/features/gateway-stream-robustness.unit.test.ts` failed while Responses tools were dropped, raw tool outputs were rejected/rewritten, and malformed tool fields were accepted.
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts` failed with `/v1/responses` returning HTTP 400 for a raw `function_call_output` input item.
- Verification completed:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts tests/features/gateway-stream-robustness.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts`
  - `pnpm --filter @llmingress/db typecheck`
  - `pnpm --filter @llmingress/provider typecheck`
  - `pnpm --filter @llmingress/gateway typecheck`
  - `pnpm run lint`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 22 passing features re-verified.
- Follow-up image input fix:
  - Root cause: Hermes sends screenshot vision requests as Responses message content parts containing both `input_text` and `input_image`; the Gateway Responses normalizer only accepted string/text-only content, so it returned `invalid_responses_request` before the provider saw the image.
  - Responses message content arrays now preserve raw content parts such as `input_image` and data URLs.
  - Codex subscription normalization still converts plain string messages to `input_text`, but leaves multimodal content-part arrays unchanged.
- Image fix TDD red phase:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts` failed because image content parts were rejected.
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts` failed because running Gateway returned HTTP 400 for a streaming Responses image input.
- Image fix verification completed:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts`
  - `pnpm --filter @llmingress/db typecheck`
  - `pnpm --filter @llmingress/provider typecheck`
  - `pnpm --filter @llmingress/gateway typecheck`
  - `pnpm run lint`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 22 passing features re-verified.
- Official field passthrough follow-up:
  - Root cause: the endpoint normalizers and streaming payload builder still maintained narrow field copies. That made Gateway reject or drop official request fields beyond the small set it needed for routing.
  - Responses now preserves official top-level fields such as `store`, `previous_response_id`, `conversation`, `include`, `metadata`, `reasoning`, `text`, `truncation`, and file/item input shapes across JSON, streaming, and Codex subscription payloads. Gateway still does not own cross-provider state migration; it forwards provider state fields.
  - Chat Completions now preserves developer/function/tool messages, multimodal/audio/file content parts, metadata, prediction, modalities, stream options, service tier, and other official top-level fields. `max_completion_tokens` is no longer rewritten to `max_tokens` for provider requests.
  - Embeddings now accepts string input, string-array input, token-array input, token-array batch input, and preserves `user`/format fields.
  - Anthropic Messages now preserves extra provider fields such as `container`, `context_management`, `mcp_servers`, and `betas` through JSON and streaming payloads.
- Official field passthrough TDD red phase:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts` failed while Chat dropped `max_completion_tokens` from passthrough, rejected official message/content shapes, Responses rejected stateful fields, Embeddings rejected token arrays, and Messages dropped extra top-level fields.
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts` failed while streaming Responses still dropped stateful/top-level fields and forced `store:false`.
- Official field passthrough verification completed:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts`
  - `pnpm run lint`
  - `pnpm run typecheck`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 22 passing features re-verified.
- Hermes reasoning replay follow-up:
  - Root cause: Hermes Responses turns can replay encrypted reasoning followed by an assistant placeholder item with `content: ""`; LLMIngress treated all empty string Responses message content as invalid and returned `invalid_responses_request` before provider execution.
  - Responses input normalization now allows empty string content only for assistant replay messages. Empty user messages remain invalid.
- Hermes reasoning replay TDD red phase:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts` failed while `[{type:"reasoning", encrypted_content:"..."}, {role:"assistant", content:""}]` was rejected.
- Hermes reasoning replay verification completed:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts`
  - `pnpm run lint`
  - `pnpm run typecheck`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 22 passing features re-verified.
- Raw provider passthrough follow-up:
  - Root cause: Gateway still rebuilt provider request bodies from normalized fields. That deleted fields such as paired Chat `max_tokens`, injected Responses `store:false`, converted Codex subscription Responses string messages into `input_text` parts, prepended Claude Code system content, and synthesized Codex subscription response bodies.
  - Provider payload builders now forward the Agent body with only virtual model replacement. Gateway still reads fields needed for routing, stream selection, token estimates, and limits, but provider-owned request fields are not rewritten or rejected for local schema reasons.
  - Removed Codex subscription input normalization, Codex response synthesis, Claude Code body system injection, and Anthropic sampling-parameter deletion.
- Raw provider passthrough TDD red phase:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts tests/features/gateway-stream-robustness.unit.test.ts tests/features/provider-dialect.unit.test.ts` failed while raw payloads were missing, malformed provider-owned Responses fields were rejected, Codex subscription bodies were rewritten, Claude Code bodies were prepended, Anthropic sampling fields were deleted, and Codex responses were synthesized.
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts` failed while Chat dropped `max_tokens` when `max_completion_tokens` was present.
- Raw provider passthrough verification completed:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts tests/features/gateway-stream-robustness.unit.test.ts tests/features/provider-dialect.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts`
  - `pnpm run lint`
  - `pnpm run typecheck`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 22 passing features re-verified.
- Read-only ingress follow-up:
  - Audited `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, and `/v1/embeddings`: request readers now preserve the raw Agent body as the provider payload and only extract local metadata best-effort for routing, token estimates, stream selection, and limits. Provider-owned request shapes no longer cause local schema rejection; the only provider-body mutation is virtual model replacement.
  - Removed the streaming dialect usage mutation that injected `stream_options.include_usage`; streaming request bodies now follow the same Agent-body-plus-model-replacement rule.
  - Provider responses are still read for status, provider request id, usage/cost extraction, and background recording, but success bodies are returned from the provider result and subscription adapters no longer synthesize response bodies.
- Read-only ingress TDD red phase:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts tests/features/provider-dialect.unit.test.ts` failed while provider-owned Chat, Responses, Messages, and Embeddings request shapes were rejected and streaming dialects still requested usage injection.
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts` failed while streaming Chat with provider-owned `messages` returned HTTP 400 before provider execution.
- Read-only ingress verification completed:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts tests/features/provider-dialect.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts`
  - `pnpm run lint`
  - `pnpm run typecheck`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 22 passing features re-verified.
- Provider error passthrough follow-up:
  - Root cause: successful provider responses were no longer synthesized, but non-retryable provider 4xx responses still passed through Gateway fallback error mapping, which replaced provider error codes with `provider_rejected_request` and added a Gateway `requestId`.
  - JSON protocol execution now returns the provider body and upstream status directly for non-retryable provider 4xx results that include a body. Streaming execution now returns the parsed provider error body and upstream status for non-retryable provider 4xx instead of wrapping it in a Gateway error envelope.
  - Retryable 429/5xx/network failures keep the existing fallback and Gateway error semantics.
- Provider error passthrough TDD red phase:
  - `pnpm test:e2e tests/e2e/gateway-error-fidelity.e2e.spec.ts --workers=1` failed while Chat and Messages 4xx responses returned `provider_rejected_request` envelopes instead of the provider body.
- Provider error passthrough verification completed:
  - `pnpm test:e2e tests/e2e/gateway-error-fidelity.e2e.spec.ts --workers=1`
  - `pnpm exec vitest run tests/features/gateway-error-fidelity.unit.test.ts tests/features/gateway-request-hygiene.unit.test.ts tests/features/provider-dialect.unit.test.ts`
  - `pnpm run lint`
  - `pnpm run typecheck`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 22 passing features re-verified.
- Gateway header transparency follow-up:
  - Root cause: Gateway only used Agent request headers for auth/CORS; JSON adapters rebuilt upstream headers from provider auth plus content-type, streaming kept only content-type, and adapter results did not carry provider response headers back to Gateway.
  - Gateway now filters inbound Agent headers with a denylist for auth/transport/body-owned headers, then forwards protocol headers through Chat Completions, Responses, Embeddings, and Messages JSON and streaming paths. Provider auth and JSON content-type remain Gateway-owned.
  - OpenAI-compatible adapters merge forwarded protocol headers with provider auth; OpenRouter attribution remains Gateway-owned. Anthropic adapters respect Agent `anthropic-version` and forward `anthropic-beta`. Claude Code subscription merges Agent beta flags with required subscription flags and de-dupes them.
  - Provider response headers are captured and returned for JSON and streaming success/error responses, excluding transport/body headers. Provider `x-request-id` / `request-id`, rate-limit headers, and `retry-after` can now reach Agents while Gateway correlation remains available as `x-llmingress-request-id`.
  - Exhausted provider 429s keep fallback first, then return the last provider 429 body/status/headers instead of a Gateway `provider_rate_limited` envelope.
- Gateway header transparency TDD red phase:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts tests/features/provider-dialect.unit.test.ts tests/features/gateway-error-fidelity.unit.test.ts` failed while the request-header helper was missing, OpenAI/Anthropic adapter inputs ignored protocol headers, and Claude Code beta/version headers were hardcoded.
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts tests/e2e/gateway-error-fidelity.e2e.spec.ts --workers=1` failed while provider response headers were replaced by Gateway headers and exhausted provider 429 returned a Gateway envelope.
- Gateway header transparency verification completed:
  - `pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts tests/features/provider-dialect.unit.test.ts tests/features/gateway-error-fidelity.unit.test.ts`
  - `pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts tests/e2e/gateway-error-fidelity.e2e.spec.ts --workers=1`
  - `pnpm run lint`
  - `pnpm run typecheck`
  - `pnpm run verify`
  - `pnpm run verify:features` passed with all 22 passing features re-verified. The optimized E2E batch had one parallel `v1-gateway-routing` miss, then the built-in per-feature fallback passed and the command exited 0.
  - `git diff --check`
  - `jq empty feature_list.json`
- Subscription-header regression fix (Claude Code streaming x-api-key leak):
  - Root cause: streaming `messages` payload builder injects `x-api-key: <credential>` (`packages/db/src/gateway-streaming.ts:631`, correct for generic Anthropic). The `claude_code` dialect changed from replace to merge (`packages/provider/src/dialect.ts`), and `buildClaudeCodeSubscriptionHeaders` never stripped it — so `claude_code` streaming sent `x-api-key: <oauth-token>` alongside the subscription `authorization: Bearer <oauth-token>`, breaking CLI impersonation fidelity and risking a provider 401. Confirmed by an empirical dialect+builder header trace.
  - Fix: `buildClaudeCodeSubscriptionHeaders` (`packages/provider/src/subscription.ts`) strips `x-api-key` from forwarded headers before merging impersonation headers (new local `stripHeader` reusing `removeHeader`). `authorization` already belonged to the impersonation set (merged last, so it wins) and codex never receives `x-api-key`, so line 631 and the codex builder stay untouched (surgical).
  - Not affected: non-streaming Claude Code (its headers come from the ingress denylist where `x-api-key` is already stripped) and Codex streaming (injects `authorization`, not `x-api-key`).
  - TDD: red `provider-dialect` unit failed with `expected 'claude-oauth-token' to be undefined`, then went green.
  - Verification: `pnpm exec vitest run tests/features/provider-dialect.unit.test.ts tests/features/gateway-request-hygiene.unit.test.ts`, empirical streaming header trace (x-api-key absent, Bearer + merged betas intact), `pnpm run verify`, and `pnpm run verify:features` passed with all 22 passing features re-verified (optimized E2E batch flaked once, then per-feature fallback passed).

## 2026-07-08 Code Quality Hardening Baseline

- Worktree: `.claude/worktrees/code-quality-hardening` on branch `worktree-code-quality-hardening`.
- Baseline green before new scope: `pnpm install && pnpm run verify` exited 0.
- Feature regression baseline: `pnpm run verify:features` exited 0 with all 22 passing features re-verified. The optimized E2E batch missed one `v1-gateway-routing` activity row, then the built-in per-feature fallback passed.

## 2026-07-08 Code Quality Hardening Completion

- Traceback: `docs/superpowers/plans/2026-07-08-code-quality-hardening.md`, covering the confirmed findings from the 2026-07-08 architecture audit.
- `gateway-listen-host`: Gateway now binds `127.0.0.1` by default through `gatewayListenHost`, honors `GATEWAY_HOST`, and Docker explicitly opts into `0.0.0.0`.
- `db-connection-hygiene`: Provider/worker DB paths use the shared pool, pool/release failures are logged, gateway/worker shutdown closes pools, and the runtime-status filename no longer stutters.
- `console-api-hygiene`: Console API routes share `withConsoleAuth`, unexpected action errors return sanitized 500 responses, and the agent-created HTML page is extracted.
- `console-sections-split`: Dashboard sections are split into 11 bounded modules; `sections.tsx` now holds only shared helpers under budget, and page/static tests were updated to the new module boundaries.
- Regression note: `console-shared-formatters` E2E timestamp seeding was stabilized after a local-midnight boundary exposed a test-only assumption; focused unit+E2E passed after the fix.
- Verification: `pnpm run verify` passed, and `pnpm run verify:features` passed with all 26 passing features re-verified.
- Blockers: none open.

## 2026-07-09 Architecture Hardening

- Worktree: `.claude/worktrees/arch-hardening` on branch `worktree-arch-hardening`.
- Baseline: `pnpm install` passed. `pnpm run db:migrate` needs explicit process env in this shell; reran with `DATABASE_URL`, `TEST_DATABASE_URL`, and `MASTER_KEY`, applied 0 migrations and skipped 6. `pnpm run verify` passed. `pnpm run verify:features` passed with all 26 passing features re-verified.
- [x] 批次 0 sharedE2E guard map 完成
- [x] 批次 1 refactor-route-strategy-registry 完成
- [x] 批次 2 refactor-notification-transport-registry 完成
- [x] 批次 3 refactor-price-row-mappers 完成
- [x] 批次 4 refactor-agent-limit-domain-types 完成
- [x] 批次 5 refactor-config-ownership 完成
- [x] 批次 6 refactor-db-row-strict-types 完成
- [x] 批次 7 refactor-filter-excess-property 完成
- [x] 批次 8 refactor-zod-boundaries 完成
  - New E2E covers invalid `/api/route-policies/preview` JSON after Console login. The valid-preview E2E was not added because the donor Console fixture only provides startup/login scaffolding and no route-policy data fixture.
- [x] 批次 9 refactor-branded-ids 完成
  - `pnpm run verify:features` optimized E2E batch failed once, then the built-in per-feature fallback passed and the command exited 0.
- [x] 批次 10 refactor-provider-descriptor 完成
- [x] 批次 11 refactor-shared-logger 完成
  - Added `packages/logging` as the shared pino wrapper, replaced bare `console.log/error/warn` in apps/packages source with component loggers, and enabled Biome `suspicious/noConsole` with test-file override.
  - Verification passed: focused unit, lint, typecheck, `pnpm run verify`, and `pnpm run verify:features` with all 37 passing features re-verified.
- [x] 批次 12 console-section-data-split 完成
  - Extracted Agents section's five sequential data reads into `_modules/agents-section-data.ts`; Playground response body locals are explicitly typed `unknown`.
  - Verification passed: focused unit, `v1-console` E2E, typecheck, and `pnpm run verify`. `pnpm run verify:features` optimized E2E batch missed one `v1-gateway-routing` activity row, then the built-in per-feature fallback passed and the command exited 0 with all 38 passing features re-verified.
- [x] 批次 13a refactor-db-package-split worker-runtime 完成
  - Moved all 19 `worker-*` modules from `packages/db` into `packages/worker-runtime`, rewrote worker imports and test paths, removed db worker exports, and kept `refactor-db-package-split` status `failing` until 13b.
  - Verification passed: `pnpm run verify` and `pnpm run verify:features` with all 38 currently passing features re-verified.
- [x] 批次 13b refactor-db-package-split gateway-runtime 完成
  - Moved all 26 `gateway-*` modules from `packages/db` into `packages/gateway-runtime`, rewrote gateway imports and test paths, removed db gateway exports, localized `llmingressDbPoolMax` in db client, and updated architecture module-boundary guidance.
  - Verification passed: focused unit, `v1-gateway-routing` E2E, `v1-worker-ops` E2E, `pnpm run verify`, and `pnpm run verify:features` with all 39 passing features re-verified.
- Final completed feature ids: `refactor-route-strategy-registry`, `refactor-notification-transport-registry`, `refactor-price-row-mappers`, `refactor-agent-limit-domain-types`, `refactor-config-ownership`, `refactor-db-row-strict-types`, `refactor-filter-excess-property`, `refactor-zod-boundaries`, `refactor-branded-ids`, `refactor-provider-descriptor`, `refactor-shared-logger`, `console-section-data-split`, `refactor-db-package-split`.
- Final verification passed: `pnpm run verify` and `pnpm run verify:features` with all 39 passing features re-verified.
- Deferred non-blocker from scope ruling: `console-provider-templates.ts` template casts remain because each cast is guarded by provider-template id set membership; full typed template-map cleanup is a separate future refactor.
- Implementation complete; waiting for human review before merging back to `dev`.
- Blockers: none open.

## 2026-07-10 Architecture Hardening Merge-Readiness Repairs

- Fixed DB bootstrap URL resolution: `readPostgresDatabaseUrl` now reads only `databaseUrl` from `LLMINGRESS_BOOTSTRAP_CONFIG`; full runtime bootstrap config parsing remains strict for Gateway/Console/Worker startup.
- Fixed route-preview validation ordering: blank `virtualModelId` now reports the id error before missing token fields, and the duplicate unreachable schema refine was removed.
- Fixed `refactor-shared-logger` shared E2E mapping: release guard and `feature_list.json` now point to `tests/e2e/v1-gateway-routing.e2e.spec.ts`.
- Deferred debt: provider descriptor/template duplicate facts, worker-runtime's unused logging dependency, compatibility re-exports with no direct consumers, repeated `listSourceFiles` test helpers, and small zod helper duplication.
- Verification passed: `pnpm exec vitest run tests/features/refactor-zod-boundaries.unit.test.ts tests/features/v1-release-guards.unit.test.ts`, `pnpm test:e2e tests/e2e/v1-gateway-routing.e2e.spec.ts`, `pnpm run verify`, and `pnpm run verify:features` with all 39 passing features re-verified.
- Blockers: none open.

## Required Verification

Use the local PostgreSQL test database:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run db:migrate:check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify:features
```

## Operational Note

Existing local/dev databases created before this compression should be dropped and recreated. The single baseline is a pre-release reset path, not an upgrade path for already-used installations.
