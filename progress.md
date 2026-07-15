# LLMIngress V1 Release State

Updated: 2026-07-15 · Branch: `dev` · Version: V1 pre-release baseline with Compose delivery

## Release domains

Core Platform Security; Provider Model Management; Virtual Model Routing; Gateway Protocol Execution; Agent Access and Limits; Usage and Activity; Worker Model Operations; Console Core; Release Guards.

## Baseline

- Console pages: Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, Playground.
- Public protocols: Chat Completions, Responses, Messages, and model discovery.
- Worker jobs: `model_refresh`, `provider_connection_probe`, `price_sync`.
- Database: PostgreSQL 18.4 Alpine with `0001_core_baseline.sql`, 23 product tables plus migration history (24 total).
- Deployment: repository Docker Compose with one multi-role application image plus separate PostgreSQL.
- Historical removal/refactor tests are consolidated into current domain suites and release guards.

## Latest verification

- Compose smoke (no secret exports): `docker compose down -v` then `docker compose up --build` — migrate 0, gateway/console HTTP 200.
- `platform-security` unit (incl. compose local-default guards): 30 passed.

## Latest changes

- Compose local defaults: `MASTER_KEY` defaults to `llmi-local-master`; PostgreSQL password is the compose literal `llmi-local-db` embedded in the default `DATABASE_URL` (no user-facing `POSTGRES_PASSWORD`). Quick start is `docker compose up --build` with no secret exports.
- Removed one-command `install.sh` delivery; Compose remains the supported self-hosted path.
- `/v1/embeddings` remains retired; embedding model metadata remains supported and embedding-only catalog entries stay hidden.

## Blockers

- None.
