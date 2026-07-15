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

- 2026-07-15: `vitest` platform-security (MASTER_KEY/deploy/setup-token cases) + release-guards Compose path — passed. DB-backed cases need local `TEST_DATABASE_URL` (postgres auth failed in this session).
- Compose path: `./scripts/deploy.sh` (generates `.env` `MASTER_KEY` when missing, then `docker compose up --build`).

## Latest changes

- Compose no longer ships a public default `MASTER_KEY`. `./scripts/deploy.sh` writes a random key into `.env` when missing, then runs `docker compose up --build`. PostgreSQL password remains the compose literal `llmi-local-db` embedded in the default `DATABASE_URL` (no user-facing `POSTGRES_PASSWORD`).
- Removed production weak-`MASTER_KEY` refusal / `LLMINGRESS_ALLOW_INSECURE_DEFAULT_MASTER_KEY` transitional guard.
- Removed one-command `install.sh` delivery; Compose remains the supported self-hosted path.
- `/v1/embeddings` remains retired; embedding model metadata remains supported and embedding-only catalog entries stay hidden.

## Blockers

- None.
