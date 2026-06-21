export type ConnectivityCheckProvider = {
  baseUrl: string;
  displayName: string;
  id: string;
  modelId: string;
  providerKey: string;
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
  status: "healthy" | "failed";
  statusCode: number | null;
};

type CheckProviderConnectivityOptions = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  nowMs?: () => number;
  provider: ConnectivityCheckProvider;
  timeoutMs?: number;
};

const defaultTimeoutMs = 5_000;
const timeoutErrorMessage = "Provider connectivity check timed out.";

export async function checkProviderConnectivity(
  options: CheckProviderConnectivityOptions,
): Promise<ProviderConnectivityCheckResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const nowMs = options.nowMs ?? Date.now;
  const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
  const startedAt = nowMs();
  const checkedAt = new Date(startedAt).toISOString();

  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      buildChatCompletionsUrl(options.provider.baseUrl),
      {
        body: JSON.stringify({
          max_tokens: 1,
          messages: [{ content: "ping", role: "user" }],
          model: options.provider.modelId,
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      },
      timeoutMs,
    );
    const body = await readResponseBody(response);
    const latencyMs = Math.max(0, nowMs() - startedAt);

    if (!response.ok) {
      const error = readProviderError(body);
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
        status: "failed",
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
      status: "failed",
      statusCode: null,
    };
  }
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
  if (isRecord(body) && isRecord(body.error)) {
    const code = typeof body.error.code === "string" ? body.error.code : "provider_http_error";
    const message =
      typeof body.error.message === "string" ? body.error.message : "Provider request failed.";
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
