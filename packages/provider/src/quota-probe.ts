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
  minimax: async (input) =>
    parsed(input, parseMinimaxQuota, {
      headers: bearer(input.credential),
      url: joinUrl(input.baseUrl, "token_plan/remains"),
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
  zai: async (input) => {
    // The quota path shares only the origin with the configured base URL
    // (base is /api/paas/v4, quota is /api/monitor/...), so joinUrl is wrong here.
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
