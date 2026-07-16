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

- 2026-07-16: Compose two-container delivery (app + Postgres) — focused release/delivery suites, `pnpm run verify`, and `pnpm run verify:features` (9/9) passed.
- Compose path: `./scripts/deploy.sh` (generates `.env` `MASTER_KEY` when missing, then `docker compose up --build`).

## Latest changes

- README bilingual layout (AIRI-style): English `README.md` and Chinese `docs/README.zh-CN.md` with mutual language links.
- Compose runs exactly two long-lived services: `app` (`command: all`) and `postgres`. Entrypoint `all` migrates then supervises Gateway, Console, and Worker in one container. Single-role commands remain for advanced `docker run`.
- After API key save/enable and OAuth complete/enable, Console enqueues `model_refresh` alongside connection probes.
- Compose no longer ships a public default `MASTER_KEY`. `./scripts/deploy.sh` writes a random key into `.env` when missing.
- Removed one-command `install.sh` delivery; Compose remains the supported self-hosted path.
- `/v1/embeddings` remains retired; embedding model metadata remains supported and embedding-only catalog entries stay hidden.

## Blockers

- None.
