import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerRegistry } from "../../packages/config/src/provider-registry";
import { providerQuotaRefreshDelayMs } from "../../packages/db/src/provider-quota";
import {
  moonshotQuotaCurrency,
  parseClaudeCodeQuota,
  parseCodexQuota,
  parseDeepseekQuota,
  parseKimiQuota,
  parseMinimaxQuota,
  parseMoonshotQuota,
  parseOpenAIQuota,
  parseOpenRouterQuota,
  parseZaiQuota,
  quotaProbes,
  resolveQuotaProbe,
} from "../../packages/provider/src/quota-probe";

type RecordedRequest = { headers: Headers; init: RequestInit; url: string };

// Every outbound call in this file goes through an injected fetch closure that
// returns a real Response, so no HTTP interception layer is involved.
function recordingFetch(
  recorded: RecordedRequest[],
  respond: (attempt: number) => Response,
): typeof globalThis.fetch {
  return async (url, init) => {
    recorded.push({ headers: new Headers(init?.headers), init: init ?? {}, url: String(url) });
    return respond(recorded.length - 1);
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

// Base URLs are the registry values, so the asserted URLs are the ones a real
// connection would produce.
const baseUrls = {
  claude_code: "https://api.anthropic.com",
  deepseek: "https://api.deepseek.com",
  glm_coding: "https://api.z.ai/api/coding/paas/v4",
  kimi_coding: "https://api.kimi.com/coding/v1",
  minimax: "https://api.minimax.io/v1",
  moonshot: "https://api.moonshot.ai/v1",
  openai: "https://api.openai.com/v1",
  openai_codex: "https://chatgpt.com/backend-api",
  openrouter: "https://openrouter.ai/api/v1",
  zai: "https://api.z.ai/api/paas/v4",
} as const;

function probeFor(providerKey: keyof typeof baseUrls) {
  const probe = resolveQuotaProbe(providerKey);
  if (!probe) {
    throw new Error(`No quota probe registered for ${providerKey}.`);
  }
  return probe;
}

describe("provider quota parsers", () => {
  it("parses claude_code windows structurally and the overage balance", () => {
    // The oauth/usage endpoint reports utilization on a 0-100 percent scale
    // (a live account showed 24 / 53), unlike the response headers' 0-1
    // fraction. Reading it as a fraction rendered 2400%.
    const entries = parseClaudeCodeQuota({
      extra_usage: {
        currency: "USD",
        is_enabled: true,
        monthly_limit: 100,
        used_credits: 23.5,
        utilization: 23.5,
      },
      five_hour: { resets_at: "2026-07-20T12:00:00Z", utilization: 24 },
      seven_day: { resets_at: "2026-07-24T03:00:00Z", utilization: 53.12 },
      seven_day_opus: { resets_at: "2026-07-24T03:00:00Z", utilization: 10 },
      seven_day_sonnet: { resets_at: "2026-07-24T03:00:00Z", utilization: 20 },
      // A window Anthropic has not shipped yet: a structural parser must absorb
      // it without a code change.
      thirty_day_unreleased: { resets_at: "2026-08-16T00:00:00Z", utilization: 2 },
    });

    expect(entries).toContainEqual({
      resetsAt: "2026-07-20T12:00:00Z",
      utilization: 0.24,
      window: "five_hour",
    });
    expect(entries).toContainEqual({
      resetsAt: "2026-07-24T03:00:00Z",
      utilization: 0.5312,
      window: "seven_day",
    });
    expect(entries.map((entry) => ("window" in entry ? entry.window : null))).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
      "seven_day_sonnet",
      "thirty_day_unreleased",
      null,
    ]);
    expect(entries).toContainEqual({ currency: "USD", total: "76.5" });
  });

  it("omits the claude_code overage balance when extra usage is disabled", () => {
    const entries = parseClaudeCodeQuota({
      extra_usage: {
        currency: "USD",
        is_enabled: false,
        monthly_limit: 100,
        used_credits: 0,
        utilization: 0,
      },
      five_hour: { resets_at: "2026-07-20T12:00:00Z", utilization: 7.41 },
    });

    expect(entries).toEqual([
      { resetsAt: "2026-07-20T12:00:00Z", utilization: 0.0741, window: "five_hour" },
    ]);
  });

  it("normalizes codex percentages, window names, and epoch-second resets", () => {
    const entries = parseCodexQuota({
      rate_limit: {
        primary_window: {
          limit_window_seconds: 18_000,
          reset_at: 1_784_000_000,
          used_percent: 42,
        },
        secondary_window: {
          limit_window_seconds: 604_800,
          reset_at: 1_784_500_000,
          used_percent: 7.5,
        },
      },
    });

    expect(entries).toEqual([
      {
        resetsAt: new Date(1_784_000_000_000).toISOString(),
        utilization: 0.42,
        window: "5h",
      },
      {
        resetsAt: new Date(1_784_500_000_000).toISOString(),
        utilization: 0.075,
        window: "7d",
      },
    ]);
  });

  it("reads zai nextResetTime as epoch milliseconds, not seconds", () => {
    const entries = parseZaiQuota({
      data: {
        limits: [{ nextResetTime: 1_784_000_000_000, percentage: 16, type: "PROMPT", unit: 5 }],
      },
    });

    const entry = entries[0];
    expect(entry && "window" in entry ? entry.utilization : null).toBeCloseTo(0.16, 10);
    const resetsAt = entry && "window" in entry ? entry.resetsAt : undefined;
    expect(resetsAt).toBe(new Date(1_784_000_000_000).toISOString());
    // A seconds-based reading would land in 1970.
    expect(resetsAt?.slice(0, 4)).toBe("2026");
  });

  it("returns no zai entries for a malformed body instead of throwing", () => {
    expect(parseZaiQuota({ data: { limits: "nope" } })).toEqual([]);
    expect(parseZaiQuota(null)).toEqual([]);
  });

  it("parses kimi five_hour from the first detailed limit and weekly_limit from usage", () => {
    const entries = parseKimiQuota({
      limits: [
        { detail: { limit: 100, remaining: 76, resetTime: 1_784_000_000 } },
        // A second detailed limit must be ignored (only the first is taken).
        { detail: { limit: 100, remaining: 5, resetTime: 1_784_000_000 } },
      ],
      usage: { limit: 1000, remaining: 900, resetTime: "2026-07-24T03:00:00Z" },
    });

    // utilization is a 0-1 fraction (limit - remaining) / limit, never *100;
    // window names are the fixed cc-switch literals; resetsAt is an ISO string,
    // tolerantly parsed from epoch seconds and a date string alike.
    expect(entries).toEqual([
      {
        resetsAt: new Date(1_784_000_000_000).toISOString(),
        utilization: 0.24,
        window: "five_hour",
      },
      {
        resetsAt: "2026-07-24T03:00:00.000Z",
        utilization: 0.1,
        window: "weekly_limit",
      },
    ]);
  });

  it("returns no kimi entries for a malformed body instead of throwing", () => {
    expect(parseKimiQuota(null)).toEqual([]);
    expect(parseKimiQuota({ limits: "nope" })).toEqual([]);
  });

  it("inverts minimax remaining percentages into utilization", () => {
    const entries = parseMinimaxQuota({
      current_interval_remaining_percent: 61,
      current_weekly_remaining_percent: 100,
    });

    expect(entries).toHaveLength(2);
    const interval = entries[0];
    expect(interval && "window" in interval ? interval.window : null).toBe("interval");
    expect(interval && "window" in interval ? interval.utilization : null).toBeCloseTo(0.39, 10);
    const weekly = entries[1];
    expect(weekly && "window" in weekly ? weekly.utilization : null).toBeCloseTo(0, 10);
  });

  it("preserves deepseek decimal strings exactly across every currency", () => {
    const entries = parseDeepseekQuota({
      balance_infos: [
        {
          currency: "CNY",
          granted_balance: "10.00",
          topped_up_balance: "100.00",
          total_balance: "110.00",
        },
        {
          currency: "USD",
          granted_balance: "0.00",
          topped_up_balance: "5.50",
          total_balance: "5.50",
        },
      ],
      is_available: true,
    });

    expect(entries).toEqual([
      { currency: "CNY", granted: "10.00", toppedUp: "100.00", total: "110.00" },
      { currency: "USD", granted: "0.00", toppedUp: "5.50", total: "5.50" },
    ]);
  });

  it("emits no openrouter entry when limit_remaining is null", () => {
    expect(parseOpenRouterQuota({ data: { limit: 20, limit_remaining: null } })).toEqual([]);
    expect(parseOpenRouterQuota({ data: { limit: 20, limit_remaining: 4.75 } })).toEqual([
      { currency: "USD", granted: "20", total: "4.75" },
    ]);
  });

  it("renders moonshot and openai numeric amounts as decimal strings", () => {
    expect(
      parseMoonshotQuota({
        data: { available_balance: 12.34, cash_balance: 10.34, voucher_balance: 2 },
      }),
    ).toEqual([{ currency: "USD", granted: "2", toppedUp: "10.34", total: "12.34" }]);

    expect(
      parseOpenAIQuota({ total_available: 76.5, total_granted: 120, total_used: 43.5 }),
    ).toEqual([{ currency: "USD", granted: "120", total: "76.5" }]);
  });

  it("labels the moonshot balance with the deployment's currency", () => {
    // Same path and fields on both hosts; only the currency differs
    // (api.moonshot.ai bills USD, api.moonshot.cn bills CNY).
    expect(moonshotQuotaCurrency("https://api.moonshot.ai/v1")).toBe("USD");
    expect(moonshotQuotaCurrency("https://api.moonshot.cn/v1")).toBe("CNY");
    expect(moonshotQuotaCurrency("not-a-url")).toBe("USD");

    expect(parseMoonshotQuota({ data: { available_balance: 12.34 } }, "CNY")).toEqual([
      { currency: "CNY", total: "12.34" },
    ]);
  });
});

describe("provider quota probe transport", () => {
  it("sends each provider's documented URL and auth header with manual redirects", async () => {
    const cases: Array<{
      body: unknown;
      expectedHeaders: Record<string, string>;
      providerKey: keyof typeof baseUrls;
      url: string;
    }> = [
      {
        body: { five_hour: { utilization: 0.1 } },
        expectedHeaders: {
          "anthropic-beta": "oauth-2025-04-20",
          authorization: "Bearer secret-credential",
        },
        providerKey: "claude_code",
        url: "https://api.anthropic.com/api/oauth/usage",
      },
      {
        body: { rate_limit: {} },
        expectedHeaders: {
          authorization: "Bearer secret-credential",
          "user-agent": "codex-cli",
        },
        providerKey: "openai_codex",
        url: "https://chatgpt.com/backend-api/wham/usage",
      },
      {
        body: { balance_infos: [] },
        expectedHeaders: { authorization: "Bearer secret-credential" },
        providerKey: "deepseek",
        url: "https://api.deepseek.com/user/balance",
      },
      {
        body: { data: {} },
        expectedHeaders: { authorization: "Bearer secret-credential" },
        providerKey: "moonshot",
        url: "https://api.moonshot.ai/v1/users/me/balance",
      },
      {
        body: {},
        expectedHeaders: { authorization: "Bearer secret-credential" },
        providerKey: "openai",
        url: "https://api.openai.com/v1/dashboard/billing/credit_grants",
      },
      {
        body: { data: {} },
        expectedHeaders: { authorization: "Bearer secret-credential" },
        providerKey: "openrouter",
        url: "https://openrouter.ai/api/v1/key",
      },
      {
        body: {},
        expectedHeaders: { authorization: "Bearer secret-credential" },
        providerKey: "minimax",
        url: "https://api.minimax.io/v1/token_plan/remains",
      },
      {
        body: { limits: [], usage: {} },
        expectedHeaders: {
          accept: "application/json",
          authorization: "Bearer secret-credential",
        },
        providerKey: "kimi_coding",
        // Bearer to /coding/v1/usages, a different endpoint and auth than the
        // messages egress (which uses x-api-key).
        url: "https://api.kimi.com/coding/v1/usages",
      },
    ];

    for (const testCase of cases) {
      const recorded: RecordedRequest[] = [];
      const result = await probeFor(testCase.providerKey)({
        baseUrl: baseUrls[testCase.providerKey],
        credential: "secret-credential",
        fetch: recordingFetch(recorded, () => jsonResponse(testCase.body)),
      });

      expect(result.ok).toBe(true);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.url).toBe(testCase.url);
      expect(recorded[0]?.init).toMatchObject({ method: "GET", redirect: "manual" });
      for (const [header, value] of Object.entries(testCase.expectedHeaders)) {
        expect(recorded[0]?.headers.get(header)).toBe(value);
      }
    }
  });

  it("derives the zai quota URL from the origin rather than joining the base path", async () => {
    const recorded: RecordedRequest[] = [];
    await probeFor("zai")({
      baseUrl: baseUrls.zai,
      credential: "secret-credential",
      fetch: recordingFetch(recorded, () => jsonResponse({ data: { limits: [] } })),
    });

    expect(recorded[0]?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(recorded[0]?.url).not.toContain("/paas/");
  });

  it("reuses the zai probe for glm_coding and derives the same origin-based URL", async () => {
    // glm_coding shares the api.z.ai origin, so the plan reuses the exact zai
    // probe function reference; the base path (/coding/paas/v4) is discarded.
    expect(quotaProbes.glm_coding).toBe(quotaProbes.zai);

    const recorded: RecordedRequest[] = [];
    const result = await probeFor("glm_coding")({
      baseUrl: baseUrls.glm_coding,
      credential: "secret-credential",
      fetch: recordingFetch(recorded, () => jsonResponse({ data: { limits: [] } })),
    });

    expect(result.ok).toBe(true);
    expect(recorded[0]?.url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    expect(recorded[0]?.url).not.toContain("/coding/");
  });

  it("retries zai with the raw token when the Bearer attempt is rejected", async () => {
    const recorded: RecordedRequest[] = [];
    const result = await probeFor("zai")({
      baseUrl: baseUrls.zai,
      credential: "secret-credential",
      fetch: recordingFetch(recorded, (attempt) =>
        attempt === 0
          ? jsonResponse({ message: "unauthorized" }, 401)
          : jsonResponse({ data: { limits: [{ percentage: 16, type: "PROMPT", unit: 5 }] } }),
      ),
    });

    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.headers.get("authorization")).toBe("Bearer secret-credential");
    expect(recorded[1]?.headers.get("authorization")).toBe("secret-credential");
    expect(result.ok).toBe(true);
    expect(result.ok ? result.entries : []).toHaveLength(1);
  });

  it("does not retry zai when the Bearer attempt failed for a reason other than auth", async () => {
    const recorded: RecordedRequest[] = [];
    const result = await probeFor("zai")({
      baseUrl: baseUrls.zai,
      credential: "secret-credential",
      fetch: recordingFetch(recorded, () => jsonResponse({ message: "upstream down" }, 500)),
    });

    expect(recorded).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.errorCode).toBe("probe_failed");
  });

  it("classifies 401 and 403 as unauthorized and other failures as probe_failed", async () => {
    for (const status of [401, 403]) {
      const result = await probeFor("deepseek")({
        baseUrl: baseUrls.deepseek,
        credential: "secret-credential",
        fetch: async () => jsonResponse({ error: "denied" }, status),
      });
      expect(result.ok).toBe(false);
      expect(result.ok ? null : result.errorCode).toBe("unauthorized");
    }

    const serverError = await probeFor("deepseek")({
      baseUrl: baseUrls.deepseek,
      credential: "secret-credential",
      fetch: async () => jsonResponse({ error: "boom" }, 500),
    });
    expect(serverError.ok ? null : serverError.errorCode).toBe("probe_failed");

    const networkError = await probeFor("deepseek")({
      baseUrl: baseUrls.deepseek,
      credential: "secret-credential",
      fetch: async () => {
        throw new Error("socket hang up");
      },
    });
    expect(networkError.ok ? null : networkError.errorCode).toBe("probe_failed");
  });

  it("degrades a timed-out probe to probe_failed", async () => {
    const neverResolving: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });

    const result = await probeFor("openai")({
      baseUrl: baseUrls.openai,
      credential: "secret-credential",
      fetch: neverResolving,
      timeoutMs: 20,
    });

    expect(result.ok).toBe(false);
    expect(result.ok ? null : result.errorCode).toBe("probe_failed");
  });

  it("resolves no probe for unknown or absent provider keys", () => {
    expect(resolveQuotaProbe("my-vllm")).toBeNull();
    expect(resolveQuotaProbe(null)).toBeNull();
    expect(resolveQuotaProbe(undefined)).toBeNull();
    expect(resolveQuotaProbe("google")).toBeNull();
  });
});

describe("provider quota scheduling and schema", () => {
  it("backs off providers that will never report far longer than transient failures", () => {
    expect(providerQuotaRefreshDelayMs("not_supported")).toBe(24 * 60 * 60_000);
    expect(providerQuotaRefreshDelayMs("requires_separate_credential")).toBe(24 * 60 * 60_000);
    expect(providerQuotaRefreshDelayMs("unauthorized")).toBe(60 * 60_000);
    expect(providerQuotaRefreshDelayMs("probe_failed")).toBe(15 * 60_000);
    expect(providerQuotaRefreshDelayMs(null)).toBe(15 * 60_000);
  });

  it("declares a quota source on every remote registry entry and none on local ones", () => {
    const supported = [
      "claude_code",
      "deepseek",
      "glm_coding",
      "kimi_coding",
      "minimax",
      "moonshot",
      "openai",
      "openai_codex",
      "openrouter",
      "zai",
    ];
    const unsupported: Record<string, "not_supported" | "requires_separate_credential"> = {
      anthropic: "requires_separate_credential",
      google: "not_supported",
      qwen: "not_supported",
      qwen_token_plan: "not_supported",
      xai: "requires_separate_credential",
    };
    const remoteKeys = Object.values(providerRegistry)
      .filter((entry) => entry.behavior.local !== true)
      .map((entry) => entry.providerKey);

    expect(remoteKeys).toHaveLength(15);
    expect([...supported, ...Object.keys(unsupported)].sort()).toEqual([...remoteKeys].sort());

    for (const key of remoteKeys) {
      const quotaSource = providerRegistry[key].behavior.quotaSource;
      expect(quotaSource, `${key} must declare a quota source`).toBeDefined();
    }
    for (const key of supported) {
      expect(providerRegistry[key as keyof typeof providerRegistry].behavior.quotaSource).toEqual({
        supported: true,
      });
      expect(typeof quotaProbes[key]).toBe("function");
    }
    for (const [key, reason] of Object.entries(unsupported)) {
      expect(providerRegistry[key as keyof typeof providerRegistry].behavior.quotaSource).toEqual({
        reason,
        supported: false,
      });
      expect(quotaProbes[key]).toBeUndefined();
    }
    for (const entry of Object.values(providerRegistry)) {
      if (entry.behavior.local === true) {
        expect(entry.behavior.quotaSource).toBeUndefined();
      }
    }
  });

  it("ships the quota schema as an incremental migration over an untouched baseline", () => {
    const baseline = readFileSync("packages/db/migrations/0001_core_baseline.sql", "utf8");
    const migration = readFileSync("packages/db/migrations/0002_provider_quota.sql", "utf8");

    // 0001 stays byte-identical for already-migrated databases.
    expect(baseline).not.toContain("provider_quota_summary");
    expect(baseline).not.toContain("quota_probe_enabled");
    expect(baseline).not.toContain("'provider_quota_probe'::text");

    expect(migration).toContain("CREATE TABLE public.provider_quota_summary");
    expect(migration).toContain("provider_quota_summary_pkey PRIMARY KEY (id)");
    expect(migration).toContain(
      "CREATE UNIQUE INDEX uq_provider_quota_summary_connection ON public.provider_quota_summary USING btree (provider_id, provider_connection_id)",
    );
    expect(migration).toContain(
      "ALTER TABLE public.provider_api_keys\n    ADD COLUMN quota_probe_enabled boolean DEFAULT true NOT NULL",
    );
    expect(migration).toContain(
      "ALTER TABLE public.provider_oauth\n    ADD COLUMN quota_probe_enabled boolean DEFAULT true NOT NULL",
    );
    // The constraint swap must re-list every existing job type or 0002 would
    // reject the three job types the baseline already ships.
    expect(migration).toContain("DROP CONSTRAINT jobs_job_type_check");
    expect(migration).toContain(
      "ARRAY['model_refresh'::text, 'provider_connection_probe'::text, 'price_sync'::text, 'provider_quota_probe'::text]",
    );
  });

  it("clears the quota summary wherever a credential deletion clears health", () => {
    const apiKeys = readFileSync("packages/db/src/console-provider-keys.ts", "utf8");
    const oauth = readFileSync("packages/db/src/providers.ts", "utf8");
    const providers = readFileSync("packages/db/src/console-providers.ts", "utf8");

    expect(apiKeys).toContain("clearProviderQuotaWithClient");
    expect(oauth).toContain("clearProviderQuotaWithClient");
    expect(providers).toContain("delete from provider_quota_summary where provider_id = $1");
  });
});
