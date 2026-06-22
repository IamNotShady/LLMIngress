export type ConnectivityCheckProvider = {
  baseUrl: string;
  displayName: string;
  id: string;
  modelId: string;
  providerKey: string;
};

import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
} from "./subscription.js";

export type ProviderProbeModelCandidate = {
  contextWindow: number | null;
  inputUsdPerMillionTokens?: number | string | null;
  modelId: string;
  outputUsdPerMillionTokens?: number | string | null;
};

export type ProviderConnectivityCheckResult = {
  checkedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
  latencyMs: number;
  ok: boolean;
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
  providerId: string;
  providerKey: string;
  probeModelId: string;
  retryable: boolean;
  status: ProviderConnectivityStatus;
  statusCode: number | null;
};

export type ProviderConnectivityFailureStatus =
  | "auth_failed"
  | "network_error"
  | "quota_limited"
  | "unhealthy";
export type ProviderConnectivityStatus = "healthy" | ProviderConnectivityFailureStatus;

type CheckProviderConnectivityOptions = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
  provider: ConnectivityCheckProvider;
  timeoutMs?: number;
};

const defaultTimeoutMs = 5_000;
const timeoutErrorMessage = "Provider connectivity check timed out.";

export function selectProviderProbeModel(candidates: ProviderProbeModelCandidate[]): string | null {
  const ranked = candidates
    .filter((candidate) => isEligibleProbeModel(candidate))
    .map((candidate) => ({
      candidate,
      rank: rankProbeModel(candidate),
    }));

  ranked.sort((left, right) => compareProbeModelRank(left.rank, right.rank));
  return ranked[0]?.candidate.modelId ?? null;
}

export async function checkProviderConnectivity(
  options: CheckProviderConnectivityOptions,
): Promise<ProviderConnectivityCheckResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const nowMs = options.nowMs ?? Date.now;
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const startedAt = nowMs();
  const checkedAt = new Date(startedAt).toISOString();

  try {
    const request = buildProviderConnectivityRequest({
      apiKey: options.apiKey,
      provider: options.provider,
    });
    const response = await fetchWithTimeout(fetchImpl, request.url, request.init, timeoutMs);
    const body = await readResponseBody(response);
    const latencyMs = Math.max(0, nowMs() - startedAt);

    if (!response.ok) {
      const error = readProviderError(body);
      const status = classifyProviderFailureStatus({
        errorCode: error.code,
        errorMessage: error.message,
        statusCode: response.status,
      });
      return {
        checkedAt,
        errorCode: error.code,
        errorMessage: error.message,
        latencyMs,
        ok: false,
        probeModelId: options.provider.modelId,
        providerId: options.provider.id,
        providerKey: options.provider.providerKey,
        retryable: response.status === 429 || response.status >= 500,
        status,
        statusCode: response.status,
      };
    }

    return {
      checkedAt,
      errorCode: null,
      errorMessage: null,
      latencyMs,
      ok: true,
      probeModelId: options.provider.modelId,
      providerId: options.provider.id,
      providerKey: options.provider.providerKey,
      retryable: false,
      status: "healthy",
      statusCode: response.status,
    };
  } catch (error) {
    const latencyMs = Math.max(0, nowMs() - startedAt);
    const timedOut = error instanceof ProviderProbeTimeoutError;

    return {
      checkedAt,
      errorCode: timedOut ? "provider_probe_timeout" : "provider_request_failed",
      errorMessage: timedOut
        ? timeoutErrorMessage
        : error instanceof Error
          ? error.message
          : "Provider request failed.",
      latencyMs,
      ok: false,
      probeModelId: options.provider.modelId,
      providerId: options.provider.id,
      providerKey: options.provider.providerKey,
      retryable: true,
      status: classifyProviderFailureStatus({
        errorCode: timedOut ? "provider_probe_timeout" : "provider_request_failed",
        errorMessage: timedOut
          ? timeoutErrorMessage
          : error instanceof Error
            ? error.message
            : "Provider request failed.",
        statusCode: null,
      }),
      statusCode: null,
    };
  }
}

function buildProviderConnectivityRequest(input: {
  apiKey: string;
  provider: ConnectivityCheckProvider;
}): { init: RequestInit; url: string } {
  const providerKey = input.provider.providerKey.toLowerCase();

  if (providerKey === "openai_codex") {
    return {
      init: {
        body: JSON.stringify({
          input: [{ content: [{ text: "ping", type: "input_text" }], role: "user" }],
          instructions: "You are a helpful assistant.",
          model: input.provider.modelId,
          store: false,
          stream: true,
        }),
        headers: buildCodexSubscriptionHeaders(input.apiKey),
        method: "POST",
      },
      url: buildCodexResponsesUrl(input.provider.baseUrl),
    };
  }

  if (providerKey === "claude_code") {
    return {
      init: {
        body: JSON.stringify({
          max_tokens: 1,
          messages: [{ content: "ping", role: "user" }],
          model: input.provider.modelId,
          stream: false,
        }),
        headers: buildClaudeCodeSubscriptionHeaders(input.apiKey),
        method: "POST",
      },
      url: buildClaudeCodeMessagesUrl(input.provider.baseUrl),
    };
  }

  return {
    init: {
      body: JSON.stringify({
        ...buildProbeTokenLimit(input.provider),
        messages: [{ content: "ping", role: "user" }],
        model: input.provider.modelId,
        stream: false,
      }),
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
    },
    url: buildChatCompletionsUrl(input.provider.baseUrl),
  };
}

export function classifyProviderFailureStatus(input: {
  errorCode?: string | null;
  errorMessage?: string | null;
  statusCode?: number | null;
}): ProviderConnectivityFailureStatus {
  if (input.statusCode === null) {
    return "network_error";
  }

  const statusCode = typeof input.statusCode === "number" ? input.statusCode : null;
  if (statusCode === 401 || statusCode === 403) {
    return "auth_failed";
  }
  if (statusCode === 402 || statusCode === 429) {
    return "quota_limited";
  }

  const text = `${input.errorCode ?? ""} ${input.errorMessage ?? ""}`.toLowerCase();
  if (
    /invalid[_ -]?api[_ -]?key|unauthori[sz]ed|authentication|permission_denied|forbidden/.test(
      text,
    )
  ) {
    return "auth_failed";
  }
  if (
    /quota|rate[_ -]?limit|billing|balance|insufficient|resource_exhausted|no resource package/.test(
      text,
    )
  ) {
    return "quota_limited";
  }
  if (
    /timeout|timed out|network|dns|tls|socket|fetch failed|econnreset|enotfound|abort/.test(text)
  ) {
    return "network_error";
  }

  return "unhealthy";
}

type ProbeModelRank = {
  contextWindow: number;
  lightPenalty: number;
  priceTotal: number;
  priceUnknownPenalty: number;
  specialPenalty: number;
  stableModelId: string;
};

function isEligibleProbeModel(candidate: ProviderProbeModelCandidate): boolean {
  return (
    typeof candidate.contextWindow === "number" &&
    Number.isFinite(candidate.contextWindow) &&
    candidate.contextWindow > 0 &&
    !isObviouslyNonChatModel(candidate.modelId)
  );
}

function rankProbeModel(candidate: ProviderProbeModelCandidate): ProbeModelRank {
  const inputPrice = parsePrice(candidate.inputUsdPerMillionTokens);
  const outputPrice = parsePrice(candidate.outputUsdPerMillionTokens);
  const priceTotal = inputPrice === null || outputPrice === null ? null : inputPrice + outputPrice;

  return {
    contextWindow: candidate.contextWindow ?? Number.MAX_SAFE_INTEGER,
    lightPenalty: isLightGeneralModel(candidate.modelId) ? 0 : 1,
    priceTotal: priceTotal ?? Number.POSITIVE_INFINITY,
    priceUnknownPenalty: priceTotal === null ? 1 : 0,
    specialPenalty: isSpecialOrSlowModel(candidate.modelId) ? 1 : 0,
    stableModelId: candidate.modelId,
  };
}

function compareProbeModelRank(left: ProbeModelRank, right: ProbeModelRank): number {
  return (
    left.priceUnknownPenalty - right.priceUnknownPenalty ||
    left.priceTotal - right.priceTotal ||
    left.lightPenalty - right.lightPenalty ||
    left.specialPenalty - right.specialPenalty ||
    left.contextWindow - right.contextWindow ||
    left.stableModelId.localeCompare(right.stableModelId)
  );
}

function buildProbeTokenLimit(provider: ConnectivityCheckProvider): Record<string, number> {
  if (
    provider.providerKey.toLowerCase() === "openai" &&
    isOpenAIReasoningStyleModel(provider.modelId)
  ) {
    return { max_completion_tokens: 1 };
  }
  return { max_tokens: 1 };
}

function isOpenAIReasoningStyleModel(modelId: string): boolean {
  const tokens = modelTokens(modelId);
  return (
    tokens.has("reasoning") ||
    tokens.has("thinking") ||
    [...tokens].some((token) => /^o[134]$/.test(token))
  );
}

function isObviouslyNonChatModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  if (
    /(embedding|image|audio|tts|speech|transcrib|whisper|moderation|sora|dall|veo|lyria|clip|rerank|ocr|realtime|vision|omni|search|deep-research|computer-use)/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return modelTokens(normalized).has("vl");
}

function isLightGeneralModel(modelId: string): boolean {
  const tokens = modelTokens(modelId);
  return ["mini", "flash", "turbo", "lite", "air", "small"].some((token) => tokens.has(token));
}

function isSpecialOrSlowModel(modelId: string): boolean {
  const tokens = modelTokens(modelId);
  return ["max", "pro", "preview", "reasoning", "thinking", "coder", "o1", "o3", "o4"].some(
    (token) => tokens.has(token),
  );
}

function modelTokens(modelId: string): Set<string> {
  return new Set(
    modelId
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

function parsePrice(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function fetchWithTimeout(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderProbeTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function buildChatCompletionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/chat/completions`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function readProviderError(body: unknown): { code: string; message: string } {
  const errorBody = Array.isArray(body)
    ? body.find((item) => isRecord(item) && isRecord(item.error))
    : body;
  if (isRecord(errorBody) && isRecord(errorBody.error)) {
    const rawCode = errorBody.error.status ?? errorBody.error.code;
    const code =
      typeof rawCode === "string"
        ? rawCode
        : typeof rawCode === "number"
          ? String(rawCode)
          : "provider_http_error";
    const message =
      typeof errorBody.error.message === "string"
        ? errorBody.error.message
        : "Provider request failed.";
    return { code, message };
  }

  return {
    code: "provider_http_error",
    message: "Provider request failed.",
  };
}

function normalizeTimeoutMs(value: number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return defaultTimeoutMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class ProviderProbeTimeoutError extends Error {
  constructor() {
    super(timeoutErrorMessage);
    this.name = "ProviderProbeTimeoutError";
  }
}
