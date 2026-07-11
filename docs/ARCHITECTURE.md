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
  fallback, and Provider health history.

Shared code used by more than one application belongs under `packages/`.

## Gateway Data Plane

Gateway supports Chat Completions, Responses, Anthropic Messages, Embeddings, and authorized
Virtual Model discovery. Protocol handlers read only fields required for authentication,
routing, capability validation, limits, and accounting. Agent payloads are otherwise passed
through with the Virtual Model name replaced by the selected real model id.

Each request captures an immutable configuration snapshot. Config reload builds and validates
a replacement snapshot, then swaps it atomically. Reload failure keeps the last-known-good
snapshot. PostgreSQL `LISTEN/NOTIFY` is only a wakeup mechanism; periodic reconcile protects
against missed notifications.

The request path is:

```text
authenticate Agent
  -> resolve allowed Virtual Model
  -> validate request capability contract
  -> enforce Agent limits
  -> order healthy route candidates
  -> execute credentials and fallback candidates
  -> stream or return Provider response
  -> record metadata, usage, cost, fallback, and health
```

JSON and Streaming share one fallback attempt executor. A Streaming attempt succeeds only
after first-byte read-ahead. Provider failures before the first client byte may advance to
another credential or candidate; failures after output begins are not replayed.

Background recording tasks are tracked and drained during shutdown. Prompt, response, and
tool content are not valid logging inputs. Logger redaction provides a second barrier for
authorization headers, cookies, keys, tokens, and body fields.

## Configuration and Routing

The Gateway snapshot contains enabled Agents, their Virtual Model grants, Providers, model
capabilities and prices, Virtual Models, Route Policies, candidates, and enabled limits.

One Virtual Model maps to one Route Policy. A policy contains an endpoint protocol, strategy,
and ordered candidate models. Supported strategies are `fixed`, `cost_first`, and `random`.
Candidate health is applied before ordering. The full ordered result is the fallback chain.

Candidate models must share one complete six-field capability contract:

- input and output modalities
- maximum context and output tokens
- function calling
- reasoning

Console validates the contract transactionally on create/update. Gateway also validates
historical configuration and request requirements before Provider execution.

## Console Control Plane

Console pages are Overview, Agents, Providers, Virtual Models, Activity, Usage, Limits, and
Playground. Console APIs perform authenticated, CSRF-protected configuration writes through
the shared config publisher transaction.

Console never proxies Agent traffic and never performs Provider egress. Long Provider actions
enqueue one of the allowed Worker jobs. Ordinary Console reads use the shared PostgreSQL pool;
dedicated connections are reserved for migrations, listeners, and test fixtures.

## Worker Task Plane

The durable Job Runner supports exactly three product operations:

- model refresh
- Provider connectivity check
- price sync

Jobs use PostgreSQL `FOR UPDATE SKIP LOCKED`, leases, heartbeat renewal, attempt fencing,
bounded retries, and `AbortSignal`. Completion or failure from a Worker that lost its lease
cannot overwrite a newer attempt.

Internal stale-concurrency repair and retention run directly on an in-process schedule under
a PostgreSQL advisory lock. They are idempotent and create no rows in `jobs` or
`job_attempts`. Restart duplication is acceptable.

Retention defaults:

- request Activity, Usage, Cost, and Fallback: 30 days
- terminal Jobs and Attempts: 7 days
- Provider health events: 30 days, preserving the event referenced by current summary

Deletes run in batches of at most 1,000 and check the shutdown signal between batches.

## Provider Model Data

Worker model refresh merges the Provider API with models.dev, OpenRouter, LiteLLM, and Vercel.
Missing values remain unknown; model names are not used to infer core capabilities. Explicit
source conflicts resolve to unknown until a manual override is provided. Manual values take
precedence over synchronized values.

Provider credentials remain encrypted with the deployment master key. Authenticated Provider
HTTP calls do not follow redirects. Connectivity probes and model-list requests share the same
credential safety policy.

## Runtime State and Accounting

Agent limits use `agent_limits`, current `rate_limit_windows`, and `budget_periods`. Gateway
keeps low-latency process state where appropriate but writes restart-recoverable counters to
PostgreSQL.

Completed request metadata is stored in `request_activity`, `request_usage`, `request_costs`,
and `fallback_events`. Provider health history and current state use
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
