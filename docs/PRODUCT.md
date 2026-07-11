# LLMIngress Product

LLMIngress is a self-hosted AI Gateway for routing AI Agent requests across real model
providers while enforcing usage limits and recording operational usage metadata.

## Product Scope

LLMIngress intentionally concentrates on four capabilities:

1. Provider and real-model management.
2. Virtual Model routing, health filtering, and fallback.
3. Agent authentication, permissions, rate limits, budgets, and concurrency limits.
4. Activity, token usage, latency, failure, fallback, and actual-cost reporting.

Alert delivery, notification channels, operational exports, database backup, billing
reconciliation, Prometheus metrics, and OpenTelemetry tracing are not product features.

## Gateway

Agents authenticate with a dedicated `llmi_` API key and call one of:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/embeddings`
- `GET /v1/models`

The Gateway identifies the Agent, checks its Virtual Model grant and limits, resolves the
Virtual Model, builds a deterministic fallback chain, calls real Providers, and records
metadata after completion. Provider request bodies remain opaque and are never written to
operational logs.

Supported routing strategies are:

- `fixed`
- `cost_first`
- `random`

Provider and model health can remove unhealthy candidates. Failure before the first client
byte may advance through credentials or fallback candidates. Failure after bytes have been
sent is never replayed.

## Providers and Models

Provider types:

- API Key Provider
- Subscription OAuth Provider
- Local Provider

The Console supports provider creation, enable/disable, dependency-protected deletion,
multiple API keys, subscription OAuth, connectivity checks, and model refresh.

Model metadata can come from the Provider API, models.dev, OpenRouter, LiteLLM, and Vercel.
Users can manually resolve missing or conflicting capability and price data.

The stable model capability contract contains:

- input modalities
- output modalities
- maximum context tokens
- maximum output tokens
- function calling support
- reasoning support

All candidates in one Virtual Model must have complete and identical values for these
fields. The Gateway rejects requests outside the contract before calling a Provider.

## Agents and Limits

Each Agent has:

- a unique API key
- an enabled state
- allowed Virtual Models
- an optional default Virtual Model
- optional budget, RPM, TPM, concurrency, and per-request token limits

Limits are enforcement controls. They do not generate alerts or external notifications.

## Usage and Activity

LLMIngress records metadata required for operations and accounting:

- request id and Agent
- protocol and Virtual Model
- selected Provider and model
- status, error category, and latency
- input/output/total tokens
- actual or estimated cost and price source
- fallback attempts and Provider health events

Prompt content, response content, tool arguments, credentials, cookies, and authorization
headers are never written to operational logs.

Console reporting includes request count, tokens, latency, failure rate, actual/estimated
cost, fallback history, and Provider health history.

## Console

The retained Console pages are:

- Overview
- Agents
- Providers
- Virtual Models
- Activity
- Usage
- Limits
- Playground

Console authentication, first-run setup, CSRF origin checks, stable operation errors, and
secret encryption remain required.

## Worker

Persistent Worker jobs are limited to:

- `model_refresh`
- `provider_connectivity_check`
- `price_sync`

Retention and stale-concurrency repair are idempotent internal maintenance operations and
must not generate persistent jobs during idle operation.

## Deployment

LLMIngress runs as Console, Gateway, Worker, and PostgreSQL services. Published ports bind
to loopback by default. Production deployment requires independent random values for the
master key, database password, and Console setup token.

Gateway health endpoints:

- `/health/live` for process liveness
- `/health/ready` for database and configuration readiness
- `/health` as a readiness-compatible alias

The project is pre-release. The current baseline schema is authoritative; old development
databases are recreated instead of upgraded in place.
