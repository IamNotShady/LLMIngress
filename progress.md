# LLMIngress Current State

Updated: 2026-07-12
Branch: `dev`

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
- Virtual Models atomically require a Route Policy and candidate; capabilities reject only known
  conflicts, and `cost_first` uses input-plus-output price with unknown prices last.
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
- Provider model capability refresh now keeps the first available value by source priority and no longer computes conflicts that erase explicit values; the current OpenAI Codex model catalog was refreshed and restored GPT-5.4-Mini and GPT-5.5 to 272K context.
- Successful Provider connectivity checks now restore the selected probe model's health as well as the Provider health. The current GPT-5.4-Mini route candidate was recovered from `unhealthy` to `healthy`, so it is no longer removed from the fallback chain.
- Gateway fallback failures log the complete Provider response body, response headers, status, Provider, model, and request ID without logging the outbound request or credentials. Provider HTTP 400 failures remain request-level errors and do not change Provider or model health.
- Responses now has a strict boundary: Playground sends canonical list input, Gateway rejects string input before routing, and Codex adapters no longer force `store`/`stream`, remove parameters, rewrite input, or bridge SSE into non-streaming JSON. Claude Code Messages retains its required Agent SDK system identity.
- Provider API Key creation now stays on the Providers page and shows the one-time plaintext in the shared native dialog; closing the dialog returns to the refreshed key list instead of leaving users on a standalone HTML page.
- Gateway Provider dispatch now strips browser `Origin`, `Referer`, browser `User-Agent`, and all `Sec-*` headers while preserving protocol headers. The Claude Code Subscription adapter retains `anthropic-dangerous-direct-browser-access: true` because the official Claude Code CLI sends it; removing the forwarded browser Origin fixes the Organization CORS rejection without changing Subscription identity.
- Console mutation forms now submit with same-origin fetch and keep API failures in the current screen or dialog. Structured errors with a field render as red text beside that input; Provider delete races and other operation-level conflicts render inline instead of navigating to raw JSON.
- Provider relative timestamps use one server-generated reference timestamp, removing the `49 min ago` / `50 min ago` hydration mismatch. Virtual Model deletion now checks only Agent default/grant usage and transactionally retires its owned Route Policy.
- Every Provider probe now runs as one composite model-refresh handler: Provider HTTP completes first, then one short transaction revalidates the Provider/credential snapshot and atomically commits model changes plus Provider/model health. Legacy connectivity jobs call the same handler, Job-ID retries are idempotent, and Gateway paired health writes use the same atomic DB API.
- Console desktop navigation now uses a 280px sidebar with 15px labels. Activity and Limits share the same 1600px content boundary as Providers and Virtual Models, and Activity pagination now returns 20 requests per page.
- Playground treats Temperature, Top P, and Max Tokens as optional request values. Clearing any of these inputs now omits the corresponding `temperature`, `top_p`, or `max_tokens` property instead of substituting a default and sending it to Gateway.
- Agent creation now renders the selected/default Virtual Model name in the one-time connection dialog instead of `<Virtual Model Name>`. The Virtual Models search input now tolerates pre-hydration browser caret-color mutations without a hydration error.
- Agent creation now requires an Allowed Virtual Model and atomically commits the Agent, API key, model grants, optional default, explicit Limits switch, and rules. Default choices follow the selected grants, while the one-time result shows the API key, Gateway URL, and platform-specific connection guidance.
- Gateway now treats `agents.limits_enabled` as the sole Limits switch and performs no Limits database work while it is false. Disabling Limits preserves its rules. Agent Enable/Disable preserves the same API key and configuration, and the Agents list now shows Virtual Model names and Enabled state without the dynamic Status or Available VM columns.
- Limits lists/KPIs include only active Agents with Limits enabled, while saved rules remain restorable; rows now expose Edit only, with delete UI removed.

## Verification

Final 2026-07-12 result: focused Agent/Limits unit/database/Console E2E, isolated live-browser
QA, `pnpm run db:migrate:check`, and `pnpm run verify` passed with 62 files/327 tests.
All 9 milestones passed `pnpm run verify:features`. Coverage is 49.17% statements,
49.34% lines, 41.84% branches, and 52.05% functions.

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
