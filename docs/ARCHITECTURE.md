# LLMIngress Architecture Design

> This document derives the target architecture for Gateway Service and Console
> from `docs/PRODUCT.md`. It focuses on architecture boundaries, module
> responsibilities, technology choices, data storage, and project layout. It
> does not describe implementation details.

## 1. Architecture Goals

LLMIngress is a single-user, self-hosted AI Agent Gateway. Product-wise, it has
two core planes:

- Gateway Service: the data plane. It receives AI Agent requests and performs
  authentication, budget checks, route decisions, provider forwarding, fallback,
  and usage recording.
- Console: the control plane. It manages configuration, runtime status,
  Activity / Usage views, budget and rate-limit settings, and onboarding.

Runtime also needs a background task plane:

- Background Worker / Scheduler: the asynchronous task plane. It handles alert
  evaluation, notification delivery, model discovery, price sync, billing
  reconciliation, log retention, JSONL / webhook export, scheduled backup, and
  maintenance tasks.

Core design constraints:

- AI Agents call Gateway Service directly. They do not call Console directly.
- Console changes Gateway runtime configuration. It does not process Agent model
  request traffic.
- Console does not directly call real providers. Provider egress calls belong
  to the Gateway request path or Background Worker asynchronous tasks.
- Gateway uses the latest configuration for new requests. In-flight requests
  keep the configuration snapshot captured when they entered processing.
- Gateway can continue processing requests while Console is unavailable, as
  long as it has a usable configuration snapshot, database connection, and
  usable secret master key.
- Background Worker is not in the AI Agent synchronous request path. Worker
  downtime only delays asynchronous capabilities and must not block Gateway from
  handling new requests.
- The default target is local or single-node self-hosted deployment. Multi-tenant
  SaaS is not a V1 architecture goal.
- V1 assumes one active Gateway process per deployment. Multiple Gateways are a
  future extension and require moving RPM / TPM / concurrency runtime counters
  to shared state first.

## 2. TypeScript Stack Choices

LLMIngress uses TypeScript across Gateway, Console, and shared domain models to
reduce protocol, configuration, and data-shape drift between frontend and
backend.

| Layer | Choice | Purpose |
| --- | --- | --- |
| Monorepo | pnpm workspace + Turborepo | Manage Gateway, Console, Worker, and shared packages with package-level builds and reuse |
| Runtime | Node.js | Run Gateway, Console API, background tasks, and CLI tools |
| Gateway Service | Fastify | Host high-throughput Public API, streaming responses, and plugin-style request pipeline |
| Console Web | Next.js App Router + React, Node runtime | Build the management Console, SSR pages, Console API routes, and a long-lived Node process for Postgres listeners or polling |
| Background Worker | Node.js worker process + database-backed scheduler | Run scheduled jobs, async tasks, notifications, model refresh, price sync, and log cleanup |
| Database / coordination | PostgreSQL | Canonical database plus `LISTEN/NOTIFY` for config hot reload, job wakeup, and runtime status updates |
| UI | Tailwind CSS + shadcn/ui + lucide-react | Console UI, tables, forms, icons, dialogs, and navigation |
| Client state | TanStack Query | Read Console configuration, status, Activity, and Usage data |
| Chart | Recharts | Usage, Cost, Latency, and Fallback charts |
| Schema / validation | Zod | Shared request, configuration, route policy, provider configuration, and Console form validation |
| Database access | SQL migrations now, Drizzle schema later | `packages/db/migrations/*.sql` is the current source of truth; Drizzle schema and typed queries can be added later |
| Logging | Pino | Gateway request logs, runtime logs, and error logs |
| Observability | OpenTelemetry + Prometheus exporter | Traces, metrics, provider latency, and Gateway runtime metrics |

Fastify is the default Gateway framework because Gateway is the runtime request
path and needs HTTP performance, streaming, plugin boundaries, and low added
latency. Console uses Next.js because the control plane needs page routing,
forms, data display, authentication onboarding, and deployment compatibility.

## 3. Overall Topology

```text
AI Agents
  |
  | OpenAI-compatible / Anthropic-compatible API
  v
Gateway Service
  |-- Agent-owned API key authentication
  |-- Budget / Rate Limit checks
  |-- Virtual Model / Route Policy resolution
  |-- Provider / Model selection
  |-- Fallback Chain execution
  |-- Streaming response proxy
  `-- Usage / Activity writes
  |
  v
Providers
  |-- OpenAI
  |-- Anthropic
  |-- Google Gemini
  |-- OpenRouter
  |-- Local Provider / Ollama
  `-- Future providers

Browser
  |-- Console
  |   |-- Agents / Providers / Models / Routes / Limits management
  |   |-- Activity / Usage / Cost display
  |   |-- Gateway Runtime status
  |   `-- Config change publishing
  |
  `-- Playground live request
      `-- Gateway Public API

Background Worker / Scheduler
  |-- Model discovery / refresh
  |-- Price sync / billing reconciliation
  |-- Alerts / notifications
  |-- Retention / cleanup
  |-- JSONL / webhook export
  `-- Scheduled backup / maintenance tasks

Gateway Service ------+
        |             |
        v             v
PostgreSQL canonical database + LISTEN/NOTIFY channels
        ^             ^
        |             |
Console +------ Background Worker
```

Gateway, Console, and Background Worker share one PostgreSQL database and use
PostgreSQL as the inter-process communication medium:

- Console writes user configuration and publishes configuration version changes
  through the shared config publisher.
- Gateway reads configuration data and builds an in-memory read-only config
  snapshot.
- Gateway writes request metadata, usage, cost, fallback, error, and other
  runtime data.
- Console reads Gateway runtime data for Activity, Usage, and Runtime pages.
- Background Worker reads configuration, runtime data, and pending jobs, then
  writes model library data, prices, alerts, notifications, reconciliation
  results, health summaries, and cleanup state.
- `LISTEN/NOTIFY` is only a wakeup and low-latency notification mechanism.
  Durable tables remain the source of truth for config versions, jobs, runtime
  status, and event records.

## 4. Gateway Service Architecture

Gateway Service is the data plane. Its priorities are a stable request path, low
latency, observability, and hot reload.

```text
Gateway Service
|-- Public API Layer
|   |-- OpenAI-compatible endpoints
|   |-- Anthropic-compatible endpoints
|   `-- Models endpoint
|
|-- Request Pipeline
|   |-- Request ID / logging context
|   |-- Agent-owned API key authentication
|   |-- Agent permission check
|   |-- Cheap RPM / concurrency check
|   |-- Protocol passthrough with model replacement
|   |-- Request metadata extraction
|   |-- Token estimate
|   `-- Agent limits check (RPM / TPM / concurrency / token / budget)
|
|-- Routing Runtime
|   |-- Config snapshot reader
|   |-- Virtual Model resolver
|   |-- Deterministic route policy engine
|   |-- Provider / model selector
|   |-- Fallback orchestrator
|   `-- Route reason builder
|
|-- Provider Runtime
|   |-- Provider adapter registry
|   |-- Provider key selector
|   |-- Streaming proxy
|   |-- Timeout / cancellation handling
|   `-- Provider health tracking
|
|-- Observability Runtime
|   |-- Activity recorder
|   |-- Usage / cost recorder
|   |-- Baseline / savings recorder
|   |-- Error / fallback recorder
|   |-- Metrics exporter
|   `-- Trace exporter
|
`-- Postgres Coordination Subscriber
    |-- Config change listener
    |-- Health summary listener
    |-- Runtime heartbeat writer
    `-- Periodic reconcile loop
```

Gateway JSON protocol endpoints share the `GatewayProtocolSpec` extension point
and execute through `executeGatewayProtocolRequest`. Protocol specs read only the
fields Gateway needs for routing, accounting, stream selection, and metadata.
Provider request bodies are forwarded from the original Agent payload with only
the virtual `model` replaced by the selected provider model.

Streaming provider differences are resolved through the provider dialect
registry in `packages/provider/src/dialect.ts`. A new streaming dialect should
register a `ProviderStreamingDialect` entry there, so Gateway streaming does not
branch on provider-key strings.

### 4.1 Public API Layer

Gateway exposes one unified endpoint surface to AI Agents, with priority support
for:

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/embeddings`
- `GET /v1/models`

`GET /v1/models` returns the Virtual Model Names authorized for the current
Agent. It does not expose the real provider model list.

The default caller of Public API is an AI Agent. When Playground calls Gateway
Public API directly from the browser, Gateway only allows configured Console
origins through CORS. Local deployments may allow Console localhost origins by
default. Server deployments must explicitly configure allowed origins.
Playground uses the Gateway Base URL shown in Console through Agent onboarding
or runtime settings. If Console and Gateway run on different ports or domains,
the user must configure a browser-reachable Gateway Base URL.

`/v1/responses` V1 support:

- Gateway reads the minimum fields it needs for routing and accounting, then
  forwards the Agent's Responses request body to compatible providers with only
  the virtual `model` replaced by the selected provider model.
- Gateway does not own provider-side response state. Fields such as `store`,
  `previous_response_id`, and `conversation` are forwarded, but cross-provider
  state migration and replay remain the caller/provider responsibility.
- Multimodal content parts, files, tool calls, hosted-tool options, metadata,
  reasoning/text options, and future top-level fields are not interpreted or
  rewritten by Gateway.

`/v1/chat/completions` V1 support:

- Gateway reads the fields it needs for routing and accounting while forwarding
  the original Chat Completions request body to the provider with only the
  virtual `model` replaced.
- If both `max_completion_tokens` and legacy `max_tokens` are supplied, both are
  sent to the provider exactly as received.
- Multimodal, audio, file, custom-tool, function, and metadata fields are
  passed through to compatible providers. Gateway does not translate or delete
  those features across providers that do not support them.

### 4.2 Routing Runtime

Routing Runtime uses a deterministic rule engine. V1 does not call an extra LLM
classifier by default. It selects a real provider and model from:

- Agent-owned API key.
- Agent type.
- Virtual Model Name.
- Route Policy.
- Request protocol.
- Input token estimate.
- Tools / function calling requirements.
- Context window requirements.
- Task features such as coding, reasoning, terminal, repository, and long
  context.
- Gateway in-memory Provider / Model health view.
- Route Policy cost preference and Fallback Chain.

The route result must include a user-understandable route reason for response
metadata and Activity display.

### 4.3 Config Snapshot

Gateway does not assemble full configuration on every request. It keeps an
immutable config snapshot in memory:

- The snapshot comes from database configuration such as Agents, Agent Virtual
  Model grants, Providers, Models, Virtual Models, Route Policies, and Limits.
- Each config hot reload builds a new snapshot.
- New requests read the latest current snapshot.
- In-flight requests keep the snapshot captured when they entered the pipeline.
- If new config loading or validation fails, Gateway keeps the previous usable
  snapshot.

This prevents configuration updates from affecting in-flight streaming requests
and avoids reading partially updated runtime configuration.

### 4.4 Runtime Counter And Health State

Gateway owns mutable runtime state in the synchronous request path: rate-limit
windows, concurrency counters, budget-period admission checks, and the routing
health view. These do not belong in the immutable config snapshot and must not
be computed from full history on every request.

Runtime state ownership:

- RPM / TPM window: Gateway keeps fast in-memory counters for the current
  window and periodically or per request writes window totals to the database
  for restart recovery and Console display.
- Concurrency: Gateway keeps current process concurrency in memory and releases
  it when the request finishes or is canceled. After Gateway restart,
  concurrency naturally resets to zero.
- Budget period: the database stores each Agent's current budget-period token
  and cost totals. Gateway checks the current period at request start and records
  successful request usage after completion as best-effort background work.
- Usage record: `request_usage` is an audit and analytics record. It is not the
  only source for synchronous limit checks.
- Provider / Model health view: Gateway maintains an in-memory health view from
  request-path failures, timeouts, 429s, first-chunk latency, and Worker
  periodic probe summaries. Routing decisions read this view and do not query
  `provider_health_events` on every request.

Recommended check order:

```text
auth
  -> protocol normalization
  -> request metadata extraction
  -> token estimate
  -> route decision
  -> unified agent limits check
  ```

The unified agent limits executor reads enabled `agent_limits` once and handles
RPM, TPM, concurrency, per-request token, and cost budget checks in one request
start decision. TPM windows keep request-start estimate semantics; provider
actual tokens are not written back into TPM windows after completion. Actual
usage drives request usage/cost records and budget-period usage after successful
responses only.

Concurrency leak recovery:

- Gateway releases the concurrency lease when a request ends or disconnects; the
  release uses `greatest(active_count - 1, 0)` so duplicate releases cannot make
  the count negative.
- Worker `stale_concurrency_reconcile` only fixes quiet windows: by default,
  windows untouched for five minutes are eligible for reconciliation.
- Reconciliation uses recent `request_activity` rows still in `started` state
  and not older than the default 15-minute in-flight window. Longer in-flight
  requests can be temporarily under-counted; the later real release still lands
  safely at zero. This is a crash-leak safety net, not a replacement for
  request-path release.

Provider health merge rules:

- Gateway request-path signals immediately influence routing, including
  consecutive failures, 429s, timeouts, or abnormal first-chunk latency.
- Worker periodic probes write `provider_health_events` and update
  `provider_health_summary`.
- Gateway receives Postgres `health_summary_changed` notifications or performs
  lightweight periodic refreshes to read the latest `provider_health_summary`
  and merge it into the in-memory health view.
- Console displays full `provider_health_events` and current
  `provider_health_summary`. These tables are not synchronous query sources for
  every route decision.

Postgres is the durable owner of runtime state. Gateway is the owner of the
low-latency in-memory view on the request path. Gateway can use memory counters
for single-instance low-latency checks and write recoverable state to Postgres.
If multiple Gateway instances are added later, RPM / TPM / concurrency must
move to shared state such as Postgres atomic updates, advisory locks, or Redis.
They cannot keep relying only on single-process memory.

### 4.5 Savings Calculation Ownership

Cost savings are request-level observability data owned by Gateway
Observability Runtime, not data Console derives later during queries.

After route decision and actual usage are known, Gateway synchronously writes:

- Actual provider / model cost: the cost from the provider and model actually
  used for the request.
- Baseline provider / model: the baseline model for the Virtual Model, from user
  configuration. If the user did not configure one, use the quality-first
  default model for that Virtual Model.
- Baseline hypothetical cost: the cost that the same input / output tokens would
  have produced on the baseline model.
- Savings amount / percent: `baseline hypothetical cost - actual cost` and its
  percentage.
- Price source / price version: the price source used for this calculation, so
  later price sync does not drift historical savings.

Overview and Usage can aggregate baseline and savings fields directly from
`request_costs`. They do not need to re-run historical routing logic during
queries. Worker billing reconciliation can update actual cost without changing
the original route decision. If actual cost is corrected, Worker can recompute
savings against the same baseline and mark it reconciled.

### 4.6 Provider Adapter Strategy

Provider adapters are not implemented one-by-one for every long-tail provider.
V1 uses two layers:

- Native adapter: for OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama, and
  providers with meaningful protocol or behavior differences.
- Generic OpenAI-compatible adapter: for DeepSeek, xAI, Qwen, Moonshot / Kimi,
  MiniMax, Z.ai, LM Studio, llama.cpp, and other providers that follow the
  OpenAI API shape.

The generic OpenAI-compatible adapter must not become arbitrary custom endpoint
support. It is enabled only through built-in allowlisted provider templates.
Templates define:

- Provider id, display name, and category.
- For remote providers, fixed base URL and endpoint path, such as DeepSeek,
  xAI, and Qwen.
- For local provider templates, fixed endpoint path, protocol shape, and
  capability declarations, while base URL is entered by the user in Provider
  configuration, such as LM Studio and llama.cpp. This remains constrained by
  the local provider template and is not arbitrary custom endpoint support.
- Auth header / key placement.
- Supported endpoint subset, such as chat completions, stateless responses
  subset, and embeddings.
- Capability declarations such as streaming, tools, JSON mode, and max context.
- Model discovery method: provider model list API, static registry, or local
  provider probe.

This covers the long-tail provider list while preserving the product boundary
that V1 does not support arbitrary custom endpoints.

## 5. Console Architecture

Console is the control plane for user-facing configuration, observability, and
onboarding.

```text
Console
|-- Web App
|   |-- Overview
|   |-- Agents
|   |-- Providers
|   |-- Models
|   |-- Virtual Models / Routes
|   |-- Activity
|   |-- Usage & Cost
|   |-- Limits
|   |-- Gateway Runtime
|   |-- Playground
|   `-- Settings
|
|-- Console API
|   |-- Agent management
|   |-- Provider management
|   |-- Model library management
|   |-- Route policy management
|   |-- Limit management
|   |-- Usage query
|   |-- Activity query
|   |-- Runtime query
|   `-- Import / export
|
|-- Domain Services
|   |-- Dependency check service
|   |-- Config validation service
|   |-- Shared config publisher client
|   |-- Secret encryption client
|   `-- Import / export service
|
|-- Runtime Queries
|   |-- Gateway status query from Postgres
|   |-- Worker job status query from Postgres
|   `-- Provider health query from Postgres
|
`-- Job Client
    |-- Model refresh job trigger
    |-- Price sync job trigger
    |-- Provider connectivity check trigger
    `-- Export / cleanup job trigger
```

Console responsibilities:

- Write and validate configuration.
- Check dependencies before disabling or deleting Providers, Models, or Route
  Policies.
- Encrypt Provider Keys and hash Agent-owned API keys.
- Generate Agent onboarding instructions and copyable configuration snippets.
- Display Activity, Usage, Cost, Fallback, and error data written by Gateway.
- Manage Gateway Runtime settings such as listen address, port, log retention,
  and data import/export.
- Create background jobs for model refresh, provider connectivity checks, price
  sync, backup, log cleanup, and other asynchronous actions instead of running
  long provider calls inside Console requests.
- Use the shared publisher from `packages/config`; Console does not own the
  config publisher transaction implementation.

Console does not forward provider requests and does not participate in the AI
Agent realtime request path. Console does not call private Gateway interfaces.
Control actions flow through Postgres configuration tables, job tables, and
notification channels. Real provider egress calls are performed by Gateway or
Background Worker.

## 6. Background Worker / Scheduler Architecture

Background Worker is the asynchronous task plane. It owns all capabilities that
do not belong in the Agent synchronous request path and should not block Console
page requests.

```text
Background Worker / Scheduler
|-- Job Runner
|   |-- Scheduled jobs
|   |-- Manual jobs from Console
|   |-- Retry / backoff
|   `-- Job lease / deduplication
|
|-- Provider Maintenance
|   |-- Model discovery / refresh
|   |-- Provider connectivity probes
|   |-- Price registry sync
|   `-- Billing reconciliation
|
|-- Alerting / Notification
|   |-- Budget threshold evaluator
|   |-- Provider failure evaluator
|   |-- Fallback exhaustion evaluator
|   `-- Webhook dispatcher
|
|-- Data Maintenance
|   |-- Request log retention
|   |-- Optional content cleanup
|   |-- JSONL request log export
|   `-- Cost report export
|
`-- Lifecycle Maintenance
    |-- Backup job
    |-- Database maintenance
    `-- Migration status check
```

Configuration write ownership:

- Console owns user configuration writes: Agents, Agent Virtual Model grants,
  Providers, Virtual Models, Route Policies, Limits, Settings, and other
  explicitly user-authored configuration.
- Worker owns provider-derived data and asynchronous runtime data. Provider
  model lists and price registry snapshots enter the configuration version.
  Provider health summary and billing reconciliation corrections to
  `request_costs` are runtime data and do not enter the config snapshot.
- Console and Worker must both publish routing-visible config versions through
  the same config publisher. After either side publishes a config version,
  Postgres `config_changed` wakes Gateway reload. Worker health probe results do
  not publish config versions. They refresh Gateway health view through health
  summary tables and the `health_summary_changed` channel.

Worker runtime boundaries:

- Worker is not a request proxy. Agent model requests only go through Gateway.
- Worker can decrypt Provider Keys because it must perform model discovery,
  price sync, billing reconciliation, and provider health probes.
- Worker failure must not block Gateway requests, but it delays model refresh,
  notifications, cleanup, reconciliation, and other asynchronous capabilities.
- Worker can run under the same process supervisor as Gateway / Console or as a
  separate process.

### 6.1 Model Discovery And Refresh Path

Background Worker performs provider model discovery. This avoids direct provider
egress from Console and keeps Gateway's synchronous request path free of model
refresh work.

```text
User
  v
Console Providers / Models page
  v
Console API
  v
create model_refresh_job
  v
Background Worker
  |-- load provider config
  |-- decrypt provider key
  |-- call provider model list API
  |-- normalize model metadata
  |-- upsert provider_models
  |-- publish config version if routing-visible data changed
  `-- emit Postgres config_changed notification
```

Triggers:

- Automatic refresh: after adding or enabling a Provider, Console creates one
  model refresh job.
- Manual refresh: when the user clicks refresh in Console, Console creates one
  model refresh job.
- Scheduled refresh: Worker refreshes model lists on a configured cadence.
  Provider health probes use the health summary path and do not publish config
  versions.

Gateway `GET /v1/models` does not run provider discovery. It only returns the
Virtual Model Names authorized for the Agent from the current config snapshot.

Provider-derived model relationship integrity:

- Worker refresh only upserts and marks status. It does not hard-delete
  `provider_models` rows directly.
- Models that disappear from the provider are marked `unavailable`,
  `not_listed`, or `deprecated` and record last-seen time.
- If a missing model is referenced by a Route Policy candidate, Fallback Chain,
  or fixed-model route, Worker writes an alert event and Console highlights the
  affected configuration on Models / Routes pages.
- Hard-deleting provider-derived models can only be explicitly performed by the
  user in Console and must pass dependency checks.
- Gateway routing does not select models marked unavailable unless the user
  explicitly overrides and accepts the failure risk.

### 6.2 Provider Connectivity Checks And Health Probes

Provider connectivity checks and periodic health probes share one Worker health
probe pipeline. This avoids two separate health owners.

- `provider-health.job.ts` is the execution owner. It decrypts Provider Keys,
  sends lightweight probes, writes `provider_health_events`, and updates
  `provider_health_summary`.
- Periodic probes are triggered by Worker scheduler to continuously refresh
  Provider / Model health.
- Console manual "connection test" creates a `provider_connectivity_check` job,
  which is a health probe with `trigger = manual`.
- Manual results write both job result and `provider_health_events`. If the
  result is newer than the current summary, Worker updates
  `provider_health_summary` and emits `health_summary_changed`.
- Gateway only consumes the merged in-memory health view. It does not execute
  provider connection tests requested by Console.

### 6.3 Price Sync And Billing Reconciliation

Gateway writes usage and estimated cost at request end so Activity and Usage
pages can display data immediately. Background Worker performs asynchronous
reconciliation:

- When a provider returns actual usage or billing data, Worker periodically
  fetches it and writes actual cost.
- When a provider does not support actual billing data, LLMIngress keeps token
  estimated cost and marks cost source as estimated.
- Reconciliation does not change original request activity. It adds cost source,
  actual cost, reconciled-at, and similar fields.
- If price sync changes a price table or model availability in a way that
  affects routing, Worker publishes a new config version through the config
  publisher and triggers Gateway reload through Postgres `config_changed`.

This satisfies the product rule that provider actual billing data is preferred,
with estimates used when actual data is unavailable, without placing billing API
calls in the Gateway request path.

## 7. Gateway, Console, And Worker Interactions

Interactions fall into five categories: configuration writes, Postgres
notification hot reload, runtime data reads, async job scheduling, and
Playground Public API tests.

### 7.1 Configuration Write Path

```text
User-authored config
  `-- Console API
      `-- Config validation / dependency check

Provider-derived config
  `-- Background Worker
      `-- Provider / registry normalization

Both paths
  v
Shared config publisher in `packages/config`
  v
Database transaction
  |-- write config or derived config tables
  |-- increment config version
  |-- append config change event
  `-- pg_notify('config_changed', version payload)
```

Configuration has two controlled writers:

- Console writes explicit user configuration such as Agent, Provider, Virtual
  Model, Route Policy, Limit, and Settings.
- Worker writes provider-derived configuration such as provider model lists and
  price registry snapshots. Provider health summary is runtime health state and
  does not enter the config snapshot.

Both configuration write paths must go through the same config publisher in
`packages/config`. Any change that affects Gateway routing, permissions, model
capability, static enabled state, or prices increments the global config version
and wakes Gateway through Postgres `NOTIFY`. Provider health changes do not
increment config version. They refresh Gateway's in-memory health view.

### 7.2 Hot Reload Notification Path

Use "Postgres `LISTEN/NOTIFY` + periodic reconcile" instead of direct private
HTTP calls from Console / Worker to Gateway.

```text
Shared config publisher in `packages/config`
  |
  | 1. Console or Worker publishes config version
  | 2. PostgreSQL commits config transaction
  | 3. PostgreSQL emits NOTIFY config_changed
  v
Gateway Postgres listener
  |
  | 4. read latest config version from Postgres
  v
Config Loader
  |
  | 5. build and validate new immutable snapshot
  v
Atomic Snapshot Swap
  |
  | 6. new requests use latest snapshot
  v
Gateway writes applied config version to runtime status table
```

Hot reload strategy:

- Fast path: Console or Worker writes a routing-visible config version through
  the config publisher and executes Postgres `NOTIFY config_changed` in the same
  transaction. Gateway's dedicated listener connection receives the notification
  and loads the specified config version.
- Safety path: Gateway loads the latest configuration on startup and
  periodically checks the latest config version in Postgres. If Gateway misses a
  `NOTIFY` while reconnecting, reconcile still detects the change.
- Multi-gateway future: multiple Gateway instances can all `LISTEN
  config_changed`. Postgres broadcasts notifications to active listeners.
  `config_versions`, including `changes` JSON, remains the durable source of
  truth.
- Notification semantics: Postgres `NOTIFY` is a wakeup signal, not a durable
  queue. Payload only includes config version, change id, and change type. Full
  configuration is always read from the database.
- Control feedback semantics: Console control over Gateway is asynchronous and
  eventually consistent. After saving config, Console can show the target config
  version as pending. Whether it was applied or failed depends on
  `gateway_runtime_status.applied_config_version` and reload failure events
  written by Gateway, not on a synchronous HTTP call.

Hot reload failure handling:

- Gateway fully validates the new snapshot.
- If validation fails, Gateway does not switch snapshots.
- Gateway records a reload failure event.
- Notification and timer entrypoints use the same serialized reload coordinator.
  If a reload is already running, additional notifications coalesce into one
  trailing reload. Startup remains fail-fast, while listener and timer reload
  failures preserve the last-known-good snapshot and wait for the next wakeup.
- Console Gateway Runtime page shows target version, applied version, and
  failure reason.
- If Gateway is online but misses a notification, periodic reconcile reloads.
  If the configuration itself fails validation, the user must fix it and publish
  a new version.

Gateway shutdown order:

- Stop accepting requests and let Fastify close active request handling.
- Stop config listeners and timers, then wait for any in-flight reload to settle.
- Drain tracked Gateway background tasks, including activity, trace, usage,
  cost, stream health, and concurrency-release writes.
- Close PostgreSQL pools after the drain completes. `GATEWAY_SHUTDOWN_DRAIN_MS`
  defaults to `10000`; if the drain times out, Gateway logs pending task names
  and exits non-zero so a supervisor can surface the incomplete shutdown.

### 7.3 Runtime Data Read Path

Gateway writes runtime data after processing requests:

```text
Gateway Request Pipeline
  |-- Activity records
  |-- Usage records
  |-- Cost records
  |-- Fallback events
  |-- Error events
  |-- Provider health snapshots
  `-- Gateway runtime heartbeat / applied config version
        v
      Postgres
        v
      Console Activity / Usage / Runtime pages
```

Console reads Activity, Usage, Cost, Runtime status, Provider health summary,
and Worker job status from Postgres. Gateway periodically writes
`gateway_runtime_status.heartbeat_at`. Runtime page marks Gateway as stale/down
by default when heartbeat is older than 30 seconds. User-visible Provider health
summary is centralized on the Providers page to avoid duplicating provider
dimension status in Gateway Runtime.

For live refresh, Console Web can use polling, SSE, or WebSocket through Console
API. If Console API subscribes to Postgres notification channels, it must run in
a long-lived Node.js process. It must not assume an edge runtime or short-lived
serverless function can hold a long `LISTEN`. If the deployment does not fit a
long-lived listener, Console should poll Postgres state.

### 7.4 Async Job Scheduling Path

Console only creates jobs for long-running actions. It does not directly perform
provider egress calls or long maintenance actions. Scheduled maintenance jobs
can be created by Worker scheduler. Manual jobs can be triggered by Console.

```text
Worker scheduler
|-- retention_cleanup
`-- backup (trigger=scheduled)

Console API manual trigger
  |-- model_refresh
  |-- provider_connectivity_check
  |-- price_sync
  |-- billing_reconciliation
  |-- webhook_export
  `-- backup (trigger=manual)

Both paths
  v
create job record
  |-- model_refresh
  |-- provider_connectivity_check
  |-- price_sync
|-- billing_reconciliation
|-- retention_cleanup
|-- webhook_export
`-- backup
      |
      |-- pg_notify('job_created', job payload)
      v
Background Worker
  |-- LISTEN job_created or poll due jobs
  |-- acquire job lease
  |-- execute job
  |-- write job result
  `-- publish config version and emit config_changed if routing-visible data changed
```

Worker jobs use Postgres row locks and explicit leases to deduplicate work across
multiple Worker instances. `job_created` notification is only a wakeup. The
`jobs` table is the source of truth. A claim first recovers up to 100 expired
running jobs, marking the expired attempt `failed/job_lease_expired`, then
returns retriable jobs to `pending` or marks exhausted jobs `failed`. Running
jobs renew their lease every `WORKER_JOB_LEASE_MS / 3`; completion and failure
updates are fenced by worker id, attempt number, and unexpired lease. If a Worker
loses its lease, the running handler receives an `AbortSignal` and the stale
executor cannot overwrite the newer attempt.

Worker shutdown keeps renewing the current job while waiting up to
`WORKER_SHUTDOWN_GRACE_MS`; after the grace window it aborts the handler and
stops renewing so normal lease expiry recovery can reclaim the job. Notification
delivery uses the same at-least-once model: `notification_events` rows carry
`delivery_owner` / `delivery_expires_at`, delivery completion is fenced by owner
and attempt count, and legacy `sending` rows without a delivery lease are
recovered by the next claim. Notification dispatch jobs process the payload
`eventIds`; batches over 50 or not-yet-due rows enqueue continuation jobs instead
of leaving events permanently queued. The `backup` job distinguishes scheduled
and manual runs through a trigger field.

### 7.5 Playground Public API Test Path

Console Route Handlers enforce CSRF at the route boundary for every mutating
method. `POST`, `PUT`, `PATCH`, and `DELETE` requests must carry an `Origin`
header that exactly matches `CONSOLE_PUBLIC_BASE_URL`; if that variable is not
configured, the expected origin is the current request URL origin. This is
intentionally not derived from forwarded headers, so reverse proxy deployments
must provide the browser-facing public Console URL explicitly.

Playground uses Gateway Public API for real request testing. Console backend
does not proxy Playground requests and does not store, read, or recover
plaintext Agent API keys. The user manually enters an Agent API key in the
Playground page, then selects a Virtual Model Name as the request `model`.

```text
User
  v
Console Playground in browser
  |-- input Agent API key, held in page memory only
  |-- GET /v1/models through Gateway Public API
  `-- select Virtual Model Name
  v
Gateway Public API
  |-- normal Agent-owned API key authentication
  |-- normal Virtual Model authorization
  |-- normal rate limit / budget / concurrency check
  |-- normal route policy / fallback execution
  |-- live Provider call
  `-- normal activity / usage / cost record
```

Because Playground uses real Public API requests, it counts toward that Agent's
Rate Limit, Budget, Usage, and Cost by default. Console can show the request id,
route reason, and response in the page, but those data come from the Public API
response and later Activity queries. No internal test endpoint is needed.

Playground safety boundary:

- Agent API key is kept only in current page memory. It is not written to
  localStorage, sessionStorage, cookies, or Console backend logs.
- If Console and Gateway use different ports or domains, Playground uses the
  user-configured Gateway Base URL and requires Gateway CORS allowlist to include
  the current Console origin.
- This is an acceptable explicit operation for a self-hosted single-user
  scenario. If the user closes or refreshes the page, the Agent API key must be
  pasted again.

### 7.6 Postgres Communication And Permission Boundary

Gateway only exposes Public API for Agents and Playground. Control
communication among Gateway, Console, and Worker goes through Postgres tables
and notification channels. Postgres credentials are deployment secrets and must
not be reused as provider secret master keys.

- Gateway: reads config tables, subscribes to `config_changed` /
  `health_summary_changed`, writes request runtime records, Gateway heartbeat,
  applied config version, and reload failure events.
- Console: writes user configuration, creates jobs, and reads runtime /
  Activity / Usage / health data. It does not call a private Gateway HTTP
  endpoint.
- Worker: claims jobs, writes provider-derived configuration, writes health
  summaries, writes notification / reconciliation / cleanup results, and emits
  `config_changed` through the config publisher when routing-visible data
  changes.
- Deployment should use separate Postgres roles or least-privilege schema grants
  so Console, Worker, and Gateway do not receive database permissions beyond
  their responsibilities.

### 7.7 Runtime Settings Change Semantics

Console can manage Gateway Runtime settings, but not every runtime setting can
be hot reloaded through a config snapshot.

| Setting type | Effective mechanism | Executor |
| --- | --- | --- |
| Route Policy, Virtual Model, Agent permissions, Provider enabled state, model metadata, prices, Limits | config version + snapshot hot reload | Console / Worker through shared config publisher |
| Log retention period, export schedule, alert thresholds, notification targets | Worker scheduler next tick or job reload | Worker |
| Console UI preferences, report filter defaults | Console API / Web App immediate effect | Console |
| Gateway listen host, port, TLS config, Postgres connection string, data directory, master key source | Requires supervisor restart of affected process | local / deployment supervisor |

Listen address, port, and data directory are process startup parameters and
cannot be atomically swapped through an immutable config snapshot. Console
should mark changes to these settings as restart required and hand restart
execution to the local / deployment supervisor.

Gateway listen host, port, Postgres connection string, data directory, and
master key source are needed before database connection is established. They
cannot live only in the business database. They should be persisted in
supervisor-owned bootstrap config files or environment variables. When Console
changes these settings, the local / deployment supervisor writes the bootstrap
configuration instead of writing only to the business database and waiting for
hot reload.

## 8. Data Storage Choice

### 8.1 Default: PostgreSQL

V1 uses PostgreSQL directly as the canonical database and as the communication
medium among Gateway, Console, and Worker.

Reasons:

- Gateway, Console, and Worker are separate processes. Postgres is better than a
  local file database for concurrent writes, long-running operation, and Docker
  / server deployment.
- Configuration data, request metadata, usage, cost, fallback events, jobs, and
  notifications are strongly structured data and fit a relational model.
- `LISTEN/NOTIFY` can support low-latency notifications for config hot reload,
  job wakeup, and health summary refresh without exposing a private Gateway
  control interface.
- `SELECT ... FOR UPDATE SKIP LOCKED`, transactions, and advisory locks support
  Worker job leases, rate-limit windows, and scheduled task deduplication.
- If the system later expands to multiple Gateways or Workers, Postgres can
  still be the default shared state layer. Redis is an optimization for
  high-frequency rate limiting or caching, not a required V1 component.

### 8.2 Data Groups

```text
PostgreSQL database
|-- Identity / access
|   |-- agents
|   |-- agent_virtual_models
|   `-- console_users
|
|-- Provider / model config
|   |-- providers
|   |-- provider_api_keys
|   `-- provider_models (including manual price fields)
|
|-- Routing config
|   |-- virtual_models
|   |-- route_policies (including rules jsonb)
|   `-- route_policy_candidates
|
|-- Limits
|   |-- agent_limits
|   |-- rate_limit_windows
|   `-- budget_periods
|
|-- Runtime records
|   |-- request_activity (including request-level config label snapshots)
|   |-- request_usage
|   |-- request_costs (including baseline and savings fields)
|   |-- fallback_events (retry-chain source)
|   |-- provider_health_events
|   |-- provider_health_summary
|   |-- gateway_runtime_status
|   `-- runtime_errors
|
|-- Background jobs
|   |-- jobs
|   |-- job_attempts
|   |-- notification_events
|   `-- webhook_deliveries
|
|-- Billing / pricing
|   `-- provider_models manual and synced current price fields
|
|-- Config lifecycle
|   |-- config_versions
|   `-- migration_history
```

Config tables use `deleted_at` for Console delete semantics. Agents, Providers,
Provider Models, Virtual Models, and Route Policies are hidden and disabled
when deleted instead of physically removed. The schema does not use database
foreign keys; Console and Worker paths enforce dependency checks and explicit
cleanup where rows are physically removed. Request activity also stores minimal
label snapshots for Agent, Virtual Model, Route Policy strategy, Provider, and
Provider Model. Prompt and response content tables are not part of the current
V1 schema; adding them requires a separate content-recording schema change.
Historical reports prefer those snapshots and fall back to joined config rows
for older records.

Postgres notification channels:

- `config_changed`: emitted by the config publisher after a routing-visible
  config version commits. Gateway subscribes and loads the new snapshot.
- `job_created`: emitted after Console or Worker scheduler creates a job.
  Worker subscribes and claims jobs quickly.
- `health_summary_changed`: emitted after Worker updates provider / model health
  summary. Gateway subscribes and refreshes the in-memory health view.
- `runtime_status_changed`: optional channel emitted after Gateway or Worker
  writes important runtime status changes. Console API can subscribe and refresh
  Runtime pages.

All channels are wakeup signals only. They do not carry full business state.
Complete state must be read from durable tables.

### 8.3 Credentials And Private Data

- Provider API Key: encrypted at rest and only shown as prefix or label.
- Subscription Token: if supported later, must be encrypted at rest and clearly
  labeled with provider ToS risk.
- Agent API key: hash, prefix, and default Virtual Model live on `agents`.
  Allowed Virtual Models live in `agent_virtual_models`. Plaintext is shown only
  once at Agent creation. Playground cannot recover existing keys from Console
  server; the user must paste the plaintext key. V1 does not support
  rotate/disable/history. If a key is lost or leaked, delete and recreate the
  Agent.
- Prompt / response content: not recorded by default. It enters optional content
  records only when the user explicitly enables it.
- Data export: supports configuration, cost reports, and request metadata.
  Prompt / response export requires explicit user confirmation.

### 8.4 Secret Master Key Management

Provider Key encryption is not a Console-private capability. Gateway, Console,
and Worker all need the same secret encryption capability:

- Console encrypts Provider Keys when writing or rotating them.
- Gateway decrypts before calling real providers.
- Worker decrypts for model discovery, price sync, billing reconciliation, and
  provider health probes.

Master key ownership:

- Master key must not be stored in the PostgreSQL business database.
- Local / single-node mode: first initialization generates a master key and
  stores it in a bootstrap secret file, environment variable, or system secret
  store.
- Docker / Server mode: inject through environment variable or mounted secret,
  such as `LLMINGRESS_MASTER_KEY`.
- Single binary mode: supervisor loads the master key before starting Gateway,
  Console, and Worker.
- Database stores only encrypted secret, key id, algorithm version, and key
  prefix / label.
- If the master key is lost, encrypted Provider Keys cannot be recovered and
  must be re-entered by the user.

Gateway can continue processing requests while Console is unavailable only if
the Gateway process has loaded the master key and the database contains usable
configuration and encrypted Provider Keys.

### 8.5 Schema Migration And Backup

Migration is a deployment-time / startup-time shared concern. It is not a
Console-only domain service.

- `packages/db` owns schema and migration definitions.
- `scripts/migrate.ts` is the explicit migration entry point.
- Local / single binary supervisor runs `scripts/backup.ts` for preflight backup
  before upgrades, then runs migration, then starts Gateway / Console / Worker.
- Docker / server mode should run a migration job before starting application
  processes.
- Gateway, Console, and Worker all check schema version at startup and fail fast
  on incompatible versions instead of each trying to modify schema implicitly.
- Worker can perform scheduled routine backups, but not pre-upgrade backups.
  Pre-upgrade backup is a supervisor / deployment pipeline sequencing
  responsibility.

### 8.6 Postgres Communication Constraints

Postgres handles both persistence and inter-process coordination, but the
semantic boundary must be explicit:

- `NOTIFY` is not a durable queue. If a process disconnects, it can miss
  notifications. Every consumer must reconcile latest state from tables after
  startup and reconnect.
- Tables such as `config_versions`, `jobs`, `provider_health_summary`, and
  `gateway_runtime_status` are the source of truth.
- Gateway, Console, and Worker should use dedicated connections for
  `LISTEN/NOTIFY` so long transactions do not block notification reception.
- Multi-instance Worker job consumption uses Postgres row locks, advisory locks,
  or lease fields for deduplication. It cannot rely only on `job_created`.
- Gateway's high-frequency request path must not synchronously query
  configuration on every request. It must use immutable config snapshots and
  the in-memory runtime view.
- If multiple Gateway instances later share RPM / TPM / concurrency, those
  counters must move to Postgres atomic writes, advisory locks, Redis, or
  another shared state component.

### 8.7 Future Extension Path

If deployment expands from single-node self-hosting to higher-concurrency server
or multi-instance modes, add:

- Redis: distributed high-frequency rate limit, concurrency counters, and short
  TTL cache. It does not replace the canonical database.
- Object storage: long-term archive for large request content or export files.
- Postgres partition / retention policy: long-term retention for
  `request_activity`, usage, cost, and audit data.
- Read replica: heavier reporting queries without affecting the Gateway write
  path.

These are extension options. They do not change the V1 core choice of Postgres
as canonical database and coordination medium.

## 9. Recommended Project Layout

The following is the target directory shape. The current repository does not
need to create every file at once. Later implementation can land modules
incrementally.

```text
LLMIngress/ # repository root for apps, shared packages, docs, and scripts
|-- apps/ # independently runnable application processes
|   |-- gateway/ # Gateway Service data-plane app
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   `-- src/ # Gateway source directory
|   |       |-- main.ts
|   |       |-- server.ts
|   |       |-- public-api/ # public API routes for AI Agents
|   |       |   |-- openai.routes.ts
|   |       |   |-- anthropic.routes.ts
|   |       |   |-- models.routes.ts
|   |       |   `-- errors.ts
|   |       |-- pipeline/ # synchronous chain before provider calls
|   |       |   |-- request-context.ts
|   |       |   |-- authentication.ts
|   |       |   |-- authorization.ts
|   |       |   |-- protocol-normalizer.ts
|   |       |   |-- token-estimator.ts
|   |       |   `-- agent-limits.ts
|   |       |-- runtime/ # Gateway request runtime core
|   |       |   |-- config-snapshot.ts
|   |       |   |-- config-loader.ts
|   |       |   |-- router-runtime.ts
|   |       |   |-- fallback-runtime.ts
|   |       |   |-- provider-runtime.ts
|   |       |   |-- runtime-counters.ts
|   |       |   |-- health-view.ts
|   |       |   |-- usage-recorder.ts
|   |       |   |-- cost-recorder.ts
|   |       |   `-- savings-recorder.ts
|   |       |-- coordination/ # Gateway / Postgres coordination channel
|   |       |   |-- postgres-listener.ts
|   |       |   |-- config-reload.ts
|   |       |   |-- runtime-heartbeat.ts
|   |       |   `-- reconcile-loop.ts
|   |       `-- observability/ # Gateway observability
|   |           |-- logger.ts
|   |           |-- metrics.ts
|   |           `-- tracing.ts
|   |
|   |-- worker/ # Background Worker async task app
|   |   |-- package.json
|   |   |-- tsconfig.json
|   |   `-- src/ # Worker source directory
|   |       |-- main.ts
|   |       |-- scheduler.ts
|   |       |-- jobs/ # concrete background job implementations
|   |       |   |-- model-refresh.job.ts
|   |       |   |-- provider-health.job.ts
|   |       |   |-- price-sync.job.ts
|   |       |   |-- billing-reconciliation.job.ts
|   |       |   |-- alert-evaluation.job.ts
|   |       |   |-- retention-cleanup.job.ts
|   |       |   |-- jsonl-export.job.ts
|   |       |   `-- backup.job.ts
|   |       `-- dispatchers/ # async notification and external delivery
|   |           |-- notification-event-writer.ts
|   |           `-- webhook.ts
|   |
|   `-- console/ # Console control-plane web app
|       |-- package.json
|       |-- tsconfig.json
|       `-- src/ # Console source directory
|           |-- app/ # Next.js App Router page routes
|           |   |-- layout.tsx
|           |   |-- page.tsx
|           |   |-- agents/ # Agents page route
|           |   |-- providers/ # Providers page route
|           |   |-- models/ # Models page route
|           |   |-- routes/ # Virtual Models / Routes page route
|           |   |-- activity/ # Activity request log page route
|           |   |-- usage/ # Usage & Cost page route
|           |   |-- limits/ # Limits page route
|           |   |-- runtime/ # Gateway Runtime page route
|           |   |-- playground/ # Playground page route
|           |   `-- settings/ # Settings page route
|           |-- features/ # page logic and components by product feature
|           |   |-- agents/ # Agent management module
|           |   |-- providers/ # Provider configuration module
|           |   |-- models/ # model library display module
|           |   |-- route-policies/ # Virtual Model and routing policy module
|           |   |-- activity/ # request log module
|           |   |-- usage/ # Usage and Cost chart module
|           |   |-- limits/ # Budget, RPM, TPM, and concurrency limits module
|           |   |-- runtime/ # Gateway runtime status module
|           |   `-- jobs/ # Worker job management module
|           |-- server/ # Console server-side entry points and adapters
|           |   |-- console-api.ts
|           |   |-- auth.ts
|           |   |-- runtime-query.ts
|           |   |-- job-client.ts
|           |   `-- import-export.ts
|           `-- components/ # shared Console UI components
|               |-- navigation/ # navigation components
|               |-- tables/ # table components
|               |-- forms/ # form components
|               |-- charts/ # chart components
|               `-- runtime-status/ # runtime status components
|
|-- packages/ # internal packages shared by Gateway, Console, and Worker
|   |-- domain/ # domain model and core business types
|   |   `-- src/ # domain package source directory
|   |       |-- agents/ # Agent domain types
|   |       |-- providers/ # Provider domain types
|   |       |-- models/ # model metadata domain types
|   |       |-- route-policies/ # routing policy domain types
|   |       |-- limits/ # rate limit and budget domain types
|   |       `-- usage/ # Usage and Cost domain types
|   |
|   |-- db/ # database schema, migrations, and repositories
|   |   `-- src/ # db package source directory
|   |       |-- schema/ # future Drizzle schema definitions
|   |       |-- migrations/ # SQL database migration files
|   |       |-- repositories/ # data access wrappers
|   |       |-- connection.ts
|   |       `-- schema-version.ts
|   |
|   |-- protocol/ # external protocols and normalized protocol definitions
|   |   `-- src/ # protocol package source directory
|   |       |-- openai/ # OpenAI-compatible protocol types
|   |       |-- anthropic/ # Anthropic-compatible protocol types
|   |       |-- provider/ # Provider adapter protocol types
|   |       `-- normalized/ # Gateway internal normalized protocol types
|   |
|   |-- routing/ # deterministic routing rule engine
|   |   `-- src/ # routing package source directory
|   |       |-- policy-types.ts
|   |       |-- policy-compiler.ts
|   |       |-- rule-engine.ts
|   |       |-- model-selector.ts
|   |       `-- route-reason.ts
|   |
|   |-- providers/ # real Provider adapter implementations
|   |   `-- src/ # providers package source directory
|   |       |-- provider-adapter.ts
|   |       |-- provider-templates/ # allowlisted Provider templates
|   |       |-- openai-compatible/ # generic OpenAI-compatible adapter
|   |       |-- openai/ # OpenAI Provider adapter
|   |       |-- anthropic/ # Anthropic Provider adapter
|   |       |-- google/ # Google Gemini Provider adapter
|   |       |-- openrouter/ # OpenRouter Provider adapter
|   |       `-- ollama/ # Ollama / local provider adapter
|   |
|   |-- security/ # credential, authentication, and permission tools
|   |   `-- src/ # security package source directory
|   |       |-- api-key.ts
|   |       |-- secret-encryption.ts
|   |       |-- master-key.ts
|   |       |-- console-auth.ts
|   |       `-- permissions.ts
|   |
|   |-- jobs/ # shared background job models and execution abstractions
|   |   `-- src/ # jobs package source directory
|   |       |-- job-types.ts
|   |       |-- job-lease.ts
|   |       |-- job-runner.ts
|   |       `-- job-results.ts
|   |
|   |-- billing/ # cost estimation, price registry, and reconciliation
|   |   `-- src/ # billing package source directory
|   |       |-- cost-estimator.ts
|   |       |-- price-registry.ts
|   |       |-- savings.ts
|   |       `-- reconciliation.ts
|   |
|   |-- notifications/ # alert rules and delivery target models
|   |   `-- src/ # notifications package source directory
|   |       |-- alert-rules.ts
|   |       |-- notification-events.ts
|   |       `-- delivery-targets.ts
|   |
|   |-- config/ # config publishing, validation, and runtime settings
|   |   `-- src/ # config package source directory
|   |       |-- config-version.ts
|   |       |-- config-validation.ts
|   |       |-- dependency-check.ts
|   |       `-- runtime-settings.ts
|   |
|   |-- coordination/ # Postgres inter-process coordination contracts
|   |   `-- src/ # coordination package source directory
|   |       |-- channels.ts
|   |       |-- notification-payloads.ts
|   |       |-- listener.ts
|   |       `-- locks.ts
|   |
|   `-- ui/ # Console shared UI foundation package
|       `-- src/ # ui package source directory
|           |-- components/ # reusable base components
|           |-- hooks/ # shared Console React hooks
|           `-- styles/ # Tailwind / global style entry
|
|-- docs/ # product, architecture, and design docs
|   |-- PRODUCT.md
|   `-- ARCHITECTURE.md
|
|-- scripts/ # local development, migration, and maintenance scripts
|   |-- dev.ts
|   |-- migrate.ts
|   |-- check-schema.ts
|   `-- backup.ts
|
|-- package.json
|-- pnpm-workspace.yaml
|-- turbo.json
`-- tsconfig.base.json
```

## 10. Module Boundary Guidance

### 10.1 Gateway App Only Orchestrates Runtime

`apps/gateway` owns HTTP service, request pipeline, streaming, provider calls,
Postgres-notification-driven hot reload, and runtime data writes. Reusable
domain rules must not live in `apps/gateway`. Gateway runtime domain modules
live in `packages/gateway-runtime`, Worker runtime modules live in
`packages/worker-runtime`, shared routing calculation lives in
`packages/domain`, and provider adapters live in `packages/provider`.
`packages/db` keeps shared data access (client, config versions, migrations),
Console read/write modules, and cross-plane tables. Gateway runtime structure
invariants are enforced by
`tests/features/gateway-cohesion-refactor.unit.test.ts`.

### 10.2 Console App Only Handles Control-Plane Experience

`apps/console` owns pages, forms, configuration actions, Activity / Usage
display, Worker job status, and Runtime status views. Dependency checks, shared
config publisher calls, and import/export entry points can live in the Console
server layer, but shared types and domain rules should stay in packages.

### 10.3 Worker App Owns Async Tasks

`apps/worker` owns scheduled and asynchronous tasks, including model refresh,
provider health probes, price sync, billing reconciliation, alert evaluation,
notification delivery, log retention, and scheduled backup. Worker may use
`packages/providers` and `packages/security` to decrypt and call providers, but
it must not take over Agent synchronous model requests.

### 10.4 Shared Packages Keep Protocols Stable

Agent protocols, provider protocols, Route Policy, config publishing, config
validation, Postgres notification channels, database schema, and security tools
should be managed as shared packages. Gateway, Console, and Worker then use the
same type definitions, validation rules, and coordination contracts for the same
configuration objects.

## 11. Deployment Shapes

### 11.1 Local / Single-Node

- Gateway listens on `127.0.0.1` by default.
- Console allows local access only by default.
- Docker Compose keeps internal services listening on `0.0.0.0` for container
  networking, but host-published Gateway, Console, and Postgres ports bind to
  `127.0.0.1` unless their explicit publish-host variables are set.
- Compose has no public defaults for `MASTER_KEY`, `POSTGRES_PASSWORD`, or
  `CONSOLE_SETUP_TOKEN`; generate URL-safe random values before deployment.
- Fresh non-loopback Console setup is locked unless `CONSOLE_SETUP_TOKEN` is
  configured, and the submitted setup token must match before the admin password
  is created.
- Gateway, Console, and Worker can be started and supervised by one local
  supervisor or process manager.
- V1 supports only one active Gateway process handling requests. Multiple
  Workers are allowed if they deduplicate through Postgres job leases.
- PostgreSQL connection string is required. Local mode can use local Postgres,
  Docker Compose Postgres, or hosted Postgres.
- Provider Keys are encrypted at rest.
- Suitable for personal computers, local servers, or lightweight self-hosted
  deployments.

### 11.2 Docker / Server

- Gateway, Console, and Worker can run as multiple processes or under one
  supervisor.
- Non-localhost listeners must enable Console login.
- PostgreSQL is required for persistence, config hot reload notifications, job
  wakeup, and runtime status sharing.
- Network policy, firewall, and least-privilege database roles should restrict
  Postgres access.
- Data directory stores only export files, backup files, or optional local
  cache. It does not store the canonical database.

### 11.3 Single Binary

- Future distribution can bundle Gateway, Console static assets, Worker,
  migration, and runtime supervisor into one artifact.
- The default Single Binary shape is one application binary plus external
  PostgreSQL, or a local PostgreSQL sidecar managed by compose / supervisor. It
  is not a zero-dependency single-file database.
- The architecture still keeps the Gateway data plane and Console control plane
  boundaries.

## 12. Key Architecture Decisions

- TypeScript spans Gateway, Console, Worker, and shared packages to reduce
  protocol and configuration type drift.
- Gateway uses Fastify for streaming, low latency, Public API, and plugin-style
  request pipeline needs.
- Console uses Next.js for local management UI, form configuration, data
  display, and authentication onboarding.
- Background Worker owns model discovery, price sync, billing reconciliation,
  alerts, notifications, log retention, JSONL / webhook export, and scheduled
  backup tasks.
- PostgreSQL is the V1 canonical database and the communication medium among
  Gateway, Console, and Worker.
- `packages/db/config-versions` provides the shared config publisher. Console
  and Worker both use it to publish routing-visible config versions.
- Postgres `LISTEN/NOTIFY` waking Gateway through the config publisher is the
  fast path. Gateway periodic reconcile is the safety path.
- Gateway only exposes Public API. Console and Worker do not call private
  Gateway control interfaces.
- Console control feedback for Gateway is asynchronous and eventually
  consistent. The source of truth is applied config version, heartbeat, and
  failure events in Postgres.
- V1 supports one active Gateway process. Multiple Gateways require shared
  state for rate limits, budget counters, and concurrency first.
- Gateway uses immutable config snapshots. New requests use new configuration
  immediately after reload, while in-flight requests are unaffected.
- `/v1/responses` V1 supports a stateless subset and does not implement
  cross-provider response state by default.
- Console is not in the Agent request path. Gateway should continue processing
  requests while Console is temporarily unavailable.
- Console delete operations default to `deleted_at` soft deletes. Active queries
  for Agents, Providers, Provider Models, Virtual Models, and Route Policies
  filter deleted rows.
- Runtime history tables do not use database foreign keys. Hard delete remains
  a maintenance operation and must first confirm there are no active config
  dependencies or runtime history references; code paths that physically delete
  rows perform their own cleanup or reference clearing.
- Provider-derived model data uses availability markers to represent refresh
  results. Soft-deleted Provider Models do not participate in active routing,
  price sync, or health checks.
- Route Policy candidates are stored in `route_policy_candidates` as one ordered
  candidate pool. `candidate_order` expresses order. There is no separate
  `is_fallback` flag or `fallback_chain_items` table. The full fallback chain is
  derived at request time from Route Policy `strategy`: `fixed` uses
  `candidate_order`, `cost_first` / `quality_first` use estimated cost, and
  `random` randomizes. Unavailable candidates are excluded by provider/model
  health state.
- OpenAI-compatible long-tail providers reuse the generic adapter through
  built-in allowlisted templates. Arbitrary custom endpoints are not supported.
- Playground tests through Gateway Public API. The user manually enters an Agent
  API key and selects a Virtual Model Name. Console backend does not proxy the
  request or store the key.
- Gateway owns synchronous agent-limit admission, concurrency counting, and the
  in-memory health view. The database stores recoverable windows, budget period
  totals, health events, and health summaries.
- Gateway records baseline cost and request savings on the request path. Console
  aggregates and displays them. Worker only corrects actual cost / savings after
  cost reconciliation.
- Runtime settings are split between hot-reloadable and restart-required.
  Listen address, port, and data directory take effect through supervisor
  restart.
- Master key is stored outside the database and loaded by Gateway, Console, and
  Worker. Postgres credentials are separate from the master key.
- Migration and pre-upgrade backup are deployment / supervisor concerns, not
  Console-private services.
- Provider Keys are encrypted at rest. Agent API keys are stored as hashes.
  Prompt / response content is not stored by default.
