import type { QuotaEntry, WindowEntry } from "@llmingress/domain/quota";
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

/**
 * Z.ai quota probe. The quota path shares only the origin with the configured
 * base URL (base is /api/paas/v4 or /api/coding/paas/v4, quota is
 * /api/monitor/...), so joinUrl is wrong here. glm_coding reuses this exact
 * function: its api.z.ai origin makes the probe URL identical to zai's.
 */
const zaiQuotaProbe: QuotaProbe = async (input) => {
  const url = new URL("/api/monitor/usage/quota/limit", new URL(input.baseUrl).origin).toString();
  const bearerResult = await parsed(input, parseZaiQuota, {
    headers: { ...bearer(input.credential), "accept-language": "en-US,en" },
    url,
  });
  if (bearerResult.ok || bearerResult.errorCode !== "unauthorized") {
    return bearerResult;
  }
  // Implementations disagree on whether Zhipu wants a scheme, so a rejected
  // credential is retried raw. Only an auth rejection: retrying a timeout or a
  // 500 would double the request and report the second attempt's error code.
  return parsed(input, parseZaiQuota, {
    headers: {
      accept: "application/json",
      "accept-language": "en-US,en",
      authorization: input.credential,
    },
    url,
  });
};

/**
 * This module is the implementing module for quota probing, so keying the
 * lookup by providerKey is the dispatch itself, not a leaked string compare.
 */
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
  // glm_coding shares the api.z.ai origin, so it reuses the exact zai probe.
  glm_coding: zaiQuotaProbe,
  kimi_coding: async (input) =>
    parsed(input, parseKimiQuota, {
      // Bearer to /coding/v1/usages — a different endpoint and auth than the
      // messages egress, which uses x-api-key.
      headers: bearer(input.credential),
      url: joinUrl(input.baseUrl, "usages"),
    }),
  minimax: async (input) =>
    parsed(input, parseMinimaxQuota, {
      headers: bearer(input.credential),
      url: joinUrl(input.baseUrl, "token_plan/remains"),
    }),
  minimax_coding: async (input) =>
    parsed(input, parseMinimaxCodingPlanQuota, {
      headers: bearer(input.credential),
      // The coding-plan quota lives at the api.minimax.io root, not under the
      // /anthropic/v1 messages base, so derive it from the origin like zai —
      // a joinUrl against the subscription base would land on the wrong path.
      url: new URL(
        "/v1/api/openplatform/coding_plan/remains",
        new URL(input.baseUrl).origin,
      ).toString(),
    }),
  moonshot: async (input) =>
    parsed(input, (body) => parseMoonshotQuota(body, moonshotQuotaCurrency(input.baseUrl)), {
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
  zai: zaiQuotaProbe,
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

/**
 * Monetary amounts stay decimal strings end to end. A provider that already
 * sends a string keeps its exact text — round-tripping "110.00" through a
 * JS number would silently rewrite it as "110".
 */
function readDecimal(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed && Number.isFinite(Number(trimmed)) ? trimmed : null;
  }
  return typeof value === "number" && Number.isFinite(value) ? String(value) : null;
}

// ── parsers ────────────────────────────────────────────────────────────────

/**
 * Structural, not allowlist-based: Anthropic adds windows over time
 * (seven_day_opus is absent from the response headers but present here).
 *
 * Scale: this endpoint reports utilization as 0-100 percent (a live account
 * showed 24 / 53). The `anthropic-ratelimit-unified-*` response headers use a
 * 0-1 fraction instead — do not conflate the two surfaces.
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
    const usedPercent = readNumber(value.utilization);
    if (usedPercent === null) {
      continue;
    }
    entries.push({
      ...(typeof value.resets_at === "string" ? { resetsAt: value.resets_at } : {}),
      utilization: usedPercent / 100,
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
        total: String(limit - used),
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
    const total = readDecimal(info.total_balance);
    if (total === null) {
      continue;
    }
    const granted = readDecimal(info.granted_balance);
    const toppedUp = readDecimal(info.topped_up_balance);
    entries.push({
      currency: info.currency,
      ...(granted === null ? {} : { granted }),
      ...(toppedUp === null ? {} : { toppedUp }),
      total,
    });
  }
  return entries;
}

/** api.moonshot.ai bills USD; the .cn deployment bills CNY on the same path. */
export function moonshotQuotaCurrency(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.endsWith(".cn") ? "CNY" : "USD";
  } catch {
    return "USD";
  }
}

export function parseMoonshotQuota(body: unknown, currency = "USD"): QuotaEntry[] {
  if (!isRecord(body) || !isRecord(body.data)) {
    return [];
  }
  const total = readDecimal(body.data.available_balance);
  if (total === null) {
    return [];
  }
  const granted = readDecimal(body.data.voucher_balance);
  const toppedUp = readDecimal(body.data.cash_balance);
  return [
    {
      currency,
      ...(granted === null ? {} : { granted }),
      ...(toppedUp === null ? {} : { toppedUp }),
      total,
    },
  ];
}

export function parseOpenAIQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body)) {
    return [];
  }
  const total = readDecimal(body.total_available);
  if (total === null) {
    return [];
  }
  const granted = readDecimal(body.total_granted);
  return [
    {
      currency: "USD",
      ...(granted === null ? {} : { granted }),
      total,
    },
  ];
}

/** limit_remaining is nullable: null means no limit is configured, which is not zero. */
export function parseOpenRouterQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body) || !isRecord(body.data)) {
    return [];
  }
  const total = readDecimal(body.data.limit_remaining);
  if (total === null) {
    return [];
  }
  const granted = readDecimal(body.data.limit);
  return [
    {
      currency: "USD",
      ...(granted === null ? {} : { granted }),
      total,
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

/**
 * MiniMax Coding Plan usage (`GET /v1/api/openplatform/coding_plan/remains`).
 * Distinct from the api_key `minimax` token_plan probe above: the coding-plan
 * payload nests the windows inside `model_remains[]` under the `general` model
 * (video and other models are skipped), gates the weekly window on
 * `current_weekly_status === 1` (status 3 means the plan has no weekly cap and
 * its remaining percent is a constant 100), and carries reset epochs in
 * milliseconds. Utilization stays the repo's 0-1 fraction (the inverse of the
 * reported remaining percent), never the payload's 0-100 percent scale.
 */
export function parseMinimaxCodingPlanQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body)) {
    return [];
  }
  // A 200 response can still carry a business error in base_resp; a non-zero
  // status_code (e.g. an expired/invalid token) must not read as "no quota".
  // Throwing routes it through the shared parsed() catch to the probe_failed
  // path with the upstream status_msg — structurally identical to a non-2xx
  // failure — so a stale token never renders as empty quota data. No public
  // status_code -> auth-class mapping exists, so all non-zero codes unify to
  // the generic probe-failure path.
  if (isRecord(body.base_resp)) {
    const statusCode = readNumber(body.base_resp.status_code);
    if (statusCode !== null && statusCode !== 0) {
      const statusMsg =
        typeof body.base_resp.status_msg === "string" && body.base_resp.status_msg.trim()
          ? body.base_resp.status_msg
          : "unknown error";
      throw new Error(`MiniMax coding_plan error (status_code ${statusCode}): ${statusMsg}`);
    }
  }
  if (!Array.isArray(body.model_remains)) {
    return [];
  }
  const general = body.model_remains.find(
    (item) => isRecord(item) && item.model_name === "general",
  );
  if (!isRecord(general)) {
    return [];
  }
  const entries: QuotaEntry[] = [];
  const interval = readNumber(general.current_interval_remaining_percent);
  if (interval !== null) {
    const resetMs = readNumber(general.end_time);
    entries.push({
      ...(resetMs === null ? {} : { resetsAt: new Date(resetMs).toISOString() }),
      utilization: 1 - interval / 100,
      window: "interval",
    });
  }
  if (readNumber(general.current_weekly_status) === 1) {
    const weekly = readNumber(general.current_weekly_remaining_percent);
    if (weekly !== null) {
      const resetMs = readNumber(general.weekly_end_time);
      entries.push({
        ...(resetMs === null ? {} : { resetsAt: new Date(resetMs).toISOString() }),
        utilization: 1 - weekly / 100,
        window: "weekly",
      });
    }
  }
  return entries;
}

/**
 * Kimi coding-plan usage (`GET /coding/v1/usages`). Two windows: the first
 * detail-bearing `limits[]` entry is the 5-hour window (extra `limits[]` rows
 * are ignored to avoid duplicate Console rows), and `usage` is the weekly
 * window. utilization is a 0-1 fraction `(limit - remaining) / limit`, never
 * scaled to 0-100. `resetTime` is
 * tolerantly parsed (epoch number or a parseable date string) into an ISO
 * `resetsAt`, matching the repo convention.
 */
export function parseKimiQuota(body: unknown): QuotaEntry[] {
  if (!isRecord(body)) {
    return [];
  }
  const entries: QuotaEntry[] = [];
  const firstDetailLimit = Array.isArray(body.limits)
    ? body.limits.find((limit) => isRecord(limit) && isRecord(limit.detail))
    : undefined;
  if (isRecord(firstDetailLimit) && isRecord(firstDetailLimit.detail)) {
    const entry = kimiWindow("five_hour", firstDetailLimit.detail);
    if (entry) {
      entries.push(entry);
    }
  }
  if (isRecord(body.usage)) {
    const entry = kimiWindow("weekly_limit", body.usage);
    if (entry) {
      entries.push(entry);
    }
  }
  return entries;
}

function kimiWindow(window: string, detail: Record<string, unknown>): WindowEntry | null {
  const limit = readNumber(detail.limit);
  const remaining = readNumber(detail.remaining);
  if (limit === null || remaining === null || limit <= 0) {
    return null;
  }
  const resetsAt = readKimiResetTime(detail.resetTime);
  return {
    ...(resetsAt === null ? {} : { resetsAt }),
    utilization: (limit - remaining) / limit,
    window,
  };
}

function readKimiResetTime(value: unknown): string | null {
  const epoch = readNumber(value);
  if (epoch !== null) {
    // Kimi may report epoch seconds or milliseconds; normalize both to ms.
    const ms = epoch < 1e12 ? epoch * 1000 : epoch;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}
