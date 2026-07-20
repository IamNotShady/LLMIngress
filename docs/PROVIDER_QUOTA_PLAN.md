# Provider Quota — Implementation Plan

Executes `docs/PROVIDER_QUOTA.md`. Read that document first; it is the spec and this file is the
step order. Two features, executed in order. Feature 2 depends on Feature 1.

Work in a worktree branched from `origin/dev`. Follow `AGENTS.md`: write the failing tests for a step
before its implementation, run `pnpm run verify` before marking a feature done, and
`pnpm run verify:features` before committing.

Types shared by `packages/db` and `packages/provider` go in `packages/domain` — neither may import
the other. Verify both already declare `@llmingress/domain` in their `package.json` dependencies and
add it if missing.

Biome enforces alphabetically sorted object keys and type members repo-wide. Every literal below is
already sorted; keep it that way when editing.

---

# Feature 1 — `provider-quota-probe`

Worker probes each supported connection on a schedule and writes `provider_quota_summary`. No
Console rendering. Verifiable entirely through DB assertions.

## Step 1.1 — Shared entry types

**New file `packages/domain/src/quota.ts`:**

```ts
export type WindowEntry = {
  resetsAt?: string;
  utilization: number;
  window: string;
};

export type BalanceEntry = {
  currency: string;
  granted?: string;
  toppedUp?: string;
  total: string;
};

export type QuotaEntry = BalanceEntry | WindowEntry;

export type ProviderQuotaErrorCode =
  | "not_supported"
  | "probe_failed"
  | "requires_separate_credential"
  | "unauthorized";

export function isWindowEntry(entry: QuotaEntry): entry is WindowEntry {
  return "window" in entry;
}

export function isBalanceEntry(entry: QuotaEntry): entry is BalanceEntry {
  return "currency" in entry;
}
```

Add the subpath to `packages/domain/package.json` `exports`:

```json
"./quota": { "types": "./src/quota.ts", "default": "./src/quota.ts" },
```

## Step 1.2 — Migration

Edit `packages/db/migrations/0001_core_baseline.sql`. The file is pg_dump-style with three
alphabetically ordered sections. Four edits:

**(a)** Add `quota_probe_enabled boolean DEFAULT true NOT NULL,` inline to `CREATE TABLE
public.provider_api_keys` (after `priority`) and to `CREATE TABLE public.provider_oauth` (after
`priority`). Do not use `ALTER TABLE` — the baseline is authoritative and databases are recreated.

**(b)** Extend the jobs constraint:

```sql
CONSTRAINT jobs_job_type_check CHECK ((job_type = ANY (ARRAY['model_refresh'::text, 'provider_connection_probe'::text, 'price_sync'::text, 'provider_quota_probe'::text]))),
```

**(c)** Insert the table immediately before the `-- Name: providers; Type: TABLE` comment block
(alphabetically `provider_models` < `provider_quota_summary` < `providers`):

```sql
--
-- Name: provider_quota_summary; Type: TABLE; Schema: public; Owner: -
--

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
```

**(d)** Add the primary key before `providers_pkey`, and the unique index at the end of the index
section (after `uq_provider_models_provider_id_id`, before the `dump complete` comment):

```sql
ALTER TABLE ONLY public.provider_quota_summary
    ADD CONSTRAINT provider_quota_summary_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX uq_provider_quota_summary_connection ON public.provider_quota_summary USING btree (provider_id, provider_connection_id);
```

The unique index is not optional — the `on conflict (provider_id, provider_connection_id)` upsert in
Step 1.5 will not run without it.

## Step 1.3 — Registry

Edit `packages/config/src/provider-registry.ts`.

Define the type above `ProviderBehavior`:

```ts
export type ProviderQuotaSource =
  | { supported: true }
  | { reason: "not_supported" | "requires_separate_credential"; supported: false };
```

Add the field to `ProviderBehavior`, alphabetically between `priceSyncSupported` and
`reasoningAwareProbe`:

```ts
  quotaSource?: ProviderQuotaSource;
```

Populate `behavior.quotaSource` on the twelve remote entries. Local entries (`ollama`, `lmstudio`,
`llama_cpp`) get nothing.

| Entry | Value |
| --- | --- |
| `claude_code`, `openai_codex`, `deepseek`, `moonshot`, `openai`, `openrouter`, `zai`, `minimax` | `{ supported: true }` |
| `anthropic`, `xai` | `{ reason: "requires_separate_credential", supported: false }` |
| `google`, `qwen` | `{ reason: "not_supported", supported: false }` |

Add `ProviderQuotaSource` to the `export type { ... }` block in `packages/provider/src/descriptor.ts`
— that file is a re-export shim since the registry refactor and holds no definitions of its own.

## Step 1.4 — `quota-probe.ts`

**New file `packages/provider/src/quota-probe.ts`.** Credential-agnostic: it receives an already
resolved API key or access token and never touches the database. Dispatch is a lookup keyed by
`providerKey`; this module is the implementing module, so do **not** add it to the
providerKey-string-dispatch ban list in `tests/features/provider-descriptor.unit.case.ts`.

```ts
import type { QuotaEntry } from "@llmingress/domain/quota";
import { isRecord, joinUrl } from "@llmingress/util";
import { fetchCredentialedProviderRequestWithTimeout } from "./authenticated-http.js";

export type QuotaProbeErrorCode = "probe_failed" | "unauthorized";

export type QuotaProbeInput = {
  baseUrl: string;
  credential: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export type QuotaProbeResult =
  | { entries: QuotaEntry[]; ok: true }
  | { errorCode: QuotaProbeErrorCode; errorMessage: string; ok: false };

export type QuotaProbe = (input: QuotaProbeInput) => Promise<QuotaProbeResult>;

const defaultTimeoutMs = 10_000;

export const quotaProbes: Record<string, QuotaProbe> = {
  claude_code: async (input) =>
    parsed(input, parseClaudeCodeQuota, {
      headers: {
        accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        authorization: `Bearer ${input.credential}`,
      },
      url: joinUrl(input.baseUrl, "api/oauth/usage"),
    }),
  deepseek: async (input) =>
    parsed(input, parseDeepseekQuota, {
      headers: bearer(input.credential),
      url: joinUrl(input.baseUrl, "user/balance"),
    }),
  minimax: async (input) =>
    parsed(input, parseMinimaxQuota, {
      headers: bearer(input.credential),
      url: joinUrl(input.baseUrl, "token_plan/remains"),
    }),
  moonshot: async (input) =>
    parsed(input, parseMoonshotQuota, {
      headers: bearer(input.credential),
      url: joinUrl(input.baseUrl, "users/me/balance"),
    }),
  openai: async (input) =>
    parsed(input, parseOpenAIQuota, {
      headers: bearer(input.credential),
      url: joinUrl(input.baseUrl, "dashboard/billing/credit_grants"),
    }),
  openai_codex: async (input) =>
    parsed(input, parseCodexQuota, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.credential}`,
        "user-agent": "codex-cli",
      },
      url: joinUrl(input.baseUrl, "wham/usage"),
    }),
  openrouter: async (input) =>
    parsed(input, parseOpenRouterQuota, {
      headers: bearer(input.credential),
      url: joinUrl(input.baseUrl, "key"),
    }),
  zai: async (input) => {
    // The quota path shares only the origin with the configured base URL
    // (base is /api/paas/v4, quota is /api/monitor/...), so joinUrl is wrong here.
    const url = new URL(
      "/api/monitor/usage/quota/limit",
      new URL(input.baseUrl).origin,
    ).toString();
    const bearerResult = await parsed(input, parseZaiQuota, {
      headers: { ...bearer(input.credential), "accept-language": "en-US,en" },
      url,
    });
    if (bearerResult.ok) {
      return bearerResult;
    }
    // Implementations disagree on whether Zhipu wants a scheme; retry raw.
    return parsed(input, parseZaiQuota, {
      headers: {
        accept: "application/json",
        "accept-language": "en-US,en",
        authorization: input.credential,
      },
      url,
    });
  },
};

export function resolveQuotaProbe(providerKey: string | null | undefined): QuotaProbe | null {
  if (!providerKey) {
    return null;
  }
  return quotaProbes[providerKey] ?? null;
}

async function parsed(
  input: QuotaProbeInput,
  parse: (body: unknown) => QuotaEntry[],
  request: { headers: Record<string, string>; url: string },
): Promise<QuotaProbeResult> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  try {
    const response = await fetchCredentialedProviderRequestWithTimeout(
      fetchImpl,
      request.url,
      { headers: request.headers, method: "GET" },
      { timeoutMs: input.timeoutMs ?? defaultTimeoutMs },
    );
    const text = await response.text();
    const body = readJson(text);
    if (!response.ok) {
      return {
        errorCode:
          response.status === 401 || response.status === 403 ? "unauthorized" : "probe_failed",
        errorMessage: `Quota probe failed with status ${response.status}.`,
        ok: false,
      };
    }
    return { entries: parse(body), ok: true };
  } catch (error) {
    return {
      errorCode: "probe_failed",
      errorMessage: error instanceof Error ? error.message : "Quota probe failed.",
      ok: false,
    };
  }
}

function bearer(credential: string): Record<string, string> {
  return { accept: "application/json", authorization: `Bearer ${credential}` };
}

function readJson(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function decimal(value: number): string {
  return String(value);
}

// ── parsers ────────────────────────────────────────────────────────────────

/**
 * Structural, not allowlist-based: Anthropic adds windows over time
 * (seven_day_opus is absent from the response headers but present here).
 */
export function parseClaudeCodeQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body)) {
    return [];
  }
  const entries: QuotaEntry[] = [];
  for (const [key, value] of Object.entries(body)) {
    if (key === "extra_usage" || !isRecord(value)) {
      continue;
    }
    const utilization = readNumber(value.utilization);
    if (utilization === null) {
      continue;
    }
    entries.push({
      ...(typeof value.resets_at === "string" ? { resetsAt: value.resets_at } : {}),
      utilization,
      window: key,
    });
  }
  const extra = body.extra_usage;
  if (isRecord(extra) && extra.is_enabled === true) {
    const limit = readNumber(extra.monthly_limit);
    const used = readNumber(extra.used_credits);
    if (limit !== null && used !== null) {
      entries.push({
        currency: typeof extra.currency === "string" ? extra.currency : "USD",
        total: decimal(limit - used),
      });
    }
  }
  return entries;
}

export function parseCodexQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body) || !isRecord(body.rate_limit)) {
    return [];
  }
  const entries: QuotaEntry[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const window = body.rate_limit[key];
    if (!isRecord(window)) {
      continue;
    }
    const usedPercent = readNumber(window.used_percent);
    if (usedPercent === null) {
      continue;
    }
    const resetAt = readNumber(window.reset_at);
    entries.push({
      ...(resetAt === null ? {} : { resetsAt: new Date(resetAt * 1_000).toISOString() }),
      utilization: usedPercent / 100,
      window: codexWindowName(readNumber(window.limit_window_seconds)),
    });
  }
  return entries;
}

function codexWindowName(limitWindowSeconds: number | null): string {
  if (limitWindowSeconds === null) {
    return "unknown";
  }
  if (limitWindowSeconds % 86_400 === 0) {
    return `${limitWindowSeconds / 86_400}d`;
  }
  if (limitWindowSeconds % 3_600 === 0) {
    return `${limitWindowSeconds / 3_600}h`;
  }
  return `${limitWindowSeconds}s`;
}

export function parseDeepseekQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body) || !Array.isArray(body.balance_infos)) {
    return [];
  }
  const entries: QuotaEntry[] = [];
  for (const info of body.balance_infos) {
    if (!isRecord(info) || typeof info.currency !== "string") {
      continue;
    }
    const total = readNumber(info.total_balance);
    if (total === null) {
      continue;
    }
    const granted = readNumber(info.granted_balance);
    const toppedUp = readNumber(info.topped_up_balance);
    entries.push({
      currency: info.currency,
      ...(granted === null ? {} : { granted: decimal(granted) }),
      ...(toppedUp === null ? {} : { toppedUp: decimal(toppedUp) }),
      total: decimal(total),
    });
  }
  return entries;
}

export function parseMoonshotQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body) || !isRecord(body.data)) {
    return [];
  }
  const available = readNumber(body.data.available_balance);
  if (available === null) {
    return [];
  }
  const voucher = readNumber(body.data.voucher_balance);
  const cash = readNumber(body.data.cash_balance);
  return [
    {
      currency: "USD",
      ...(voucher === null ? {} : { granted: decimal(voucher) }),
      ...(cash === null ? {} : { toppedUp: decimal(cash) }),
      total: decimal(available),
    },
  ];
}

export function parseOpenAIQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body)) {
    return [];
  }
  const available = readNumber(body.total_available);
  if (available === null) {
    return [];
  }
  const granted = readNumber(body.total_granted);
  return [
    {
      currency: "USD",
      ...(granted === null ? {} : { granted: decimal(granted) }),
      total: decimal(available),
    },
  ];
}

/** limit_remaining is nullable: null means no limit is configured, which is not zero. */
export function parseOpenRouterQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body) || !isRecord(body.data)) {
    return [];
  }
  const remaining = readNumber(body.data.limit_remaining);
  if (remaining === null) {
    return [];
  }
  const limit = readNumber(body.data.limit);
  return [
    {
      currency: "USD",
      ...(limit === null ? {} : { granted: decimal(limit) }),
      total: decimal(remaining),
    },
  ];
}

/**
 * `unit` is undocumented, so it is used only to name the window, never to infer
 * a duration. `nextResetTime` is epoch milliseconds, unlike every other provider.
 */
export function parseZaiQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.limits)) {
    return [];
  }
  const entries: QuotaEntry[] = [];
  for (const limit of body.data.limits) {
    if (!isRecord(limit)) {
      continue;
    }
    const percentage = readNumber(limit.percentage);
    if (percentage === null) {
      continue;
    }
    const resetMs = readNumber(limit.nextResetTime);
    entries.push({
      ...(resetMs === null ? {} : { resetsAt: new Date(resetMs).toISOString() }),
      utilization: percentage / 100,
      window: `${String(limit.type ?? "limit").toLowerCase()}_${String(limit.unit ?? "0")}`,
    });
  }
  return entries;
}

/** The API reports REMAINING percent; utilization is the inverse. */
export function parseMinimaxQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body)) {
    return [];
  }
  const entries: QuotaEntry[] = [];
  const windows: Array<[string, unknown]> = [
    ["interval", body.current_interval_remaining_percent],
    ["weekly", body.current_weekly_remaining_percent],
  ];
  for (const [window, raw] of windows) {
    const remaining = readNumber(raw);
    if (remaining === null) {
      continue;
    }
    entries.push({ utilization: 1 - remaining / 100, window });
  }
  return entries;
}
```

Add to `packages/provider/package.json` `exports`:

```json
"./quota-probe": { "types": "./src/quota-probe.ts", "default": "./src/quota-probe.ts" },
```

## Step 1.5 — `provider-quota.ts`

**New file `packages/db/src/provider-quota.ts`.** Mirrors `provider-health.ts`: a `databaseUrl`
wrapper plus a `...WithClient` variant, advisory lock before writing, `randomUUID()` in JS, jsonb via
`JSON.stringify` + `::jsonb`.

Unlike `provider-health.ts`, **do not delete the row on success** — §3.7 of the spec requires a row
to always exist so that "cannot be retrieved" is distinguishable from "not yet queried".

```ts
import { randomUUID } from "node:crypto";
import { type PostgresQueryClient, withPostgresTransaction } from "@llmingress/db/client";
import type { ProviderQuotaErrorCode, QuotaEntry } from "@llmingress/domain/quota";

export type RecordProviderQuotaInput = {
  databaseUrl?: string;
  entries: QuotaEntry[];
  errorCode?: ProviderQuotaErrorCode | null;
  nextRefreshAt?: Date | null;
  observedAt?: Date;
  providerConnectionId: string;
  providerId: string;
};

export async function recordProviderQuota(input: RecordProviderQuotaInput): Promise<void> {
  return withPostgresTransaction(input.databaseUrl, (client) =>
    recordProviderQuotaWithClient(client, input),
  );
}

export async function recordProviderQuotaWithClient(
  client: PostgresQueryClient,
  input: Omit<RecordProviderQuotaInput, "databaseUrl">,
): Promise<void> {
  await client.query("select pg_advisory_xact_lock(hashtext($1))", [
    `provider_quota:${input.providerId}:${input.providerConnectionId}`,
  ]);
  const observedAt = input.observedAt ?? new Date();
  const previous = await client.query<{ id: string }>(
    `
      select id::text
      from provider_quota_summary
      where provider_id = $1
        and provider_connection_id = $2
      for update
    `,
    [input.providerId, input.providerConnectionId],
  );
  await client.query(
    `
      insert into provider_quota_summary (
        id,
        provider_id,
        provider_connection_id,
        entries,
        observed_at,
        next_refresh_at,
        error_code,
        updated_at
      )
      values ($1, $2, $3, $4::jsonb, $5, $6, $7, $5)
      on conflict (provider_id, provider_connection_id)
      do update set
        entries = excluded.entries,
        observed_at = excluded.observed_at,
        next_refresh_at = excluded.next_refresh_at,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at
    `,
    [
      previous.rows[0]?.id ?? randomUUID(),
      input.providerId,
      input.providerConnectionId,
      JSON.stringify(input.entries),
      observedAt,
      input.nextRefreshAt ?? null,
      input.errorCode ?? null,
    ],
  );
}

export async function clearProviderQuotaWithClient(
  client: PostgresQueryClient,
  input: { providerConnectionId: string; providerId: string },
): Promise<void> {
  await client.query(
    `
      delete from provider_quota_summary
      where provider_id = $1
        and provider_connection_id = $2
    `,
    [input.providerId, input.providerConnectionId],
  );
}

export function providerQuotaRefreshDelayMs(errorCode: ProviderQuotaErrorCode | null): number {
  if (errorCode === "not_supported" || errorCode === "requires_separate_credential") {
    return 24 * 60 * 60_000;
  }
  if (errorCode === "unauthorized") {
    return 60 * 60_000;
  }
  if (errorCode === "probe_failed") {
    return 15 * 60_000;
  }
  return 15 * 60_000;
}
```

`providerQuotaRefreshDelayMs` is exported and pure so it can be unit-tested without a database.
Providers that will never report are backed off a full day rather than retried every cycle.

Call `clearProviderQuotaWithClient` from the same places that already call
`clearProviderConnectionHealthWithClient` when a credential is deleted, so summary rows do not
outlive their connection.

Add to `packages/db/package.json` `exports`:

```json
"./provider-quota": { "types": "./src/provider-quota.ts", "default": "./src/provider-quota.ts" },
```

`packages/db/src/index.ts` needs no change — sibling modules are reached only through subpaths.

## Step 1.6 — Enqueue

Edit `packages/db/src/provider-jobs.ts`. Add `quota_probe_enabled = true` to the readiness predicate
used when enumerating connections, and add an enqueue function modelled on
`enqueueProviderConnectionProbeJob`: `requireId` both ids, open a transaction, `pg_advisory_xact_lock`
on `provider_quota_probe:${providerId}:${providerConnectionId}`, dedupe against a pending job with
`for update`, insert with `job_type = 'provider_quota_probe'` and `max_attempts = 3`, then
`notifyJobCreated`. Payload is `{ providerConnectionId, providerId, source }` with
`source: "scheduled_probe" | "manual_probe"`.

## Step 1.7 — Job handler

**New file `packages/worker-runtime/src/worker-provider-quota-probe.ts`.** Copy the structure of
`worker-provider-connection-probe.ts`, including its two sentinel error classes and the OAuth
compare-and-swap refresh block, then diverge as follows:

- Factory `createProviderQuotaProbeJobHandler(options): JobHandler` with the same injectable
  `databaseUrl`, `fetch`, `encryptionKeySource`, `timeoutMs` options. Pass
  `"provider quota probes"` as the `readWorkerEncryptionKeySource` purpose string.
- Resolve `resolveProviderDescriptor(provider.providerKey).quotaSource`. If it is
  `{ supported: false }`, write a row with `entries: []`, its `reason` as `error_code`, and
  `nextRefreshAt` from `providerQuotaRefreshDelayMs`, then return. Do not call upstream.
- If `quota_probe_enabled` is false on the credential row, return
  `{ canceled: true, reason: "quota_probe_disabled" }`. This duplicates the enqueue-side filter on
  purpose: the predicate avoids wasted jobs, the handler check makes the toggle effective
  immediately for jobs already in flight.
- Resolve the credential exactly as the connection probe does — including the OAuth expiry check,
  `refreshProviderOAuthToken`, and the CAS write-back guarded on the old ciphertext, whose lost race
  is `{ canceled: true, reason: "provider_connection_changed_during_oauth_refresh" }`.
- Call `resolveQuotaProbe(providerKey)` and invoke it with `{ baseUrl, credential, fetch, timeoutMs }`.
- Write the result with `recordProviderQuota`, setting `nextRefreshAt` from
  `providerQuotaRefreshDelayMs(errorCode)`. The handler does **not** enqueue its own successor; the
  maintenance task in Step 1.8 owns scheduling so a broken chain self-heals.
- Do not carry over the health module's "success deletes the summary row" branch.

## Step 1.8 — Scheduling

Edit `packages/worker-runtime/src/worker-maintenance-scheduler.ts`. Add to
`createCoreMaintenanceTasks`:

```ts
{
  id: "provider-quota-probe-enqueue",
  intervalMs: 5 * 60_000,
  run: async (signal) => { /* enqueue due connections */ },
}
```

`run` selects enabled, non-deleted connections joined to `provider_quota_summary` where
`next_refresh_at is null or next_refresh_at <= now()` — a left join, so connections with no row yet
are included and get their first probe. For each, call the Step 1.6 enqueue function. Respect
`signal`. The scheduler already wraps each task in `pg_try_advisory_lock`, so multiple Worker
instances will not double-enqueue.

## Step 1.9 — Registration

Edit `apps/worker/src/main.ts`:

```ts
import { createProviderQuotaProbeJobHandler } from "@llmingress/worker-runtime/worker-provider-quota-probe";
// ...
  handlers: {
    model_refresh: createModelRefreshJobHandler({}),
    price_sync: createPriceSyncJobHandler({}),
    provider_connection_probe: createProviderConnectionProbeJobHandler({}),
    provider_quota_probe: createProviderQuotaProbeJobHandler({}),
  },
```

The job runner derives claimable types from these keys, so there is nothing else to register.

Then add `createProviderQuotaProbeJobHandler` to the assertion list in
`tests/features/worker-core-jobs.unit.case.ts`, which greps `main.ts` for each handler name.

## Step 1.10 — Artifacts

Add `provider_quota_probe` to the persistent Worker job list in `docs/PRODUCT.md`, which currently
states the jobs are *exactly* three. Add the `feature_list.json` entry from the test plan below.

## Feature 1 tests

Written before the corresponding step, per `AGENTS.md`.

**`tests/features/provider-quota.unit.case.ts`** — pure, no database. Import source by relative path
(`../../packages/provider/src/quota-probe`).

| Test | Asserts |
| --- | --- |
| claude_code parser | Four windows parsed from top-level keys with `utilization` and `resetsAt`; an unknown future window name is still parsed; `extra_usage` with `is_enabled: true` yields one balance entry of `monthly_limit - used_credits`; `is_enabled: false` yields none |
| codex parser | `used_percent: 42` → `utilization: 0.42`; `limit_window_seconds: 18000` → `window: "5h"`, `604800` → `"7d"`; `reset_at` epoch seconds → ISO |
| zai parser | `percentage: 16` → `0.16`; `nextResetTime` epoch **milliseconds** → correct ISO (a seconds-based reading would land in 1970 — assert the year) |
| minimax parser | `current_interval_remaining_percent: 61` → `utilization: 0.39` (inversion) |
| deepseek parser | String amounts preserved exactly; `granted`/`toppedUp` mapped; multiple currencies yield multiple entries |
| openrouter parser | `limit_remaining: null` yields **zero** entries, not a zero balance |
| moonshot / openai parsers | Numeric amounts rendered as strings |
| probe transport | Injected `fetch` records the request; assert `redirect: "manual"` reaches fetch, the URL, and the auth header per provider; `anthropic-beta: oauth-2025-04-20` present for claude_code; `user-agent: codex-cli` for codex |
| zai URL | Base `https://api.z.ai/api/paas/v4` produces `https://api.z.ai/api/monitor/usage/quota/limit` — not a path join |
| zai auth fallback | A 401 on the `Bearer` attempt triggers a second request with the raw token; assert both requests and that the second result is returned |
| 401/403 | Classified `unauthorized`; 500 and a network throw classified `probe_failed` |
| timeout | A never-resolving fetch that rejects on `signal` abort yields `probe_failed` |
| backoff | `providerQuotaRefreshDelayMs("not_supported")` is 24h; `"probe_failed"` is 15m |
| registry | All twelve remote entries declare `quotaSource`; the eight supported ones have a probe in `quotaProbes`; local entries declare none |
| migration text | `readFileSync` the baseline and assert it contains `provider_quota_summary`, `uq_provider_quota_summary_connection`, `provider_quota_probe`, and `quota_probe_enabled` |

**`tests/e2e/provider-quota.e2e.case.ts`** — real Postgres via `createTestPostgresFixture` +
`runMigrations`, injected `fetch`. Mirror `provider-connection-health.e2e.case.ts`, including the
module-scope `encryptionKeySource` constant and the `probeJob`-style `RunningJob` builder.

| Test | Asserts |
| --- | --- |
| happy path, api_key | Seed a `deepseek` provider + encrypted key, stub fetch with a balance body, run the handler; `provider_quota_summary` has one row with the expected `entries`, `error_code is null`, `next_refresh_at` in the future |
| happy path, oauth | Seed `claude_code` + encrypted OAuth token, stub `/api/oauth/usage`; row holds window entries plus the overage balance entry |
| unsupported provider | Seed `google`; handler writes `entries = []` and `error_code = 'not_supported'` **without** calling fetch — use a throwing fetch stub to prove no upstream call |
| unauthorized | Stub 403; row records `error_code = 'unauthorized'` and `next_refresh_at` about an hour out |
| probe disabled | Set `quota_probe_enabled = false`; handler returns `{ canceled: true, reason: "quota_probe_disabled" }` and writes no row |
| expired OAuth | Seed an expired token; stub the token endpoint; assert the refreshed ciphertext was written back and the probe used the new token |
| OAuth CAS race | Mutate `provider_oauth` from inside the token-endpoint stub; assert `{ canceled: true, reason: "provider_connection_changed_during_oauth_refresh" }` |
| upsert | Run the handler twice; exactly one row exists and `observed_at` advanced |
| scheduling | A connection with no summary row is picked up by the maintenance task and a `provider_quota_probe` job is enqueued; running it twice does not create a duplicate pending job |

Manifests — `tests/features/provider-quota.unit.test.ts` and `tests/e2e/provider-quota.e2e.spec.ts`,
each a single side-effect import of its `.case` file. Case files are never named directly in a
verification command.

**`feature_list.json` entry:**

```json
{
  "id": "provider-quota-probe",
  "name": "Provider Quota Probe",
  "description": "Worker probes each supported Provider connection on a schedule and stores upstream balance or usage-window utilization in provider_quota_summary, one row per (provider, connection), with entries normalized to a shared shape; unsupported Providers store an explicit error_code instead of an empty result, and probing is switchable per connection.",
  "verification": "pnpm exec vitest run tests/features/provider-quota.unit.test.ts && pnpm test:e2e tests/e2e/provider-quota.e2e.spec.ts --workers=1",
  "dependencies": ["provider-model-management", "worker-model-operations"],
  "status": "failing",
  "evidence": ""
}
```

Set `status` to `passing` and fill `evidence` only after the command above and
`pnpm run verify:features` both pass.

---

# Feature 2 — `provider-quota-console`

Depends on Feature 1. Renders what the probe stored.

## Step 2.1 — Read model

**New file `packages/db/src/console-provider-quota.ts`.** Copy `console-provider-health.ts`:
`withPooledPostgresClient` (reads take no transaction), a `with provider_connections as (...)` CTE
that `union all`s the three connection kinds, a left join to `provider_quota_summary`, camelCase
output, `Date | null` rather than strings, ordering in SQL.

```ts
export type ConsoleProviderQuotaSummary = {
  connectionKind: "api_key" | "local" | "oauth";
  connectionLabel: string;
  entries: QuotaEntry[];
  errorCode: ProviderQuotaErrorCode | null;
  id: string;
  observedAt: Date | null;
  providerDisplayName: string;
  providerId: string;
  providerKey: string;
};

export async function listConsoleProviderQuotaSummaries(
  input: { databaseUrl?: string } = {},
): Promise<ConsoleProviderQuotaSummary[]>;
```

A connection with no row yields `entries: []`, `errorCode: null`, `observedAt: null` — which Console
renders as "not yet queried", distinct from an `errorCode` meaning "cannot be retrieved".

Add the `./console-provider-quota` subpath to `packages/db/package.json`.

## Step 2.2 — Rendering

Edit `apps/console/src/app/_modules/providers-section.tsx`. Per connection:

- Window entries: percentage plus relative reset time.
- Balance entries: amount with currency.
- `errorCode` present: the reason, not a zero value. `requires_separate_credential` and
  `not_supported` are expected states and must not read as errors.
- `observedAt` present: relative staleness, e.g. "updated 3 min ago".
- `observedAt` null with no `errorCode`: "not yet queried".

Where several connections of one Provider show an identical balance, do not present them as
independent pools — balance is usually account-scoped. A single Provider-level line with a
per-connection breakdown avoids implying N times the funds.

## Feature 2 tests

**`tests/features/provider-quota-console.unit.case.ts`** — entry-shape discrimination
(`"window" in entry` vs `"currency" in entry`) and formatting helpers, pure.

**`tests/e2e/provider-quota-console.e2e.case.ts`** — Playwright against the booted Console via
`tests/support/console-app.ts`. Seed four connections: one with window entries, one with a balance,
one with `error_code = 'not_supported'`, one with no row. Assert each renders its distinct state,
that the unsupported one does not render as a failure, and that the page does not overflow at 1280
or 390.

**`feature_list.json` entry:**

```json
{
  "id": "provider-quota-console",
  "name": "Provider Quota Console",
  "description": "The Providers page shows each connection's stored upstream quota: window utilization as a percentage with its reset time, balance with its currency, an explicit reason when the Provider cannot report, and 'not yet queried' when no probe has run; the page never overflows at 1280 or 390.",
  "verification": "pnpm exec vitest run tests/features/provider-quota-console.unit.test.ts && pnpm test:e2e tests/e2e/provider-quota-console.e2e.spec.ts --workers=1",
  "dependencies": ["provider-quota-probe", "console-core"],
  "status": "failing",
  "evidence": ""
}
```

---

# Risks

- **Three endpoints are undocumented** (`claude_code` `/api/oauth/usage`, `zai`'s quota path,
  `openai`'s `credit_grants`) and can break without notice. Every probe failure must land as
  `probe_failed` and must never affect routing or connection health. Do not couple
  `provider_quota_summary` to `provider_health_summary` in either direction.
- **`zai` and `minimax` shapes are community-sourced**, not from official documentation. Their
  parsers must tolerate missing fields and return `[]` rather than throwing.
- **A coding-plan key and a platform key are not interchangeable** for `moonshot` and `minimax`; the
  wrong class returns empty or zero rather than an error. An all-zero result should not be presented
  as authoritative.
- **`docs/PRODUCT.md` currently states the persistent Worker jobs are exactly three.** Step 1.10
  changes a V1 scope statement; do not skip it or `verify:features` will pass while the product doc
  contradicts the code.
