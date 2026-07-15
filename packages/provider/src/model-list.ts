import type { ModelInputModality, ModelOutputModality } from "@llmingress/domain";
import { isRecord } from "@llmingress/util";

export type ListedProviderModel = {
  capabilityMetadata?: Record<string, unknown>;
  contextWindow?: number | null;
  displayName: string;
  inputModalities?: ModelInputModality[] | null;
  maxOutputTokens?: number | null;
  modelId: string;
  outputModalities?: ModelOutputModality[] | null;
  supportsFunctionCalling?: boolean | null;
  supportsReasoning?: boolean | null;
  supportsStreaming?: boolean | null;
  supportsTools?: boolean | null;
};

import { resolveProviderDescriptor } from "@llmingress/provider/descriptor";
import { fetchCredentialedProviderRequestWithTimeout } from "./authenticated-http.js";
import {
  buildClaudeCodeModelListUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexModelListUrl,
  buildCodexSubscriptionHeaders,
} from "./subscription.js";

const defaultModelListTimeoutMs = 15_000;

export async function fetchListedProviderModels(input: {
  apiKey?: string | null;
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  providerKey?: string | null;
  timeoutMs?: number;
}): Promise<ListedProviderModel[]> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const timeoutMs = input.timeoutMs ?? defaultModelListTimeoutMs;
  const request = buildProviderModelListRequest(input);
  const response = await fetchCredentialedProviderRequestWithTimeout(
    fetchImpl,
    request.url,
    request.init,
    { timeoutMs },
  );
  const body = await readResponseBody(response);

  if (!response.ok) {
    throw new Error(`Provider model list request failed with status ${response.status}.`);
  }

  const models = normalizeProviderModelList(parseProviderModelList(body), input.providerKey);
  if (input.providerKey?.trim().toLowerCase() === "llama_cpp") {
    return enrichLlamaCppProviderModels({
      baseUrl: input.baseUrl,
      fetch: fetchImpl,
      models,
      timeoutMs,
    });
  }
  return models;
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
  const style = resolveProviderDescriptor(input.providerKey).modelListStyle;

  if (style === "codex" && input.apiKey) {
    init.headers = buildCodexSubscriptionHeaders(input.apiKey);
    return {
      init,
      url: buildCodexModelListUrl(input.baseUrl),
    };
  }

  if (style === "claude_code" && input.apiKey) {
    init.headers = buildClaudeCodeSubscriptionHeaders(input.apiKey);
    return {
      init,
      url: buildClaudeCodeModelListUrl(input.baseUrl),
    };
  }

  if (style === "lmstudio") {
    return {
      init,
      url: buildLmStudioModelListUrl(input.baseUrl),
    };
  }

  if (style === "anthropic") {
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
  } else if (style === "openrouter" && input.apiKey) {
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
  if (isRecord(body) && Array.isArray(body.models)) {
    const dataById = buildProviderModelDataIndex(body.data);
    const models = body.models
      .map((entry): ListedProviderModel | null => {
        if (isRecord(entry) && typeof entry.slug === "string" && entry.slug.trim()) {
          if (typeof entry.visibility === "string" && entry.visibility !== "list") {
            return null;
          }
          return {
            capabilityMetadata: { code: true },
            contextWindow: readProviderResponseContextWindow(entry) ?? 200000,
            displayName:
              typeof entry.display_name === "string" && entry.display_name.trim()
                ? entry.display_name
                : entry.slug,
            modelId: entry.slug,
            supportsStreaming: true,
            supportsTools: true,
          };
        }
        if (isRecord(entry) && typeof entry.name === "string" && entry.name.trim()) {
          const dataEntry = dataById.get(entry.name);
          const contextWindow =
            readProviderResponseContextWindow(entry) ??
            (dataEntry ? readProviderResponseContextWindow(dataEntry) : null);
          const supportsTools = readSupportsTools(entry);
          return {
            ...(contextWindow === null ? {} : { contextWindow }),
            displayName: entry.name,
            modelId: entry.name,
            ...(supportsTools === null ? {} : { supportsTools }),
          };
        }
        return null;
      })
      .filter((entry): entry is ListedProviderModel => entry !== null);
    if (models.length > 0) {
      return models;
    }
  }

  if (isRecord(body) && Array.isArray(body.data)) {
    return body.data
      .map((entry): ListedProviderModel | null => {
        if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
          const contextWindow = readProviderResponseContextWindow(entry);
          const supportsTools = readSupportsTools(entry);
          return {
            ...(supportsTools === null ? {} : { supportsTools }),
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

  throw new Error("Provider model list response was not recognized.");
}

function buildProviderModelDataIndex(data: unknown): Map<string, Record<string, unknown>> {
  const index = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(data)) {
    return index;
  }
  for (const entry of data) {
    if (isRecord(entry) && typeof entry.id === "string" && entry.id.trim()) {
      index.set(entry.id, entry);
    }
  }
  return index;
}

function readProviderResponseContextWindow(entry: Record<string, unknown>): number | null {
  for (const key of [
    "context_window",
    "contextWindow",
    "context_length",
    "contextLength",
    "max_context_length",
    "loaded_context_length",
    "n_ctx",
  ]) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return Math.floor(value);
    }
  }
  const meta = entry.meta;
  if (isRecord(meta)) {
    return readProviderResponseContextWindow(meta);
  }
  const params = entry.params;
  if (isRecord(params)) {
    return readProviderResponseContextWindow(params);
  }
  return null;
}

function readSupportsTools(entry: Record<string, unknown>): boolean | null {
  const capabilities = entry.capabilities;
  if (!Array.isArray(capabilities)) {
    return null;
  }
  return capabilities.includes("tool_use") || capabilities.includes("tools");
}

function buildModelsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/models`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

function buildLmStudioModelListUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.pathname = `${path}/api/v0/models`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

async function enrichLlamaCppProviderModels(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  models: ListedProviderModel[];
  timeoutMs: number;
}): Promise<ListedProviderModel[]> {
  try {
    const response = await fetchCredentialedProviderRequestWithTimeout(
      input.fetch,
      buildLlamaCppPropsUrl(input.baseUrl),
      { method: "GET" },
      { timeoutMs: input.timeoutMs },
    );
    if (!response.ok) {
      return input.models;
    }
    const props = await readResponseBody(response);
    const supportsTools = readLlamaCppSupportsTools(props);
    const contextWindow =
      isRecord(props) && isRecord(props.default_generation_settings)
        ? readProviderResponseContextWindow(props.default_generation_settings)
        : null;
    return input.models.map((model) => ({
      ...model,
      ...(contextWindow === null ? {} : { contextWindow: model.contextWindow ?? contextWindow }),
      ...(supportsTools === null ? {} : { supportsTools }),
    }));
  } catch {
    return input.models;
  }
}

function buildLlamaCppPropsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.pathname = `${path}/props`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

function readLlamaCppSupportsTools(props: unknown): boolean | null {
  if (!isRecord(props) || !isRecord(props.chat_template_caps)) {
    return null;
  }
  const value =
    props.chat_template_caps.supports_tools ?? props.chat_template_caps.supports_tool_calls;
  return typeof value === "boolean" ? value : null;
}

function normalizeProviderModelList(
  models: ListedProviderModel[],
  providerKey?: string | null,
): ListedProviderModel[] {
  if (providerKey?.trim().toLowerCase() !== "google") {
    return models;
  }

  return models.map((model) => ({
    ...model,
    displayName: stripGoogleModelPrefix(model.displayName),
    modelId: stripGoogleModelPrefix(model.modelId),
  }));
}

function stripGoogleModelPrefix(value: string): string {
  return value.startsWith("models/") ? value.slice("models/".length) : value;
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
