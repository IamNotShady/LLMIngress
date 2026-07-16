# LLMIngress V1 Release State

Updated: 2026-07-16 · Branch: `dev` · Version: V1 pre-release baseline with Compose delivery

## Release domains

Core Platform Security; Provider Model Management; Virtual Model Routing; Gateway Protocol Execution; Agent Access and Limits; Usage and Activity; Worker Model Operations; Console Core; Release Guards.

## Baseline

- Console pages: Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, Playground.
- Public protocols: Chat Completions, Responses, Messages, and model discovery.
- Worker jobs: `model_refresh`, `provider_connection_probe`, `price_sync`.
- Database: PostgreSQL 18.4 Alpine with `0001_core_baseline.sql`, 23 product tables plus migration history (24 total).
- Deployment: Docker Compose with two containers — one multi-role app (`all`: migrate then Gateway/Console/Worker) plus PostgreSQL.
- Historical removal/refactor tests are consolidated into current domain suites and release guards.

## Latest verification

- 2026-07-16: Provider list collapse — default fully collapsed, row click toggles, Model library hidden until a provider is selected; `pnpm run verify` and `verify:features` (9/9) passed.
- 2026-07-16: Route-policy capability mismatch clarity — informative error values + precise context display; `pnpm run verify` and `verify:features` (9/9) passed.
- 2026-07-16: Renamed `MASTER_KEY` → `ENCRYPTION_KEY` (AES-256-GCM unchanged) — lint, typecheck, unit tests (334), and build passed via `pnpm run verify`.
- Compose path: `./scripts/deploy.sh` (generates `.env` `ENCRYPTION_KEY` when missing, then `docker compose up --build`).

## Latest changes

- Provider list expansion is driven only by the `selected` URL param: `/providers` defaults to fully collapsed, clicking the expanded row collapses it, and the Model library card renders only while a provider is selected.
- Route-policy capability mismatch errors name the exact conflicting values (e.g. `maxContextTokens` 1000000 vs 1048576); the Virtual Model route dialog shows precise grouped token counts (e.g. `1,048,576`) so near-identical context windows are distinguishable.
- Renamed secret env/config from `MASTER_KEY` / `MASTER_KEY_FILE` to `ENCRYPTION_KEY` / `ENCRYPTION_KEY_FILE` (and matching code symbols). Provider secret crypto remains AES-256-GCM.
- Compose runs exactly two long-lived services: `app` (`command: all`) and `postgres`. Entrypoint `all` migrates then supervises Gateway, Console, and Worker in one container. Single-role commands remain for advanced `docker run`.
- Compose no longer ships a public default `ENCRYPTION_KEY`. `./scripts/deploy.sh` writes a random key into `.env` when missing.
- Removed one-command `install.sh` delivery; Compose remains the supported self-hosted path.
- `/v1/embeddings` remains retired; embedding model metadata remains supported and embedding-only catalog entries stay hidden.
- Beta promo pass: README link line to llmingress.ai, landing copy aligned to PRODUCT.md scope; `docs/marketing/` is gitignored local-only.

## Blockers

- None.
