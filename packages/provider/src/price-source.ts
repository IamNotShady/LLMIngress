import { listPriceSyncSupportedProviderKeys } from "@llmingress/provider/descriptor";

export const MODELS_DEV_PRICE_SOURCE_URL = "https://models.dev/api.json";
export const LITELLM_PRICE_SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const OPENROUTER_MODEL_SOURCE_URL = "https://openrouter.ai/api/v1/models";
export const VERCEL_AI_GATEWAY_MODEL_SOURCE_URL = "https://ai-gateway.vercel.sh/v1/models";

export type ProviderModelPriceSource = "litellm" | "models.dev";
export type ProviderModelRegistrySource =
  | "litellm"
  | "models.dev"
  | "openrouter"
  | "vercel-ai-gateway";

type ProviderModelRegistryField =
  | "contextWindow"
  | "outputTokenLimit"
  | "reasoning"
  | "supportsStreaming"
  | "supportsTools";

export type ProviderModelSyncedPrice = {
  cachedInputUsdPerMillionTokens: number | null;
  inputUsdPerMillionTokens: number;
  metadata?: Record<string, unknown>;
  modelId: string;
  outputUsdPerMillionTokens: number;
  priceVersion: string;
  providerKey: string;
  source: ProviderModelPriceSource;
  sourceUrl: string;
  syncedAt: Date;
};

export type ProviderModelRegistryEntry = {
  contextWindow?: number | null;
  modelId: string;
  outputTokenLimit?: number | null;
  providerKey: string;
  reasoningDefaultLevel?: string | null;
  reasoningLevels?: string[];
  reasoningSupport?: boolean | null;
  registrySources?: Partial<Record<ProviderModelRegistryField, ProviderModelRegistrySource>>;
  streamingInferred?: boolean;
  supportsStreaming?: boolean | null;
  supportsTools?: boolean | null;
  syncedAt: Date;
};

type NormalizePriceOptions = {
  sourceUrl: string;
  syncedAt: Date;
};

type FetchProviderModelPricesOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

type FetchProviderModelRegistryOptions = FetchProviderModelPricesOptions;

const supportedProviderKeys = new Set(listPriceSyncSupportedProviderKeys());

const providerKeyAliases = new Map<string, string>([
  ["alibaba", "qwen"],
  ["dashscope", "qwen"],
  ["google-ai-studio", "google"],
  ["google_ai_studio", "google"],
  ["moonshotai", "moonshot"],
  ["moonshotai-cn", "moonshot"],
  ["x-ai", "xai"],
  ["z-ai", "zai"],
]);

export async function fetchProviderModelPrices(
  options: FetchProviderModelPricesOptions = {},
): Promise<ProviderModelSyncedPrice[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const syncedAt = options.now?.() ?? new Date();
  const [primary, auxiliary] = await Promise.allSettled([
    fetchJson(fetchImpl, MODELS_DEV_PRICE_SOURCE_URL),
    fetchJson(fetchImpl, LITELLM_PRICE_SOURCE_URL),
  ]);
  const primaryPrices =
    primary.status === "fulfilled"
      ? normalizeModelsDevProviderModelPrices(primary.value, {
          sourceUrl: MODELS_DEV_PRICE_SOURCE_URL,
          syncedAt,
        })
      : [];
  const auxiliaryPrices =
    auxiliary.status === "fulfilled"
      ? normalizeLiteLlmProviderModelPrices(auxiliary.value, {
          sourceUrl: LITELLM_PRICE_SOURCE_URL,
          syncedAt,
        })
      : [];
  const prices = mergeProviderModelPrices(primaryPrices, auxiliaryPrices);

  if (prices.length === 0) {
    throw new Error("No provider model prices were available from configured price sources.");
  }

  return prices;
}

export async function fetchProviderModelRegistryEntries(
  options: FetchProviderModelRegistryOptions = {},
): Promise<ProviderModelRegistryEntry[]> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const syncedAt = options.now?.() ?? new Date();
  const [modelsDev, openRouter, liteLlm, vercel] = await Promise.allSettled([
    fetchJson(fetchImpl, MODELS_DEV_PRICE_SOURCE_URL),
    fetchJson(fetchImpl, OPENROUTER_MODEL_SOURCE_URL),
    fetchJson(fetchImpl, LITELLM_PRICE_SOURCE_URL),
    fetchJson(fetchImpl, VERCEL_AI_GATEWAY_MODEL_SOURCE_URL),
  ]);

  return mergeProviderModelRegistryEntries(
    modelsDev.status === "fulfilled"
      ? normalizeModelsDevProviderModelRegistryEntries(modelsDev.value, {
          sourceUrl: MODELS_DEV_PRICE_SOURCE_URL,
          syncedAt,
        })
      : [],
    openRouter.status === "fulfilled"
      ? normalizeOpenRouterProviderModelRegistryEntries(openRouter.value, {
          sourceUrl: OPENROUTER_MODEL_SOURCE_URL,
          syncedAt,
        })
      : [],
    liteLlm.status === "fulfilled"
      ? normalizeLiteLlmProviderModelRegistryEntries(liteLlm.value, {
          sourceUrl: LITELLM_PRICE_SOURCE_URL,
          syncedAt,
        })
      : [],
    vercel.status === "fulfilled"
      ? normalizeVercelAiGatewayProviderModelRegistryEntries(vercel.value, {
          sourceUrl: VERCEL_AI_GATEWAY_MODEL_SOURCE_URL,
          syncedAt,
        })
      : [],
  );
}

export function normalizeModelsDevProviderModelRegistryEntries(
  payload: unknown,
  options: NormalizePriceOptions,
): ProviderModelRegistryEntry[] {
  const providers = readRecord(payload);
  const entries: ProviderModelRegistryEntry[] = [];

  for (const [sourceProviderKey, providerPayload] of Object.entries(providers)) {
    const providerKey = normalizeProviderKey(sourceProviderKey);
    if (!providerKey) {
      continue;
    }

    for (const model of readModelCollection(readRecord(providerPayload).models)) {
      const modelId = readString(model.id);
      if (!modelId) {
        continue;
      }

      const limit = readRecord(model.limit);
      const contextWindow = readPositiveInteger(limit.context);
      const outputTokenLimit = readPositiveInteger(limit.output);
      const supportsTools = readOptionalBoolean(model.tool_call);
      const reasoningSupport = readOptionalBoolean(model.reasoning);
      const streaming = inferStreamingSupport({
        explicit: null,
        model,
        modelId,
      });

      entries.push({
        contextWindow,
        modelId,
        outputTokenLimit,
        providerKey,
        reasoningLevels: readReasoningLevels(model.reasoning_options),
        reasoningSupport,
        registrySources: registrySources({
          contextWindow,
          outputTokenLimit,
          reasoningSupport,
          source: "models.dev",
          supportsStreaming: streaming.value,
          supportsTools,
        }),
        streamingInferred: streaming.inferred,
        supportsStreaming: streaming.value,
        supportsTools,
        syncedAt: options.syncedAt,
      });
    }
  }

  return dedupeProviderModelRegistryEntries(entries);
}

export function normalizeOpenRouterProviderModelRegistryEntries(
  payload: unknown,
  options: NormalizePriceOptions,
): ProviderModelRegistryEntry[] {
  const entries: ProviderModelRegistryEntry[] = [];
  const data = readRecord(payload).data;
  const models = Array.isArray(data) ? data : [];

  for (const rawModel of models) {
    const model = readRecord(rawModel);
    const rawModelId = readString(model.id);
    if (!rawModelId) {
      continue;
    }
    const sourceProviderKey = rawModelId.split("/")[0] ?? "";
    const providerKey = normalizeProviderKey(sourceProviderKey);
    if (!providerKey) {
      continue;
    }
    const modelId = stripProviderModelPrefix(rawModelId, {
      providerKey,
      sourceProviderKey,
    });
    const topProvider = readRecord(model.top_provider);
    const contextWindow =
      readPositiveInteger(model.context_length) ?? readPositiveInteger(topProvider.context_length);
    const outputTokenLimit = readPositiveInteger(topProvider.max_completion_tokens);
    const supportedParameters = readStringArray(model.supported_parameters);
    const supportsTools =
      supportedParameters.includes("tools") || supportedParameters.includes("tool_choice");
    const reasoning = readRecord(model.reasoning);
    const reasoningLevels = readStringArray(reasoning.supported_efforts);
    const reasoningSupport =
      Object.keys(reasoning).length > 0 ||
      supportedParameters.includes("reasoning") ||
      supportedParameters.includes("include_reasoning");
    const streaming = inferStreamingSupport({
      explicit: null,
      model,
      modelId,
    });

    entries.push({
      contextWindow,
      modelId,
      outputTokenLimit,
      providerKey,
      reasoningDefaultLevel: readString(reasoning.default_effort),
      reasoningLevels,
      reasoningSupport,
      registrySources: registrySources({
        contextWindow,
        outputTokenLimit,
        reasoningSupport,
        source: "openrouter",
        supportsStreaming: streaming.value,
        supportsTools,
      }),
      streamingInferred: streaming.inferred,
      supportsStreaming: streaming.value,
      supportsTools,
      syncedAt: options.syncedAt,
    });
  }

  return dedupeProviderModelRegistryEntries(entries);
}

export function normalizeLiteLlmProviderModelRegistryEntries(
  payload: unknown,
  options: NormalizePriceOptions,
): ProviderModelRegistryEntry[] {
  const models = readRecord(payload);
  const entries: ProviderModelRegistryEntry[] = [];

  for (const [rawModelId, modelPayload] of Object.entries(models)) {
    if (rawModelId === "sample_spec") {
      continue;
    }

    const model = readRecord(modelPayload);
    const sourceProviderKey = readString(model.litellm_provider) ?? readString(model.provider);
    const providerKey = normalizeProviderKey(sourceProviderKey);
    if (!providerKey) {
      continue;
    }
    const modelId = normalizeLiteLlmModelId(rawModelId, {
      providerKey,
      sourceProviderKey: sourceProviderKey ?? providerKey,
    });
    if (!modelId) {
      continue;
    }

    const contextWindow =
      readPositiveInteger(model.max_input_tokens) ?? readPositiveInteger(model.max_tokens);
    const outputTokenLimit =
      readPositiveInteger(model.max_output_tokens) ?? readPositiveInteger(model.max_tokens);
    const supportsTools =
      readOptionalBoolean(model.supports_function_calling) === true ||
      readOptionalBoolean(model.supports_parallel_function_calling) === true ||
      readOptionalBoolean(model.supports_tool_choice) === true;
    const reasoningLevels = readLiteLlmReasoningLevels(model);
    const reasoningSupport =
      readOptionalBoolean(model.supports_reasoning) === true ||
      readNonNegativeNumber(model.output_cost_per_reasoning_token) !== null ||
      reasoningLevels.length > 0;
    const streaming = inferStreamingSupport({
      explicit: readOptionalBoolean(model.supports_native_streaming),
      model,
      modelId,
    });

    entries.push({
      contextWindow,
      modelId,
      outputTokenLimit,
      providerKey,
      reasoningLevels,
      reasoningSupport,
      registrySources: registrySources({
        contextWindow,
        outputTokenLimit,
        reasoningSupport,
        source: "litellm",
        supportsStreaming: streaming.value,
        supportsTools,
      }),
      streamingInferred: streaming.inferred,
      supportsStreaming: streaming.value,
      supportsTools,
      syncedAt: options.syncedAt,
    });
  }

  return dedupeProviderModelRegistryEntries(entries);
}

export function normalizeVercelAiGatewayProviderModelRegistryEntries(
  payload: unknown,
  options: NormalizePriceOptions,
): ProviderModelRegistryEntry[] {
  const entries: ProviderModelRegistryEntry[] = [];
  const data = readRecord(payload).data;
  const models = Array.isArray(data) ? data : [];

  for (const rawModel of models) {
    const model = readRecord(rawModel);
    const rawModelId = readString(model.id);
    if (!rawModelId) {
      continue;
    }
    const sourceProviderKey = readString(model.owned_by) ?? rawModelId.split("/")[0] ?? "";
    const providerKey = normalizeProviderKey(sourceProviderKey);
    if (!providerKey) {
      continue;
    }
    const modelId = stripProviderModelPrefix(rawModelId, {
      providerKey,
      sourceProviderKey,
    });
    const tags = readStringArray(model.tags);
    const contextWindow = readPositiveInteger(model.context_window);
    const outputTokenLimit = readPositiveInteger(model.max_tokens);
    const supportsTools = tags.includes("tool-use");
    const reasoningSupport = tags.includes("reasoning");
    const streaming = inferStreamingSupport({
      explicit: null,
      model,
      modelId,
    });

    entries.push({
      contextWindow,
      modelId,
      outputTokenLimit,
      providerKey,
      reasoningSupport,
      registrySources: registrySources({
        contextWindow,
        outputTokenLimit,
        reasoningSupport,
        source: "vercel-ai-gateway",
        supportsStreaming: streaming.value,
        supportsTools,
      }),
      streamingInferred: streaming.inferred,
      supportsStreaming: streaming.value,
      supportsTools,
      syncedAt: options.syncedAt,
    });
  }

  return dedupeProviderModelRegistryEntries(entries);
}

export function mergeProviderModelRegistryEntries(
  ...sources: ProviderModelRegistryEntry[][]
): ProviderModelRegistryEntry[] {
  const merged = new Map<string, ProviderModelRegistryEntry>();

  for (const entries of sources) {
    for (const entry of entries) {
      const key = registryKey(entry.providerKey, entry.modelId);
      const current = merged.get(key);
      if (!current) {
        merged.set(key, { ...entry, registrySources: { ...(entry.registrySources ?? {}) } });
        continue;
      }
      mergeMissingRegistryFields(current, entry);
    }
  }

  return [...merged.values()].sort((left, right) =>
    registryKey(left.providerKey, left.modelId).localeCompare(
      registryKey(right.providerKey, right.modelId),
    ),
  );
}

export function findProviderModelRegistryEntry(
  entries: ProviderModelRegistryEntry[],
  input: {
    displayName?: string | null;
    modelId: string;
    providerKey: string;
  },
): ProviderModelRegistryEntry | null {
  const providerKey =
    normalizeProviderKey(input.providerKey) ?? input.providerKey.trim().toLowerCase();
  const byKey = new Map(
    entries.map((entry) => [registryKey(entry.providerKey, entry.modelId), entry]),
  );
  const candidates = [input.modelId, input.displayName ?? ""]
    .map((value) =>
      stripProviderModelPrefix(value, {
        providerKey,
        sourceProviderKey: providerKey,
      }),
    )
    .filter(Boolean);

  for (const candidate of candidates) {
    const entry = byKey.get(registryKey(providerKey, candidate));
    if (entry) {
      return entry;
    }
  }

  return null;
}

export function normalizeModelsDevProviderModelPrices(
  payload: unknown,
  options: NormalizePriceOptions,
): ProviderModelSyncedPrice[] {
  const providers = readRecord(payload);
  const prices: ProviderModelSyncedPrice[] = [];

  for (const [sourceProviderKey, providerPayload] of Object.entries(providers)) {
    const providerKey = normalizeProviderKey(sourceProviderKey);
    if (!providerKey) {
      continue;
    }

    for (const model of readModelCollection(readRecord(providerPayload).models)) {
      const rawModelId = readString(model.id);
      const modelId = rawModelId
        ? stripProviderModelPrefix(rawModelId, { providerKey, sourceProviderKey })
        : null;
      const cost = readRecord(model.cost);
      const inputUsdPerMillionTokens = readNonNegativeNumber(cost.input);
      const outputUsdPerMillionTokens = readNonNegativeNumber(cost.output);

      if (!modelId || inputUsdPerMillionTokens === null || outputUsdPerMillionTokens === null) {
        continue;
      }

      prices.push({
        cachedInputUsdPerMillionTokens: readNonNegativeNumber(cost.cache_read),
        inputUsdPerMillionTokens,
        metadata: { sourceProviderKey },
        modelId,
        outputUsdPerMillionTokens,
        priceVersion: `models.dev:${options.syncedAt.toISOString()}`,
        providerKey,
        source: "models.dev",
        sourceUrl: options.sourceUrl,
        syncedAt: options.syncedAt,
      });
    }
  }

  return dedupeProviderModelPrices(prices);
}

export function normalizeLiteLlmProviderModelPrices(
  payload: unknown,
  options: NormalizePriceOptions,
): ProviderModelSyncedPrice[] {
  const models = readRecord(payload);
  const prices: ProviderModelSyncedPrice[] = [];

  for (const [rawModelId, modelPayload] of Object.entries(models)) {
    if (rawModelId === "sample_spec") {
      continue;
    }

    const model = readRecord(modelPayload);
    const sourceProviderKey = readString(model.litellm_provider) ?? readString(model.provider);
    const providerKey = normalizeProviderKey(sourceProviderKey);
    const inputCostPerToken = readNonNegativeNumber(model.input_cost_per_token);
    const outputCostPerToken = readNonNegativeNumber(model.output_cost_per_token);

    if (!providerKey || inputCostPerToken === null || outputCostPerToken === null) {
      continue;
    }

    const modelId = normalizeLiteLlmModelId(rawModelId, {
      providerKey,
      sourceProviderKey: sourceProviderKey ?? providerKey,
    });
    if (!modelId) {
      continue;
    }

    prices.push({
      cachedInputUsdPerMillionTokens: perTokenToPerMillion(
        readNonNegativeNumber(model.cache_read_input_token_cost),
      ),
      inputUsdPerMillionTokens: requiredPerTokenToPerMillion(inputCostPerToken),
      metadata: { sourceProviderKey },
      modelId,
      outputUsdPerMillionTokens: requiredPerTokenToPerMillion(outputCostPerToken),
      priceVersion: `litellm:${options.syncedAt.toISOString()}`,
      providerKey,
      source: "litellm",
      sourceUrl: options.sourceUrl,
      syncedAt: options.syncedAt,
    });
  }

  return dedupeProviderModelPrices(prices);
}

export function mergeProviderModelPrices(
  primaryPrices: ProviderModelSyncedPrice[],
  auxiliaryPrices: ProviderModelSyncedPrice[],
): ProviderModelSyncedPrice[] {
  const merged = new Map<string, ProviderModelSyncedPrice>();

  for (const price of primaryPrices) {
    merged.set(priceKey(price), price);
  }
  for (const price of auxiliaryPrices) {
    const key = priceKey(price);
    if (!merged.has(key)) {
      merged.set(key, price);
    }
  }

  return [...merged.values()].sort((left, right) =>
    `${left.providerKey}:${left.modelId}:${left.source}`.localeCompare(
      `${right.providerKey}:${right.modelId}:${right.source}`,
    ),
  );
}

function mergeMissingRegistryFields(
  target: ProviderModelRegistryEntry,
  source: ProviderModelRegistryEntry,
): void {
  if (
    (target.contextWindow === undefined || target.contextWindow === null) &&
    source.contextWindow !== undefined
  ) {
    target.contextWindow = source.contextWindow;
  }
  if (
    (target.outputTokenLimit === undefined || target.outputTokenLimit === null) &&
    source.outputTokenLimit !== undefined
  ) {
    target.outputTokenLimit = source.outputTokenLimit;
  }
  if (
    (target.supportsTools === undefined || target.supportsTools === null) &&
    source.supportsTools !== undefined
  ) {
    target.supportsTools = source.supportsTools;
  }
  if (
    (target.supportsStreaming === undefined ||
      target.supportsStreaming === null ||
      (target.streamingInferred === true && source.streamingInferred === false)) &&
    source.supportsStreaming !== undefined
  ) {
    target.supportsStreaming = source.supportsStreaming;
    target.streamingInferred = source.streamingInferred;
    if (source.registrySources?.supportsStreaming) {
      target.registrySources = {
        ...(target.registrySources ?? {}),
        supportsStreaming: source.registrySources.supportsStreaming,
      };
    }
  }
  if (
    (target.reasoningSupport === undefined || target.reasoningSupport === null) &&
    source.reasoningSupport !== undefined
  ) {
    target.reasoningSupport = source.reasoningSupport;
  }

  if (!target.reasoningDefaultLevel && source.reasoningDefaultLevel) {
    target.reasoningDefaultLevel = source.reasoningDefaultLevel;
  }
  if ((target.reasoningLevels?.length ?? 0) === 0 && source.reasoningLevels?.length) {
    target.reasoningLevels = source.reasoningLevels;
  }
  if (target.streamingInferred === undefined && source.streamingInferred !== undefined) {
    target.streamingInferred = source.streamingInferred;
  }
  target.registrySources = {
    ...(source.registrySources ?? {}),
    ...(target.registrySources ?? {}),
    ...(target.registrySources?.supportsStreaming
      ? { supportsStreaming: target.registrySources.supportsStreaming }
      : {}),
  };
}

function registrySources(input: {
  contextWindow: number | null;
  outputTokenLimit: number | null;
  reasoningSupport: boolean | null;
  source: ProviderModelRegistrySource;
  supportsStreaming: boolean | null;
  supportsTools: boolean | null;
}): Partial<Record<ProviderModelRegistryField, ProviderModelRegistrySource>> {
  return {
    ...(input.contextWindow === null ? {} : { contextWindow: input.source }),
    ...(input.outputTokenLimit === null ? {} : { outputTokenLimit: input.source }),
    ...(input.reasoningSupport === null ? {} : { reasoning: input.source }),
    ...(input.supportsStreaming === null ? {} : { supportsStreaming: input.source }),
    ...(input.supportsTools === null ? {} : { supportsTools: input.source }),
  };
}

function dedupeProviderModelPrices(prices: ProviderModelSyncedPrice[]): ProviderModelSyncedPrice[] {
  const deduped = new Map<string, ProviderModelSyncedPrice>();

  for (const price of prices) {
    deduped.set(`${priceKey(price)}:${price.source}`, price);
  }

  return [...deduped.values()];
}

function dedupeProviderModelRegistryEntries(
  entries: ProviderModelRegistryEntry[],
): ProviderModelRegistryEntry[] {
  const deduped = new Map<string, ProviderModelRegistryEntry>();

  for (const entry of entries) {
    deduped.set(registryKey(entry.providerKey, entry.modelId), entry);
  }

  return [...deduped.values()];
}

async function fetchJson(fetchImpl: typeof globalThis.fetch, url: string): Promise<unknown> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Price source ${url} returned HTTP ${response.status}.`);
  }
  return response.json();
}

function normalizeProviderKey(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return null;
  }

  const aliased = providerKeyAliases.get(normalized) ?? normalized;
  return supportedProviderKeys.has(aliased) ? aliased : null;
}

function normalizeLiteLlmModelId(
  rawModelId: string,
  input: {
    providerKey: string;
    sourceProviderKey: string;
  },
): string | null {
  let modelId = rawModelId.trim();
  if (!modelId) {
    return null;
  }

  const prefixes = [
    input.sourceProviderKey,
    input.providerKey,
    "google",
    "moonshotai",
    "openrouter",
    "x-ai",
    "z-ai",
  ]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  for (const prefix of prefixes) {
    const prefixWithSlash = `${prefix}/`;
    if (modelId.toLowerCase().startsWith(prefixWithSlash)) {
      modelId = modelId.slice(prefixWithSlash.length);
      break;
    }
  }

  return modelId || null;
}

function stripProviderModelPrefix(
  rawModelId: string,
  input: {
    providerKey: string;
    sourceProviderKey: string;
  },
): string {
  return (
    normalizeLiteLlmModelId(rawModelId, {
      providerKey: input.providerKey,
      sourceProviderKey: input.sourceProviderKey,
    }) ?? rawModelId.trim()
  );
}

function registryKey(providerKey: string, modelId: string): string {
  return `${providerKey.trim().toLowerCase()}:${modelId.trim().toLowerCase()}`;
}

function readModelCollection(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.map(readRecord);
  }
  return Object.values(readRecord(value)).map(readRecord);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized || null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(readString).filter((entry): entry is string => entry !== null);
}

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function readOptionalBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function readReasoningLevels(value: unknown): string[] {
  const direct = readStringArray(value);
  if (direct.length > 0) {
    return direct;
  }

  const record = readRecord(value);
  return [
    ...readStringArray(record.effort),
    ...readStringArray(record.efforts),
    ...readStringArray(record.supported_efforts),
  ];
}

function readLiteLlmReasoningLevels(model: Record<string, unknown>): string[] {
  const levels = ["minimal", "low", "medium", "high", "xhigh", "max", "none"];
  return levels.filter((level) => readOptionalBoolean(model[`supports_${level}_reasoning_effort`]));
}

function inferStreamingSupport(input: {
  explicit: boolean | null;
  model: Record<string, unknown>;
  modelId: string;
}): {
  inferred: boolean;
  value: boolean | null;
} {
  if (input.explicit !== null) {
    return { inferred: false, value: input.explicit };
  }

  const text = [
    input.modelId,
    readString(input.model.mode),
    readString(input.model.type),
    ...readStringArray(readRecord(input.model.modalities).output),
    ...readStringArray(readRecord(input.model.architecture).output_modalities),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (!text) {
    return { inferred: false, value: null };
  }

  if (/(embedding|image|tts|speech|whisper|audio|moderation|rerank|search)/.test(text)) {
    return { inferred: true, value: false };
  }

  if (/(chat|completion|language|text)/.test(text)) {
    return { inferred: true, value: true };
  }

  return { inferred: false, value: null };
}

function perTokenToPerMillion(value: number | null): number | null {
  if (value === null) {
    return null;
  }
  return requiredPerTokenToPerMillion(value);
}

function requiredPerTokenToPerMillion(value: number): number {
  return Math.round(value * 1_000_000 * 100_000_000) / 100_000_000;
}

function priceKey(price: Pick<ProviderModelSyncedPrice, "modelId" | "providerKey">): string {
  return `${price.providerKey}:${price.modelId}`;
}
