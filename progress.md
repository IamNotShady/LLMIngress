# LLMIngress Current State

Updated: 2026-07-11
Branch: `codex/high-priority-hardening`

## Product Scope

LLMIngress is a self-hosted AI Gateway focused on four capabilities:

1. Provider credentials and real-model management.
2. Virtual Model routing, health filtering, and fallback.
3. Agent authentication, grants, rate/token/budget/concurrency limits.
4. Activity, usage, token, latency, failure, fallback, health, and request-cost reporting.

The supported public protocols are Chat Completions, Responses, Anthropic Messages, and
Embeddings. Operational logs are metadata-only and never contain prompts, response content, or
tool arguments.

## Core Runtime

- Console pages: Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, Playground.
- Route strategies: `fixed`, `cost_first`, `random`.
- Virtual Model candidates must share the complete six-field capability contract.
- Gateway exposes `/health/live`, `/health/ready`, and readiness-compatible `/health`.
- Worker persistent jobs: `model_refresh`, `provider_connectivity_check`, `price_sync`.
- Stale concurrency and retention run directly under PostgreSQL advisory locks and create no jobs.
- Database: one pre-release `0001_core_baseline.sql` with 24 tables including migration history.

## Removed Scope

Alerts, notifications, Webhook delivery, operational export, database backup, billing
reconciliation, Runtime/Settings pages, Prometheus metrics, OpenTelemetry tracing, Runtime status
and error persistence, Route Preview, standalone Routing UI, `quality_first`, legacy route rules,
Agent type/request-logging switches, and savings/baseline-cost reporting are intentionally absent.

## Delivery Progress

- `6c5343e2` — removed non-core Worker operations.
- `1427fa01` — removed external observability and added real readiness.
- `633f270b` — simplified routing, Agents, and cost reporting.
- `e844f2a6` — removed maintenance Job churn and added direct locked retention.
- `36b57799` — compressed the pre-release schema and project history to one baseline and nine milestones.
- `c16fed90` — added shared pooling, parallel Console reads, compact KPIs, correct Usage dates, and server-paginated models.
- Core delivery hardening is implemented: native accessible dialogs, strict migration CLIs, four compiled non-root runtime images, and enforced JSON coverage thresholds.
- Post-slimming Console audit completed across all eight retained pages: fresh installs now show the core Provider → Virtual Model → Agent → Playground path, empty states link to their prerequisites, and the sidebar no longer implies Gateway readiness without a health signal.

## Verification

Final 2026-07-11 result: migration check passed, `pnpm run verify` passed with 60 test files
and 304 tests, and `pnpm run verify:features` re-verified all 9 milestones. Coverage is
48.14% statements, 48.28% lines, 40.81% branches, and 50.83% functions.

Database-backed checks use:

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run db:migrate:check
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres' pnpm run verify:features
```

Existing development databases from the historical migration chain must be recreated. This is a
pre-release baseline reset and does not support in-place upgrade from the former 0001-0010 chain.

## Open Work

No accepted core-slimming feature remains. Blockers: none.
