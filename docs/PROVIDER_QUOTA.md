# Provider Quota And Balance

Design document for observing upstream account balance and usage-window utilization per Provider
connection. This document describes intended changes only; no code implements it yet.

Scope is deliberately narrow: **remaining balance** and **usage percentage** of the upstream
account. Per-request cost is already covered by `usage-and-activity` and is out of scope here.
Per-minute rate-limit headers (`x-ratelimit-*`, `anthropic-ratelimit-requests-*`) are flow-control
state, not account state, and are also out of scope.

## 1. Availability per Provider

Twelve remote Provider choices exist today: 10 templates plus the two hardcoded direct choices
(`openai`, `anthropic`) in `apps/console/src/app/_modules/providers-section.tsx`. Local Providers
have no billing.

Eight can expose balance or usage percentage with the credential the Provider already stores.

| Provider | Value | How | Field |
| --- | --- | --- | --- |
| `claude_code` | usage % | response header | `anthropic-ratelimit-unified-5h-utilization`, `-7d-utilization`, `-7d_sonnet-utilization` (each `0.0`–`1.0`), plus `-*-reset` (unix seconds) |
| `claude_code` | usage % | active probe | `GET https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20` → `five_hour.utilization`, `seven_day.utilization`, `seven_day_sonnet.utilization`, each with `resets_at` |
| `openai_codex` | usage % | active probe | `GET https://chatgpt.com/backend-api/wham/usage` → `rate_limit.primary_window.used_percent`, `rate_limit.secondary_window.used_percent`, each with `reset_at` and `limit_window_seconds` |
| `deepseek` | balance | active probe | `GET https://api.deepseek.com/user/balance` → `balance_infos[].total_balance`, `.granted_balance`, `.topped_up_balance`, `.currency`, plus `is_available` |
| `moonshot` | balance | active probe | `GET https://api.moonshot.ai/v1/users/me/balance` → `data.available_balance`, `data.cash_balance`, `data.voucher_balance` |
| `openai` | balance | active probe | `GET /v1/dashboard/billing/credit_grants` → `total_available`, `total_granted`, `total_used` |
| `openrouter` | balance | active probe | `GET /api/v1/key` → `data.limit_remaining`, `data.limit` |
| `zai` | usage % | active probe | `GET https://api.z.ai/api/monitor/usage/quota/limit` → `data.limits[].percentage` (`0`–`100`), `.nextResetTime` (epoch **milliseconds**) |
| `minimax` | usage % | active probe | `GET https://api.minimax.io/v1/token_plan/remains` → `current_interval_remaining_percent`, `current_weekly_remaining_percent` |

Four cannot, with the stored credential:

| Provider | Reason | `error_code` |
| --- | --- | --- |
| `anthropic` | Usage and cost live in the Admin API and require a separate `sk-ant-admin...` key sent as `x-api-key` | `requires_separate_credential` |
| `xai` | Balance lives on `management-api.x.ai` and requires a separately provisioned Management Key plus `team_id` | `requires_separate_credential` |
| `google` | No endpoint exists on the OpenAI-compatible surface; balance is visible only in AI Studio. Programmatic quota needs a GCP project with OAuth/service-account credentials and IAM | `not_supported` |
| `qwen` | The international deployment has no working path. The console RPC requires a `login_aliyunid_ticket` cookie that only China accounts receive | `not_supported` |

### Caveats that affect correctness

- **`openai` uses an undocumented legacy endpoint.** `/v1/dashboard/billing/credit_grants` is not in
  the official API reference. Project-scoped keys and keys without billing access receive `403`.
  Record `unauthorized` rather than treating this as a transport failure. The official
  `GET /v1/organization/costs` requires an Admin key and reports spend, not remaining balance, so it
  is not a substitute.
- **`zai` is entirely undocumented.** Two independent open-source implementations disagree on the
  auth header: one sends `Authorization: Bearer <token>`, the other sends the raw token with no
  scheme. Attempt `Bearer` first and fall back to raw. The `data.limits[].unit` field's meaning is
  not documented anywhere; do not depend on it. The endpoint returns usable limits only for accounts
  holding a GLM Coding Plan.
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

## 2. Normalization

Raw shapes differ per Provider. Normalize before persisting.

| Provider | Raw | Transform |
| --- | --- | --- |
| `claude_code` | `utilization` `0.0`–`1.0` | use directly |
| `openai_codex` | `used_percent` `0`–`100` | divide by 100 |
| `zai` | `percentage` `0`–`100`; `nextResetTime` epoch ms | divide by 100; ms to ISO 8601 |
| `minimax` | `*_remaining_percent` (remaining) | `1 - x / 100` |
| `deepseek` | `total_balance` string | use directly |
| `moonshot` | `available_balance` number | render to decimal string |
| `openai` | `total_available` number | render to decimal string |
| `openrouter` | `limit_remaining` number or null | render to decimal string; null emits no entry |

Monetary values are stored as decimal strings, never JSON numbers. DeepSeek already returns strings,
and `jsonb` numbers are IEEE 754, which loses precision on currency.

## 3. Schema changes

### 3.1 New table

The project is pre-release and `packages/db/migrations/0001_core_baseline.sql` is authoritative;
databases from older chains are recreated rather than upgraded. Add the table to the baseline in the
same pg_dump-style section order the file already uses: `CREATE TABLE`, then the primary key under
the constraint section, then indexes under the index section.

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

### 3.2 Credential table changes

Probing consumes upstream request quota, so it must be switchable per connection. This is
configuration and therefore belongs on the credential tables, not on the observation table.

```sql
ALTER TABLE public.provider_api_keys
    ADD COLUMN quota_probe_enabled boolean DEFAULT true NOT NULL;

ALTER TABLE public.provider_oauth
    ADD COLUMN quota_probe_enabled boolean DEFAULT true NOT NULL;
```

### 3.3 Job type

A new persistent Worker job is required.

```sql
-- packages/db/migrations/0001_core_baseline.sql, jobs_job_type_check
CONSTRAINT jobs_job_type_check CHECK ((job_type = ANY (ARRAY[
    'model_refresh'::text,
    'provider_connection_probe'::text,
    'price_sync'::text,
    'provider_quota_probe'::text            -- added
])))
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
`provider_api_keys` and `provider_oauth` would put high-frequency writes on configuration tables and
blur the ownership line drawn in `docs/ARCHITECTURE.md`, where Console owns user-authored
configuration. They are also not scalar: Claude reports three windows, Codex two, and DeepSeek one
entry per currency. Finally, the two credential tables would each need a duplicate set of columns.

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

Two entry shapes. `packages/provider/src/descriptor.ts` declares which shape a `providerKey`
produces, so entries carry no discriminator field.

```ts
type WindowEntry = {
  window: string;        // normalized window id, e.g. "5h" | "7d" | "7d_sonnet"
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

```jsonc
// window utilization
[{"window":"5h","utilization":0.0741,"resetsAt":"2026-07-20T12:00:00Z"},
 {"window":"7d","utilization":0.5312,"resetsAt":"2026-07-24T03:00:00Z"}]

// currency balance
[{"currency":"CNY","total":"110.00","granted":"10.00","toppedUp":"100.00"}]

// unavailable
[]
```

## 5. Descriptor extension

`packages/provider/src/descriptor.ts` gains one optional field. These are compile-time constants,
not user input, so no expression evaluation or sandboxing is involved.

```ts
export type ProviderQuotaSource =
  | { kind: "window_utilization"; via: "response_header" }
  | { kind: "window_utilization"; via: "active_probe"; path: string }
  | { kind: "currency_balance"; via: "active_probe"; path: string }
  | { kind: "unavailable"; reason: "requires_separate_credential" | "not_supported" };

export type ProviderDescriptor = {
  // ...existing fields
  quotaSource?: ProviderQuotaSource;
};
```

Providers with no `quotaSource` — including any custom `providerKey` created through
`action=create` — are treated as `not_supported`.

## 6. Change list

| File | Change |
| --- | --- |
| `packages/db/migrations/0001_core_baseline.sql` | Add `provider_quota_summary` table, primary key, unique index; add `quota_probe_enabled` to `provider_api_keys` and `provider_oauth`; extend `jobs_job_type_check` |
| `packages/db/src/provider-quota.ts` | New. Read and upsert `provider_quota_summary`, mirroring `provider-health.ts` |
| `packages/db/src/console-provider-quota.ts` | New. Console read model, mirroring `console-provider-health.ts` |
| `packages/db/src/provider-jobs.ts` | Enqueue and claim `provider_quota_probe` |
| `packages/provider/src/descriptor.ts` | Add `ProviderQuotaSource` type and `quotaSource` field; populate for the 12 remote `providerKey`s |
| `packages/provider/src/quota-probe.ts` | New. Per-Provider probe execution and normalization to `QuotaEntry[]` |
| `packages/worker-runtime/src/worker-provider-quota-probe.ts` | New. Job handler; skips connections with `quota_probe_enabled = false`; sets `next_refresh_at` |
| `packages/worker-runtime/src/worker-job-runner.ts` | Register the new job type |
| `packages/gateway-runtime/src/gateway-usage-collector.ts` | Extract `anthropic-ratelimit-unified-*` from `claude_code` responses |
| `packages/gateway-runtime/src/gateway-background-tasks.ts` | Persist header-derived quota off the response path |
| `apps/console/src/app/_modules/providers-section.tsx` | Render quota per connection; show `observed_at` staleness; show `error_code` reason |
| `docs/PRODUCT.md` | Add `provider_quota_probe` to the persistent Worker job list |
| `feature_list.json` | New feature entry with unit and E2E verification |

Header extraction must strip `authorization`, `x-api-key`, and `cookie` before anything is recorded,
and must not widen the existing rule that response bodies, prompts, and tool content are never
logged. Only the whitelisted `anthropic-ratelimit-unified-*` keys are read.

## 7. Out of scope

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

## 8. Prior art

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
determined by `providerKey` so nothing needs storing, while Gateway, Worker, and Console are separate
processes that must share observed state, so persistence is required. The two decisions invert.

cc-switch also permits user-authored JavaScript for unsupported vendors. That is safe in a
single-user desktop application and is not safe in a self-hosted server, so it is not adopted.
