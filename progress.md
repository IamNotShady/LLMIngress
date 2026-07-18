# LLMIngress Development State

Updated: 2026-07-18 · Branch: `dev` · Version: V1 released; post-release development open

## Feature domains

Core Platform Security; Provider Model Management; Virtual Model Routing; Gateway Protocol Execution; Agent Access and Limits; Usage and Activity; Worker Model Operations; Console Core; Delivery Quality; Agent Integration Guidance.

## Baseline

- Console pages: Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, Playground.
- Public protocols: Chat Completions, Responses, Messages, and model discovery.
- Worker jobs: `model_refresh`, `provider_connection_probe`, `price_sync`.
- Database: PostgreSQL 18.4 Alpine; migrations start from `0001_core_baseline.sql` and new migrations are expected post-V1.
- Deployment: Docker Compose with two containers — one multi-role app (`all`: migrate then Gateway/Console/Worker) plus PostgreSQL.

## Latest verification

- 2026-07-18: Route policy `random` → `load_balance` rename + DB constraint removal — TDD unit (domain shuffle, code-layer accept/reject contract, migration manifest), `pnpm run verify` (318 unit tests + build), console-layout & virtual-model-routing E2E, and `verify:features` (10/10) passed.
- 2026-07-17: Agent integration guidance — focused unit (5) + E2E (1, incl. 1280 two-column side-by-side, 390 stacked, no-overflow with the detail dialog open), `pnpm run verify`, and `verify:features` (10/10, zero regression) passed.
- 2026-07-17: Release-freeze guard removal — focused delivery-quality unit (26) + E2E (6) suites, `pnpm run verify` (317 unit tests, coverage above thresholds), and `verify:features` (9/9) passed on the rebased dev baseline.
- 2026-07-16: Multiple providers per provider type — provider_key uniqueness removed; provider unit+E2E suites, `pnpm run verify`, and `verify:features` (9/9) passed.
- 2026-07-16: Provider list collapse — default fully collapsed, row click toggles, Model library hidden until a provider is selected; `pnpm run verify` and `verify:features` (9/9) passed.
- 2026-07-16: Route-policy capability mismatch clarity — informative error values + precise context display; `pnpm run verify` and `verify:features` (9/9) passed.

## Latest changes

- Renamed route policy strategy `random` → `load_balance` (display label "Load Balance"); serialized identifier changed end-to-end (domain union + dispatch key, db const/validation, console UI labels + strategy default, activity label map). The DB `route_policies_strategy_check` CHECK constraint was dropped — the allowed-value set now lives only in the code layer (`routePolicyStrategies` / `isRoutePolicyStrategy`). Migration `0002_route_policy_load_balance.sql` drops the constraint, renames existing `route_policies` rows, and backfills `request_activity.route_policy_strategy_snapshot` + `route_reason.strategy`. Decision message reads "load balance route for …".
- Agent Integration Guidance shipped (10th feature): Integration Platform UI removed (`agents.integration_platform` stays as inert metadata defaulting `'other'`); Agent detail dialog is a wide two-column view (fields/limits · endpoint groups) with full-width 8-platform guide tabs shared with the create flow and one-time page.
- Integration guides fact-checked against official docs (2026-07-17): GitHub Copilot rewritten (VS Code Custom Endpoint + Copilot CLI env vars), Cursor reachability and chat-only caveats, OpenCode `/connect` detail + `$schema`, Claude Code `ANTHROPIC_DEFAULT_HAIKU_MODEL`, and per-tool endpoint-protocol notes; other guides verified accurate.
- Removed V1 release-freeze guards: feature-list/suite-mapping pins, progress.md line cap, single-migration/24-table freeze, retired-surface absence checks, PostgreSQL image pin, Compose boot check. Real behavior tests remain under the renamed `delivery-quality` suites (9th feature renamed from `release-guards`).
- Providers are no longer unique per provider type/key: users can create any number of same-type providers with any display name and base URL; provider type only determines the wire protocol.
- Provider list expansion is driven only by the `selected` URL param: `/providers` defaults to fully collapsed, clicking the expanded row collapses it, and the Model library card renders only while a provider is selected.
- Renamed secret env/config from `MASTER_KEY` / `MASTER_KEY_FILE` to `ENCRYPTION_KEY` / `ENCRYPTION_KEY_FILE`. Provider secret crypto remains AES-256-GCM.
- `/v1/embeddings` remains retired; embedding model metadata remains supported.

## Blockers

- None.
