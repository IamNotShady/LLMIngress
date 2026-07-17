# LLMIngress Development State

Updated: 2026-07-17 · Branch: `dev` · Version: V1 released; post-release development open

## Feature domains

Core Platform Security; Provider Model Management; Virtual Model Routing; Gateway Protocol Execution; Agent Access and Limits; Usage and Activity; Worker Model Operations; Console Core; Delivery Quality; Agent Integration Guidance.

## Baseline

- Console pages: Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, Playground.
- Public protocols: Chat Completions, Responses, Messages, and model discovery.
- Worker jobs: `model_refresh`, `provider_connection_probe`, `price_sync`.
- Database: PostgreSQL 18.4 Alpine; migrations start from `0001_core_baseline.sql` and new migrations are expected post-V1.
- Deployment: Docker Compose with two containers — one multi-role app (`all`: migrate then Gateway/Console/Worker) plus PostgreSQL.

## Latest verification

- 2026-07-17: Agent integration guidance — focused unit (5) + E2E (1, incl. 1280/390 no-overflow with the detail dialog open), `pnpm run verify` (13/13 tasks), and `verify:features` (9/9 legacy, zero regression) passed.
- 2026-07-17: Release-freeze guard removal — focused delivery-quality unit (26) + E2E (6) suites, `pnpm run verify` (317 unit tests, coverage above thresholds), and `verify:features` (9/9) passed on the rebased dev baseline.
- 2026-07-16: Multiple providers per provider type — provider_key uniqueness removed; provider unit+E2E suites, `pnpm run verify`, and `verify:features` (9/9) passed.
- 2026-07-16: Provider list collapse — default fully collapsed, row click toggles, Model library hidden until a provider is selected; `pnpm run verify` and `verify:features` (9/9) passed.
- 2026-07-16: Route-policy capability mismatch clarity — informative error values + precise context display; `pnpm run verify` and `verify:features` (9/9) passed.

## Latest changes

- Integration Platform selection removed from Agent create/edit/filter/detail UI; the `agents.integration_platform` column stays as inert metadata (defaults `'other'`, no migration; saveAll resets it to `'other'`).
- Agent detail dialog now shows an Endpoints section (allowed Virtual Models grouped by their route policy endpoint URL from `GATEWAY_URL`; unrouted VMs flagged) and an Integration guide section with tabs for all 8 platforms (placeholder key + stored key prefix). The create-success dialog and one-time HTML page reuse the same guides with the plaintext key.
- Removed V1 release-freeze guards: feature-list/suite-mapping pins, progress.md line cap, single-migration/24-table freeze, retired-surface absence checks, PostgreSQL image pin, Compose boot check. Real behavior tests remain under the renamed `delivery-quality` suites (9th feature renamed from `release-guards`).
- Providers are no longer unique per provider type/key: users can create any number of same-type providers with any display name and base URL; provider type only determines the wire protocol.
- Provider list expansion is driven only by the `selected` URL param: `/providers` defaults to fully collapsed, clicking the expanded row collapses it, and the Model library card renders only while a provider is selected.
- Renamed secret env/config from `MASTER_KEY` / `MASTER_KEY_FILE` to `ENCRYPTION_KEY` / `ENCRYPTION_KEY_FILE`. Provider secret crypto remains AES-256-GCM.
- `/v1/embeddings` remains retired; embedding model metadata remains supported.

## Blockers

- None.
