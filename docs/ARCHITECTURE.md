# LLMIngress Architecture

## System Boundaries

LLMIngress has three application processes and one PostgreSQL database:

```text
AI Agents -> Gateway -> Model Providers
                 |
Browser  -> Console
                 |
             PostgreSQL <- Worker
```

- Gateway owns authenticated request execution, limit enforcement, routing, fallback, and
  request metadata recording.
- Console owns user-authored configuration and operational views.
- Worker owns Provider model discovery, connectivity probes, and price synchronization.
- PostgreSQL is the durable owner of configuration, jobs, runtime counters, usage, cost,
  fallback, and Provider-connection health history.

Shared code used by more than one application belongs under `packages/`.

## Gateway Data Plane

Gateway supports Chat Completions, Responses, Anthropic Messages, Embeddings, and authorized
Virtual Model discovery. Protocol handlers read only fields required for authentication,
routing, capability validation, limits, and accounting. Agent payloads are otherwise passed
through with the Virtual Model name replaced by the selected real model id.
Provider protocol headers are preserved, while browser transport headers such as `Origin`,
`Referer`, browser `User-Agent`, and every `Sec-*` header are removed before Provider dispatch.
Responses requests use one strict canonical boundary: `input` must be a non-empty item array and
message content must already be structured parts. Gateway does not repair string input, force
Provider parameters, remove rejected fields, or bridge Provider SSE into non-streaming JSON.

Each request captures an immutable configuration snapshot. Config reload builds and validates
a replacement snapshot, then swaps it atomically. Reload failure keeps the last-known-good
snapshot. PostgreSQL `LISTEN/NOTIFY` is only a wakeup mechanism; periodic reconcile protects
against missed notifications.

The request path is:

```text
authenticate Agent
  -> resolve allowed Virtual Model
  -> validate request capability contract
  -> enforce Agent limits when the Agent limits switch is enabled
  -> order route candidates
  -> exclude unhealthy Provider connections and execute credential/candidate fallback
  -> stream or return Provider response
  -> record metadata, usage, cost, and fallback
```

JSON and Streaming share one fallback attempt executor. A Streaming attempt succeeds only
after first-byte read-ahead. Provider failures before the first client byte may advance to
another credential or candidate; failures after output begins are not replayed.

Background recording tasks are tracked and drained during shutdown. Request prompts, successful
responses, and tool content are not valid logging inputs. Failed Provider responses are logged in
full with their status and response headers for diagnosis, without request bodies or credential
headers. Logger redaction provides a second barrier for authorization headers, cookies, keys,
tokens, and request body fields.

## Configuration and Routing

The Gateway snapshot contains enabled Agents, their Virtual Model grants, Providers, model
capabilities and prices, Virtual Models, Route Policies, candidates, and enabled limits.

One Virtual Model maps to one Route Policy. A policy contains an endpoint protocol, strategy,
and ordered candidate models. Supported strategies are `fixed`, `cost_first`, and `random`.
The full ordered result is the fallback chain. Health does not exist at Provider or model scope;
Gateway applies connection health only when it attaches API keys, OAuth tokens, or the Local
Provider's logical connection.
Console creates a Virtual Model, its Route Policy, and at least one candidate in one transaction;
the configuration API cannot create a new unroutable Virtual Model.

Candidate models use an optimistic six-field capability contract:

- input and output modalities
- maximum context and output tokens
- function calling
- reasoning

Console rejects only conflicting known values; unknown values are allowed. Gateway validates
request requirements only for fields that are known across every candidate.

`cost_first` orders priced candidates by input price plus output price without request
token weighting. Unknown-price candidates remain eligible at the end of the fallback chain.
Successful unknown-price requests record zero monetary cost with an unavailable price source.

## Console Control Plane

Console pages are Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, and
Playground. Console APIs perform authenticated configuration writes through
the shared config publisher transaction.

Console never proxies Agent traffic and never performs Provider egress. Long Provider actions
enqueue one of the allowed Worker jobs. Ordinary Console reads use the shared PostgreSQL pool;
dedicated connections are reserved for migrations, listeners, and test fixtures.

## Worker Task Plane

The durable Job Runner supports exactly three product operations:

- model refresh
- Provider connection probe
- price sync

`model_refresh` updates catalog data only. `provider_connection_probe` targets one exact current
connection and tests up to three distinct chat models in ranking order. Any successful model marks
the connection healthy; all selected models must fail before it is unhealthy. When no stored model
is available, Worker performs model discovery with the same connection. Successful discovery with
no eligible chat model is inconclusive and writes no health state. Provider HTTP calls run before
the short PostgreSQL transaction.

Jobs use PostgreSQL `FOR UPDATE SKIP LOCKED`, leases, heartbeat renewal, attempt fencing,
bounded retries, and `AbortSignal`. Completion or failure from a Worker that lost its lease
cannot overwrite a newer attempt.

Internal stale-concurrency repair and retention run directly on an in-process schedule under
a PostgreSQL advisory lock. They are idempotent and create no rows in `jobs` or
`job_attempts`. Restart duplication is acceptable.

Retention defaults:

- request Activity, Usage, Cost, and Fallback: 30 days
- terminal Jobs and Attempts: 7 days
- Provider-connection health events: 30 days, preserving the event referenced by current summary

Deletes run in batches of at most 1,000 and check the shutdown signal between batches.

## Provider Model Data

Worker model refresh merges the Provider API with models.dev, OpenRouter, LiteLLM, and Vercel.
The first available value wins in that order, so lower-priority sources only fill missing fields.
Missing values remain unknown; model names are not used to infer core capabilities. Manual values
take precedence over synchronized values.
Every model explicitly returned by the Provider API is retained even when context or price data is
unavailable; Console renders those nullable values as Unknown.

Provider credentials remain encrypted with the deployment master key. Authenticated Provider
HTTP calls do not follow redirects. Connectivity probes and model-list requests share the same
credential safety policy.

## Provider Connection Health

Health identity is exactly `(provider_id, provider_connection_id)`. API keys and OAuth tokens use
their credential row id. A Local Provider uses the Provider id as a logical connection and does not
load a secret.

`provider_health_summary` is a sparse denylist: it stores only `unhealthy` connections, so an
absent row means healthy. A successful probe deletes the row. API key/OAuth creation, material
modification, and enablement enqueue an exact probe; Console can enqueue the same probe manually.
Gateway credential failures enqueue a probe asynchronously, while network, Provider 5xx, model,
and client-request failures do not directly change health.

On confirmed failure, Worker records one aggregate event and schedules the exact connection after
5, 10, 30, then 60 minutes; later failures remain at 60 minutes. Recovery deletes the summary and
cancels its pending retry. Provider base URL changes and connection rotation/disable/delete clear
the prior summary. Before committing any result Worker revalidates the current Provider and
credential snapshot; stale or disabled work is canceled without a result or successor job.

Gateway reads the sparse denylist while loading current credentials, filters only unhealthy
connections, and continues normal credential/candidate fallback. If a Provider has no usable
connection, Gateway returns `provider_connection_unavailable`. Model catalog rows have no health
state and are never filtered by health.

## Runtime State and Accounting

`agents.limits_enabled` is the sole Agent-level switch for limit enforcement. When it is false,
Gateway does not read `agent_limits` or perform budget, rate, token, or concurrency checks. When
it is true, Gateway enforces enabled rules from `agent_limits` using current
`rate_limit_windows` and `budget_periods`. Disabling the switch preserves the rules so they can
be restored without recreation. Gateway keeps low-latency process state where appropriate but
writes restart-recoverable counters to PostgreSQL.

Completed request metadata is stored in `request_activity`, `request_usage`, `request_costs`,
and `fallback_events`. Provider-connection health history and its sparse unhealthy state use
`provider_health_events` and `provider_health_summary`. Console analytics read these durable
tables and never query Prompt content.

## Health and Lifecycle

- `/health/live` confirms only process liveness.
- `/health/ready` checks PostgreSQL with a short timeout and requires at least one successfully
  loaded config snapshot.
- `/health` has the same semantics as readiness.

Shutdown order is: stop accepting requests, finish active streams, stop config listeners,
drain tracked background tasks, close PostgreSQL pools, and exit. A drain timeout logs only
safe task metadata and exits non-zero.

## Deployment and Schema

Container runtimes use compiled output, non-root users, and no repository source, tests, or
development dependencies. Console uses Next standalone output. Gateway and Worker start with
`node`.

The pre-release database uses a single core baseline migration. Development databases created
from older migration histories are recreated. Runtime and configuration services from
different schema generations are not mixed.

The schema excludes notifications, webhook delivery, external exports, backup state, runtime
heartbeat/error tables, tracing, metrics, and billing reconciliation.
