# LLMIngress Architecture

## Module ownership

```text
AI Agents -> Gateway -> Model Providers
                 |
Browser  -> Console -> PostgreSQL <- Worker
                 ^
                 |---- Gateway
```

- Gateway owns API key authentication, limits, routing, fallback, Provider execution, and request
  metadata recording.
- Console owns user-authored configuration and operational views. It never proxies API key traffic
  or performs Provider egress.
- Worker owns model discovery, exact Provider-connection probes, price synchronization, retention,
  and stale-concurrency repair.
- PostgreSQL owns durable configuration, jobs, counters, usage, cost, fallback, and connection
  health state.
- Code shared by applications belongs under `packages/`; app directories contain process or UI
  entrypoints only.

Console API actions commit all database reads and writes that make up one business mutation in one
PostgreSQL transaction owned by `packages/db`. Upstream network calls run outside that transaction;
after an upstream call succeeds, its related database state is committed atomically. Durable jobs
are enqueued only after the business transaction commits and are not part of that transaction.

## Request and configuration flow

```text
authenticate API key
  -> resolve an allowed Virtual Model
  -> order Route Policy candidates
  -> validate known capability requirements
  -> enforce enabled API key limits
  -> attach healthy credentials and execute fallback
  -> stream or return the Provider response
  -> record activity, usage, cost, and fallback metadata
```

Each Gateway request uses one immutable configuration snapshot. Reload validates a replacement
before atomically swapping it; failure retains the last-known-good snapshot. PostgreSQL
`LISTEN/NOTIFY` wakes reloads, while periodic reconcile covers missed notifications.

Chat Completions, Responses, and Messages keep their native Provider contracts.
Gateway strips browser transport headers before Provider dispatch and never repairs rejected
payload fields. A streaming attempt succeeds only after first-byte read-ahead; failures after a
client byte are not replayed.

Background recording is off the response path but tracked for shutdown. Logs exclude outbound
request bodies, credentials, prompts, successful responses, and tool content. Failed Provider
responses may be logged with status and response headers for diagnosis.

## Routing and health invariants

- One Virtual Model owns one Route Policy and at least one candidate.
- Strategies are `fixed`, `cost_first`, `load_balance`, and `tag`.
- A `tag` route serves the candidate named by `x-llmingress-route-tag` with only the `default`
  candidate behind it; requests are capability-checked against the selected candidate alone.
- For the other strategies, capability conflicts are rejected only when every relevant value is
  known.
- Unknown-price candidates remain eligible at the end of `cost_first`; successful unknown-price
  requests record tokens and zero monetary cost with an unavailable price source.
- Health identity is `(provider_id, provider_connection_id)`. API keys and OAuth tokens use their
  credential id; Local Providers use the Provider id.
- `provider_health_summary` is a sparse unhealthy denylist. Missing means healthy; recovery deletes
  the summary.
- Credential failures enqueue an exact probe. Network, Provider 5xx, model, and client failures do
  not directly change health.
- Probe retries are 5, 10, 30, then 60 minutes. A stale or disabled probe cannot commit state.

## Worker invariants

The durable Job Runner accepts exactly:

- `model_refresh`
- `provider_connection_probe`
- `price_sync`
- `provider_quota_probe`

Jobs use `FOR UPDATE SKIP LOCKED`, leases, heartbeat renewal, attempt fencing, bounded retries, and
`AbortSignal`. A Worker that loses its lease cannot overwrite a newer attempt.

Retention and stale-concurrency repair are idempotent in-process tasks protected by PostgreSQL
advisory locks. They create no `jobs` or `job_attempts`. Retention deletes in batches of at most
1,000 and preserves the health event referenced by the current summary.

Model refresh keeps every catalog source section (not just the price-sync allowlist) and, when a
model's own catalog misses, resolves its metadata by model id across the other catalogs, trusted
sources first, leaving genuinely ambiguous matches unresolved. Catalog source fetches share a
per-URL in-memory cache (`WORKER_MODEL_CATALOG_CACHE_TTL_MS`, 0 disables) with single-flight and
stale-on-error.

## Data invariants

- `api_keys.limits_enabled` is the only API-key-level Limits switch. Disabled rules remain stored.
- Runtime counters survive restart in `rate_limit_windows` and `budget_periods`.
- Completed requests use `request_activity`, `request_usage`, `request_costs`, and
  `fallback_events`.
- Provider health uses `provider_health_events` plus the sparse `provider_health_summary`.
- `api_keys.request_logging_mode` (`default` | `full`) decides whether the Gateway captures bodies.
  What it captured lives in `request_activity.payload` (jsonb, null when nothing was captured),
  capped at 1 MB per side with explicit truncation flags, and is deleted with its activity row.
- Console analytics and the Activity list read durable metadata and never select `payload`; only the
  Activity detail reads it, so bodies are visible only for keys explicitly set to `full`.
- Provider credentials are encrypted with `ENCRYPTION_KEY`; authenticated Provider requests do not
  follow redirects.

## Lifecycle and deployment invariants

- `/health/live` is process liveness.
- `/health/ready` and `/health` require PostgreSQL and a loaded configuration snapshot.
- Shutdown stops new requests, drains active streams and background recording, stops listeners,
  closes pools, and exits. Drain-timeout diagnostics contain safe metadata only.
- Runtime images use compiled output and non-root users. Console uses Next standalone output;
  Gateway and Worker start with `node`.
- Docker Compose uses two containers: one non-root multi-role application container (migrate on
  boot, then Gateway, Console, and Worker processes) and one official PostgreSQL 18.4 container.
- The pre-release schema is the single `0001_core_baseline.sql`: 23 product tables plus migration
  history, 24 total. Old development databases are recreated rather than mixed with this schema.
