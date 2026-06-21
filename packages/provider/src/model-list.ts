export type ListedProviderModel = {
  capabilityMetadata?: Record<string, unknown>;
  contextWindow?: number | null;
  displayName: string;
  modelId: string;
  supportsStreaming?: boolean | null;
  supportsTools?: boolean | null;
};

export async function fetchListedProviderModels(input: {
  apiKey?: string | null;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  providerKey?: string | null;
}): Promise<ListedProviderModel[]> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const request = buildProviderModelListRequest(input);
  const response = await fetchImpl(request.url, request.init);
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`Provider model list request failed with status ${response.status}.`);
  }

  return parseProviderModelList(body);
}

export function buildProviderModelListRequest(input: {
  apiKey?: string | null;
  baseUrl: string;
  providerKey?: string | null;
}): {
  init: RequestInit;
  url: string;
} {
  const init: RequestInit = { method: "GET" };
  const providerKey = input.providerKey?.toLowerCase();

  if (providerKey === "anthropic") {
    init.headers = input.apiKey
      ? {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": input.apiKey,
        }
      : {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        };
  } else if (providerKey === "openrouter" && input.apiKey) {
    init.headers = {
      "HTTP-Referer": "https://llmingress.local",
      "X-OpenRouter-Title": "LLMIngress",
      authorization: `Bearer ${input.apiKey}`,
    };
  } else if (input.apiKey) {
    init.headers = {
      authorization: `Bearer ${input.apiKey}`,
    };
  }

  return {
    init,
    url: buildModelsUrl(input.baseUrl),
  };
}

export function parseProviderModelList(body: unknown): ListedProviderModel[] {
  if (isRecord(body) && Array.isArray(body.data)) {
    return body.data
      .map((entry): ListedProviderModel | null => {
        if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
          const contextWindow = readProviderResponseContextWindow(entry);
          return {
            ...(contextWindow === null ? {} : { contextWindow }),
            displayName:
              typeof entry.name === "string" && entry.name.trim() ? entry.name : entry.id,
            modelId: entry.id,
          };
        }
        return null;
      })
      .filter((entry): entry is ListedProviderModel => entry !== null);
  }

  if (isRecord(body) && Array.isArray(body.models)) {
    return body.models
      .map((entry): ListedProviderModel | null => {
        if (isRecord(entry) && typeof entry.name === "string" && entry.name.trim()) {
          return {
            displayName: entry.name,
            modelId: entry.name,
          };
        }
        return null;
      })
      .filter((entry): entry is ListedProviderModel => entry !== null);
  }

  throw new Error("Provider model list response was not recognized.");
}

function readProviderResponseContextWindow(entry: Record<string, unknown>): number | null {
  for (const key of ["context_window", "contextWindow", "context_length", "contextLength"]) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  return null;
}

function buildModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/models`.replaceAll(/\/{2,}/g, "/");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
