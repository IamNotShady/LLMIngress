# Provider Quota And Balance

Design document for observing upstream account balance and usage-window utilization per Provider
connection. Implemented as the `provider-quota-probe` and `provider-quota-console` entries in
`feature_list.json`; the sections below are the reference for how and why.

Scope is deliberately narrow: **remaining balance** and **usage percentage** of the upstream
account. Per-request cost is already covered by `usage-and-activity` and is out of scope here.
Per-minute rate-limit headers (`x-ratelimit-*`, `anthropic-ratelimit-requests-*`) are flow-control
state, not account state, and are also out of scope.

Every Provider is read the same way: Worker calls a probe on a schedule. Nothing is collected from
the Gateway response path. See section 7 for why.

## 1. Availability per Provider

Twelve remote Provider choices exist today: 10 templates plus the two hardcoded direct choices
(`openai`, `anthropic`) in `apps/console/src/app/_modules/providers-section.tsx`. Local Providers
have no billing.

Eight can be probed with the credential the Provider already stores.

| Provider | Value | Endpoint | Fields |
| --- | --- | --- | --- |
| `claude_code` | usage % + balance | `GET https://api.anthropic.com/api/oauth/usage`, `Authorization: Bearer <oauth token>`, `anthropic-beta: oauth-2025-04-20` | Top-level keys `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, each `{utilization, resets_at}`. Plus `extra_usage` `{is_enabled, monthly_limit, used_credits, utilization, currency}` |
| `openai_codex` | usage % | `GET https://chatgpt.com/backend-api/wham/usage`, `Authorization: Bearer <token>`, `User-Agent: codex-cli` | `rate_limit.primary_window.used_percent`, `rate_limit.secondary_window.used_percent`, each with `reset_at` and `limit_window_seconds` |
| `deepseek` | balance | `GET https://api.deepseek.com/user/balance` | `balance_infos[].total_balance`, `.granted_balance`, `.topped_up_balance`, `.currency`, plus `is_available` |
| `moonshot` | balance | `GET https://api.moonshot.ai/v1/users/me/balance` | `data.available_balance`, `data.cash_balance`, `data.voucher_balance` |
| `openai` | balance | `GET /v1/dashboard/billing/credit_grants` | `total_available`, `total_granted`, `total_used` |
| `openrouter` | balance | `GET /api/v1/key` | `data.limit_remaining`, `data.limit` |
| `zai` | usage % | `GET https://api.z.ai/api/monitor/usage/quota/limit` | `data.limits[].percentage` (`0`–`100`), `.nextResetTime` (epoch **milliseconds**) |
| `minimax` | usage % | `GET https://api.minimax.io/v1/token_plan/remains` | `current_interval_remaining_percent`, `current_weekly_remaining_percent` |

Four cannot, with the stored credential:

| Provider | Reason | `error_code` |
| --- | --- | --- |
| `anthropic` | Usage and cost live in the Admin API and require a separate `sk-ant-admin...` key sent as `x-api-key` | `requires_separate_credential` |
| `xai` | Balance lives on `management-api.x.ai` and requires a separately provisioned Management Key plus `team_id` | `requires_separate_credential` |
| `google` | No endpoint exists on the OpenAI-compatible surface; balance is visible only in AI Studio. Programmatic quota needs a GCP project with OAuth/service-account credentials and IAM | `not_supported` |
| `qwen` | The international deployment has no working path. The console RPC requires a `login_aliyunid_ticket` cookie that only China accounts receive | `not_supported` |

### Caveats that affect correctness

- **Three endpoints are undocumented and carry no stability guarantee.** `claude_code`'s
  `/api/oauth/usage` is the internal endpoint the Claude Code CLI calls with its OAuth token.
  `zai`'s quota path appears in no official documentation. `openai`'s `credit_grants` is a legacy
  path absent from the API reference. All three work today and all three can break without notice.
  Probe failures against them must degrade to `probe_failed` and never affect routing.
- **`openai` returns 403 for project-scoped keys** and for keys without billing access. Record
  `unauthorized` rather than treating this as a transport failure. The official
  `GET /v1/organization/costs` requires an Admin key and reports spend, not remaining balance, so it
  is not a substitute.
- **`zai` auth header format is disputed.** Two independent open-source implementations disagree:
  one sends `Authorization: Bearer <token>`, the other sends the raw token with no scheme. Attempt
  `Bearer` first and fall back to raw. The `data.limits[].unit` field's meaning is not documented
  anywhere; do not depend on it. The endpoint returns usable limits only for accounts holding a GLM
  Coding Plan.
- **`zai` path is not a suffix of the configured base URL.** The template base URL is
  `https://api.z.ai/api/paas/v4` while the quota path is `https://api.z.ai/api/monitor/usage/quota/limit`.
  Derive the origin, not a path join. Every other probe in the table is a suffix of its base URL.
- **`minimax` returns remaining, not consumed.** `current_interval_remaining_percent` must be
  inverted. The `coding_plan/remains` path used by some third-party tools is broken — it rejects API
  keys and demands a browser cookie session — so `token_plan/remains` is the only viable path.
- **`moonshot` and `minimax` distinguish key classes.** A platform key and a coding-plan key are not
  interchangeable, and the wrong class silently yields empty or zero quota rather than an error.
  Treat an all-zero result as suspect, not as authoritative.
- **`openrouter` `limit_remaining` is nullable.** Null means no limit is configured on the key, which
  is not the same as zero. Emit no entry rather than a zero entry.
- **Balance is usually account-scoped, not credential-scoped.** Several API keys belonging to one
  upstream account report the same balance. `openrouter`'s `limit_remaining` is a genuine per-key
  value. Storing per connection is correct for both, but Console must not present N identical
  balances as N independent pools.
- **A subscription is consumed outside this gateway too.** A `claude_code` or `openai_codex` account
  is also drawn down by the user's local CLI. Utilization therefore moves with zero gateway traffic,
  and the probe interval is the upper bound on detection lag.

## 2. Normalization

Raw shapes differ per Provider. Normalize before persisting.

| Provider | Raw | Transform |
| --- | --- | --- |
| `claude_code` | `utilization` `0`–`100` (**percent** — a live account showed 24/53; the `anthropic-ratelimit-unified-*` response headers use a 0–1 fraction, do not conflate the two surfaces); `extra_usage.used_credits` number | divide by 100; emit `extra_usage` as a separate balance entry when `is_enabled` |
| `openai_codex` | `used_percent` `0`–`100` | divide by 100; derive window name from `limit_window_seconds` |
| `zai` | `percentage` `0`–`100`; `nextResetTime` epoch ms | divide by 100; ms to ISO 8601 |
| `minimax` | `*_remaining_percent` (remaining) | `1 - x / 100` |
| `deepseek` | `total_balance` string | use directly |
| `moonshot` | `available_balance` number | render to decimal string; currency from the host — `.cn` bills CNY, `.ai` bills USD |
| `openai` | `total_available` number | render to decimal string |
| `openrouter` | `limit_remaining` number or null | render to decimal string; null emits no entry |

Monetary values are stored as decimal strings, never JSON numbers. DeepSeek already returns strings,
and `jsonb` numbers are IEEE 754, which loses precision on currency.

`claude_code` must be parsed structurally, not against a window-name allowlist: iterate the
top-level keys, skip `extra_usage`, and treat any value shaped like `{utilization, resets_at}` as a
window. Anthropic adds windows over time — `seven_day_opus` is absent from the response headers but
present here — and a structural parser absorbs that without a code change.

## 3. Schema changes

### 3.1 New table

All schema changes ship as one incremental migration, `packages/db/migrations/0002_provider_quota.sql`.
The baseline stays byte-identical: the migration runner verifies applied checksums, so editing
`0001_core_baseline.sql` would force every existing database — developer machines and self-hosted
deployments alike — through a rebuild for no benefit. An earlier revision of this document said to
edit the baseline; that was a misreading of the recreate-rather-than-upgrade note in
`docs/PRODUCT.md`, which is about pre-squash development chains, not a license to rewrite shipped
migrations.

```sql
CREATE TABLE public.provider_quota_summary (
    id uuid NOT NULL,
    provider_id uuid NOT NULL,
    provider_connection_id uuid NOT NULL,
    entries jsonb DEFAULT '[]'::jsonb NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL,
    next_refresh_at timestamp with time zone,
    error_code text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_quota_summary_entries_check CHECK ((jsonb_typeof(entries) = 'array'::text)),
    CONSTRAINT provider_quota_summary_error_code_check CHECK (((error_code IS NULL) OR (error_code = ANY (ARRAY['not_supported'::text, 'requires_separate_credential'::text, 'probe_failed'::text, 'unauthorized'::text]))))
);

ALTER TABLE ONLY public.provider_quota_summary
    ADD CONSTRAINT provider_quota_summary_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX uq_provider_quota_summary_connection
    ON public.provider_quota_summary USING btree (provider_id, provider_connection_id);
```

`error_code` uses `text` with a `CHECK` constraint, matching `providers.provider_type` and
`provider_health_events.status`. In PostgreSQL `text` and `varchar(n)` share one storage
representation, so a length cap would save nothing.

Worker is the only writer, so no write-ordering rule is needed between writers. The write is
update-first: a routine refresh is a single `update ... where` on the summary row and never touches
the credential tables. A miss means either the connection's first observation or a deletion that
cleared the row mid-probe — inserting blindly would resurrect the cleared row as a permanent orphan
— so only the insert branch verifies the credential is still live, under a row lock so a concurrent
soft-delete waits and its clear still wins.

### 3.2 Credential table changes

Probing consumes upstream request quota, so it must be switchable per connection — the Console
quota cell carries a Pause/Resume control per credential. This is configuration and therefore
belongs on the credential tables, not on the observation table.

```sql
-- 0002_provider_quota.sql
ALTER TABLE public.provider_api_keys
    ADD COLUMN quota_probe_enabled boolean DEFAULT true NOT NULL;

ALTER TABLE public.provider_oauth
    ADD COLUMN quota_probe_enabled boolean DEFAULT true NOT NULL;
```

### 3.3 Job type

A new persistent Worker job is required.

Postgres cannot alter a `CHECK` constraint in place, so `0002` swaps it, re-listing every existing
job type:

```sql
-- 0002_provider_quota.sql
ALTER TABLE public.jobs
    DROP CONSTRAINT jobs_job_type_check;

ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_job_type_check CHECK ((job_type = ANY (ARRAY['model_refresh'::text, 'provider_connection_probe'::text, 'price_sync'::text, 'provider_quota_probe'::text])));
```

### 3.4 Field diff summary

| Table | Field | Change |
| --- | --- | --- |
| `provider_quota_summary` | whole table | new |
| `provider_api_keys` | `quota_probe_enabled boolean NOT NULL DEFAULT true` | added |
| `provider_oauth` | `quota_probe_enabled boolean NOT NULL DEFAULT true` | added |
| `jobs` | `jobs_job_type_check` | extended with `provider_quota_probe` |

No column is removed or retyped.

### 3.5 Why not columns on the credential tables

Balance and utilization are observed state, refreshed on a schedule. Writing them into
`provider_api_keys` and `provider_oauth` would put recurring writes on configuration tables and blur
the ownership line drawn in `docs/ARCHITECTURE.md`, where Console owns user-authored configuration.
They are also not scalar: Claude reports four windows plus an overage balance, Codex two windows,
and DeepSeek one entry per currency. Finally, the two credential tables would each need a duplicate
set of columns.

### 3.6 Why no denormalized scalar columns

Gateway resolves each request against one immutable configuration snapshot, so quota reaches the
request path through that snapshot rather than a per-request query. Extracting `worst_utilization`
or `exhausted` into their own columns would optimize a read that never happens on the hot path.

Add a scalar only when a SQL-level filter or sort actually needs one — for example a Console view
listing connections above 90% utilization. Use a generated column so a second source of truth is
never introduced:

```sql
ALTER TABLE public.provider_quota_summary
    ADD COLUMN worst_utilization numeric(5,4)
    GENERATED ALWAYS AS (/* jsonb expression over entries */) STORED;
```

### 3.7 Why `provider_health_summary`'s sparse convention does not carry over

`provider_health_summary` is a sparse denylist: a missing row means healthy. For quota, a missing row
means never observed, which is distinct from observed-and-sufficient. Rows must therefore be written
even for Providers that cannot report, using `entries = '[]'` and an `error_code`. Without that,
Console cannot distinguish "cannot be retrieved" from "not yet queried".

## 4. `entries` format

Two entry shapes, distinguished by field presence rather than by a discriminator field. One array may
hold both: `claude_code` emits window entries plus an overage balance entry.

```ts
type WindowEntry = {
  window: string;        // normalized window id, e.g. "5h" | "7d" | "7d_opus" | "7d_sonnet"
  utilization: number;   // 0..1, fraction consumed
  resetsAt?: string;     // ISO 8601
};

type BalanceEntry = {
  currency: string;      // ISO 4217
  total: string;         // decimal string
  granted?: string;
  toppedUp?: string;
};

type QuotaEntry = WindowEntry | BalanceEntry;
```

A consumer discriminates on `"window" in entry` versus `"currency" in entry`. Console renders each
entry according to its own shape, so no Provider-level type tag is required anywhere.

```jsonc
// windows only — openai_codex, zai, minimax
[{"window":"5h","utilization":0.0741,"resetsAt":"2026-07-20T12:00:00Z"},
 {"window":"7d","utilization":0.5312,"resetsAt":"2026-07-24T03:00:00Z"}]

// balance only — deepseek, moonshot, openai, openrouter
[{"currency":"CNY","total":"110.00","granted":"10.00","toppedUp":"100.00"}]

// mixed — claude_code with overage enabled
[{"window":"5h","utilization":0.0741,"resetsAt":"2026-07-20T12:00:00Z"},
 {"window":"7d","utilization":0.5312,"resetsAt":"2026-07-24T03:00:00Z"},
 {"currency":"USD","total":"76.50"}]

// unavailable
[]
```

## 5. Descriptor extension

`ProviderBehavior` in `packages/config/src/provider-registry.ts` gains one optional field, and
`packages/provider/src/descriptor.ts` — a thin re-export shim since the provider-registry refactor —
adds the type to its `export type { ... }` block. The field answers exactly one question: should
Worker schedule a probe for this `providerKey`. It carries no endpoint, no field mapping, and no
shape tag — endpoints and parsing live entirely in `quota-probe.ts`, matching how `modelListStyle`
and `connectivityProbeStyle` already delegate to their implementing modules.

```ts
export type ProviderQuotaSource =
  | { supported: true }
  | { supported: false; reason: "requires_separate_credential" | "not_supported" };

export type ProviderDescriptor = {
  // ...existing fields
  quotaSource?: ProviderQuotaSource;
};
```

Providers with no `quotaSource` — including any custom `providerKey` created through
`action=create` — are treated as `{ supported: false, reason: "not_supported" }`.

## 6. Change list

| File | Change |
| --- | --- |
| `packages/db/migrations/0002_provider_quota.sql` | New incremental migration: `provider_quota_summary` table, primary key, unique index; `quota_probe_enabled` on `provider_api_keys` and `provider_oauth`; `jobs_job_type_check` swap. The baseline stays untouched |
| `packages/db/src/provider-quota.ts` | New. Read and upsert `provider_quota_summary`, mirroring `provider-health.ts` |
| `packages/db/src/console-provider-quota.ts` | New. Console read model, mirroring `console-provider-health.ts` |
| `packages/db/src/provider-jobs.ts` | Enqueue `provider_quota_probe`; add `quota_probe_enabled = true` to the connection-enumeration predicate |
| `packages/db/package.json` | Add `./provider-quota` and `./console-provider-quota` export subpaths — without them the imports do not resolve |
| `packages/config/src/provider-registry.ts` | Define `ProviderQuotaSource`; add `quotaSource?` to `ProviderBehavior`; populate `behavior.quotaSource` on the 12 remote entries |
| `packages/provider/src/descriptor.ts` | Re-export `ProviderQuotaSource` from the registry |
| `packages/provider/src/quota-probe.ts` | New. Holds each Provider's endpoint, request construction, response parsing, and normalization to `QuotaEntry[]`; exported as a lookup keyed by `providerKey`. Credential-agnostic: takes an already-resolved key or access token |
| `packages/provider/package.json` | Add the `./quota-probe` export subpath |
| `packages/worker-runtime/src/worker-provider-quota-probe.ts` | New. Job handler; skips connections with `quota_probe_enabled = false`; resolves and refreshes credentials; writes the summary row |
| `packages/worker-runtime/src/worker-maintenance-scheduler.ts` | Add a `provider-quota-probe-enqueue` task that enqueues jobs for connections whose `next_refresh_at` has passed or which have no row yet |
| `apps/worker/src/main.ts` | Register `provider_quota_probe` in the `handlers` map. The job runner derives claimable types from the map keys, so there is no separate registry to edit |
| `apps/console/src/app/_modules/providers-section.tsx` | Render quota per connection; show `observed_at` staleness; show `error_code` reason; a disabled or probing-off connection renders "Probing paused" instead of its ever-aging stored numbers |
| `docs/PRODUCT.md` | Add `provider_quota_probe` to the persistent Worker job list |
| `feature_list.json` | Two new entries, `provider-quota-probe` and `provider-quota-console` |

No Gateway file changes. Probe requests must not log credentials, and probe responses must not be
logged as bodies, consistent with the existing rule that outbound bodies and credentials stay out of
logs.

## 7. Considered and rejected: collecting from the response path

`claude_code` responses carry `anthropic-ratelimit-unified-*` headers with the same window
utilization the probe returns, and reading them in Gateway would cost no upstream requests. It was
rejected for V1.

The saving is one request per connection per interval. The cost is a header reader in Gateway, a
hook in `gateway-background-tasks.ts` with shutdown tracking, in-memory write throttling (the headers
arrive on every response, so unthrottled writes would make the table a write hotspot), a
write-ordering rule between two writers, and a per-Provider source list in the descriptor. Throttling
writes to the minute scale also discards most of the freshness advantage that motivated the approach.

`claude_code` is also the only candidate. `openai_codex`'s `codex.rate_limits` SSE event carries only
booleans, not percentages, and `openrouter`'s in-body `usage.cost` is per-request cost, which is out
of scope. One candidate does not justify a second collection mechanism.

This becomes worth revisiting if quota-aware routing is ever adopted, since down-weighting a
near-exhausted connection wants sub-second freshness that polling cannot provide.

## 8. Out of scope

- Per-request cost attribution. Already handled by `usage-and-activity`.
- Rate-limit headers as a data product. `x-ratelimit-*` and `anthropic-ratelimit-requests-*` describe
  per-minute flow control, not account state.
- Quota-aware routing. Using utilization to down-weight a near-exhausted connection in
  `load_balance` is a plausible follow-up but is a Route Policy change, not part of this work.
- Notifications and alerts on low balance. `docs/PRODUCT.md` lists these as unsupported in V1.
- History or trend charts. Only current state is stored; there is no `provider_quota_events` table.
  Add one later if a trend view is required.
- Balance for `anthropic`, `xai`, `google`, and `qwen`. Each would require a second credential type
  on the Provider, which is a larger change to the credential model.

## 9. Prior art

cc-switch (`farion1231/cc-switch`) solves the same problem for a desktop client and made opposite
storage choices, for reasons that do not transfer.

| | cc-switch | Here |
| --- | --- | --- |
| Config location | `providers.meta` JSON blob | `descriptor.ts` compile-time constant |
| Vendor-specific fields | Flattened onto one `UsageScript` interface | Not stored |
| Result persistence | In-memory only, lost on restart | Persisted |
| Result model | Two parallel models (`UsageData`, `QuotaTier`) | One `entries` array, two entry shapes |
| Key granularity | Subscription by app, script by `(app, provider)` | `(provider_id, provider_connection_id)` |
| Monetary type | `number` | decimal string |

cc-switch stores configuration because its users author the query themselves, and skips persistence
because a single desktop process can re-query cheaply on restart. Here the vendor semantics are fully
determined by `providerKey` so nothing needs storing, while Worker writes and Console reads are
separate processes, so persistence is required. The two decisions invert.

cc-switch also permits user-authored JavaScript for unsupported vendors. That is safe in a
single-user desktop application and is not safe in a self-hosted server, so it is not adopted.
