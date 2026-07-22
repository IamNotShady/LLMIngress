# LLMIngress Product Scope

This document is the V1 support boundary. A surface not listed as supported is not part of the
release unless it is added here with code and verification.

## Supported

### Gateway protocols

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `GET /v1/models`

Each API key carries a dedicated `llmi_` secret and may access only its granted Virtual
Models. Provider payloads remain protocol-native; Gateway replaces the Virtual Model name with
the selected Provider model and does not log prompts, successful responses, or tool arguments.

### Providers and models

Supported Provider types are API Key, Subscription OAuth, and Local. Current templates are:

- Subscription: OpenAI Codex, Claude Code
- API Key: Google Gemini, OpenRouter, DeepSeek, xAI, Qwen, Moonshot/Kimi, MiniMax, Z.ai, GLM Coding Plan, Qwen Token Plan, Kimi Coding Plan
- Local: Ollama, LM Studio, llama.cpp

The three coding-plan templates are paste-key (`api_key`) providers that connect the same
way as any API key, but they are distinct from the similarly named base templates by base
path and/or protocol, so do not confuse them in Console:

- GLM Coding Plan (`glm_coding`) — OpenAI Chat Completions at `https://api.z.ai/api/coding/paas/v4`, versus Z.ai (`zai`) at `https://api.z.ai/api/paas/v4` (`/coding/` segment differs). Upstream quota is reported (it reuses Z.ai's monitor endpoint).
- Qwen Token Plan (`qwen_token_plan`) — OpenAI Chat Completions at `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`, versus Qwen (`qwen`) at `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (different host). No Chat Completions Responses endpoint; upstream quota is not reported.
- Kimi Coding Plan (`kimi_coding`) — Anthropic Messages protocol with `x-api-key` at `https://api.kimi.com/coding/v1`, versus Moonshot/Kimi (`moonshot`) which is OpenAI Chat Completions at `https://api.moonshot.ai/v1`. Upstream quota is reported from a separate `Bearer`-authenticated usage endpoint.

Console supports Provider lifecycle, multiple API keys, OAuth, model refresh, dependency-protected
deletion, and connection checks. Model metadata may be merged from Provider APIs, models.dev,
OpenRouter, LiteLLM, and Vercel; missing values remain unknown and manual values take precedence.
Known embedding-only models remain stored as Provider metadata but are hidden from Console model
catalogs and cannot be selected for Gateway routes.

Health belongs to a Provider connection: each API key or OAuth token is independent, while a Local
Provider has one logical connection. Worker probes up to three chat models. The sparse
`provider_health_summary` contains only unhealthy connections; recovery deletes the row.

### Virtual Model routing

A Virtual Model is created atomically with one Route Policy and at least one candidate. Supported
strategies are `fixed`, `cost_first`, and `load_balance`. `cost_first` orders by input price plus output
price and places unknown prices last. Known capability values must agree across candidates;
unknown values skip only the corresponding request pre-check.

Before the first client byte, Gateway may try another credential or candidate. After streaming
starts, it never replays the request. Confirmed unhealthy connections are filtered; models and
Providers do not have independent health state.

### API keys, limits, and accounting

API key creation atomically stores its secret, Virtual Model grants, optional default model, Limits
switch, and initial rules. Disabling an API key preserves its configuration. Disabling Limits
preserves rules and skips all limit reads and enforcement.

Supported rules are budget, RPM, TPM, concurrency, and per-request token limits. Supported
operational records are request metadata, latency, status, token usage, actual or estimated cost,
fallback attempts, and Provider-connection health history.

### Console, Worker, and health

Supported Console pages are Overview, API Keys, Providers, Virtual Models, Activity, Usage, Limits,
and Playground. Password setup, session authentication, stable operation errors, and secret
encryption are required.

Persistent Worker jobs are exactly `model_refresh`, `provider_connection_probe`, `price_sync`, and
`provider_quota_probe`.
Retention and stale-concurrency repair run directly under PostgreSQL advisory locks and do not
create jobs.

Gateway exposes `/health/live`, `/health/ready`, and the readiness-compatible `/health` alias.

Self-hosted beta deployments use repository Docker Compose: one app container (multi-role image)
plus one PostgreSQL 18.4 container.

## Unsupported

V1 does not include:

- Runtime, Settings, or standalone Routing pages
- notifications, alerts, Webhook delivery, or external exports
- database backup or restore workflows
- one-command remote installer or managed upgrade snapshots
- billing reconciliation or savings/baseline-cost reporting
- Prometheus metrics or OpenTelemetry tracing
- persisted runtime heartbeat, status, or error products
- `quality_first`, legacy route rules, API key modes, or request-logging switches
- configuration import/export or Route Preview APIs

The project is pre-release. `packages/db/migrations/` is authoritative: `0001_core_baseline.sql`
plus incremental migrations applied in order. Databases from development chains older than the
baseline squash are recreated rather than upgraded in place.
