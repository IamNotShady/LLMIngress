import {
  type ModelCapabilityField,
  type ModelInputModality,
  type ModelOutputModality,
  normalizeModelInputModalities,
  normalizeModelOutputModalities,
  type SyncedModelCapabilities,
} from "@llmingress/domain";
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
  | ModelCapabilityField
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
  inputModalities?: ModelInputModality[] | null;
  maxContextTokens?: number | null;
  maxOutputTokens?: number | null;
  modelId: string;
  outputModalities?: ModelOutputModality[] | null;
  providerKey: string;
  reasoningDefaultLevel?: string | null;
  reasoningLevels?: string[];
  reasoningSupport?: boolean | null;
  registrySources?: Partial<Record<ProviderModelRegistryField, ProviderModelRegistrySource>>;
  streamingInferred?: boolean;
  supportsFunctionCalling?: boolean | null;
  supportsStreaming?: boolean | null;
  supportsReasoning?: boolean | null;
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
      const inputModalities = readInputModalities({
        attachment: model.attachment,
        modalities: readRecord(model.modalities).input,
      });
      const outputModalities = readOutputModalities(readRecord(model.modalities).output);
      const maxContextTokens = readPositiveInteger(limit.context);
      const maxOutputTokens = readPositiveInteger(limit.output);
      const supportsFunctionCalling = readOptionalBoolean(model.tool_call);
      const supportsReasoning = readOptionalBoolean(model.reasoning);
      const streaming = inferStreamingSupport({
        explicit: null,
        model,
        modelId,
      });

      entries.push({
        inputModalities,
        maxContextTokens,
        maxOutputTokens,
        modelId,
        outputModalities,
        providerKey,
        reasoningLevels: readReasoningLevels(model.reasoning_options),
        reasoningSupport: supportsReasoning,
        supportsFunctionCalling,
        supportsReasoning,
        registrySources: registrySources({
          inputModalities,
          maxContextTokens,
          maxOutputTokens,
          outputModalities,
          source: "models.dev",
          supportsFunctionCalling,
          supportsReasoning,
          supportsStreaming: streaming.value,
        }),
        streamingInferred: streaming.inferred,
        supportsStreaming: streaming.value,
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
    const architecture = readRecord(model.architecture);
    const inputModalities = readInputModalities({
      modalities: architecture.input_modalities ?? architecture.input,
    });
    const outputModalities = readOutputModalities(
      architecture.output_modalities ?? architecture.output,
    );
    const maxContextTokens =
      readPositiveInteger(model.context_length) ?? readPositiveInteger(topProvider.context_length);
    const maxOutputTokens = readPositiveInteger(topProvider.max_completion_tokens);
    const supportedParameters = readStringArray(model.supported_parameters);
    const supportsFunctionCalling =
      supportedParameters.includes("tools") || supportedParameters.includes("tool_choice");
    const reasoning = readRecord(model.reasoning);
    const reasoningLevels = readStringArray(reasoning.supported_efforts);
    const supportsReasoning =
      Object.keys(reasoning).length > 0 ||
      supportedParameters.includes("reasoning") ||
      supportedParameters.includes("include_reasoning");
    const streaming = inferStreamingSupport({
      explicit: null,
      model,
      modelId,
    });

    entries.push({
      inputModalities,
      maxContextTokens,
      maxOutputTokens,
      modelId,
      outputModalities,
      providerKey,
      reasoningDefaultLevel: readString(reasoning.default_effort),
      reasoningLevels,
      reasoningSupport: supportsReasoning,
      supportsFunctionCalling,
      supportsReasoning,
      registrySources: registrySources({
        inputModalities,
        maxContextTokens,
        maxOutputTokens,
        outputModalities,
        source: "openrouter",
        supportsFunctionCalling,
        supportsReasoning,
        supportsStreaming: streaming.value,
      }),
      streamingInferred: streaming.inferred,
      supportsStreaming: streaming.value,
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

    const inputModalities = readLiteLlmInputModalities(model);
    const outputModalities = readOutputModalities(
      model.output_modalities ?? model.supported_output_modalities,
    );
    const maxContextTokens =
      readPositiveInteger(model.max_input_tokens) ?? readPositiveInteger(model.max_tokens);
    const maxOutputTokens =
      readPositiveInteger(model.max_output_tokens) ?? readPositiveInteger(model.max_tokens);
    const supportsFunctionCalling =
      readOptionalBoolean(model.supports_function_calling) === true ||
      readOptionalBoolean(model.supports_parallel_function_calling) === true ||
      readOptionalBoolean(model.supports_tool_choice) === true;
    const reasoningLevels = readLiteLlmReasoningLevels(model);
    const supportsReasoning =
      readOptionalBoolean(model.supports_reasoning) === true ||
      readNonNegativeNumber(model.output_cost_per_reasoning_token) !== null ||
      reasoningLevels.length > 0;
    const streaming = inferStreamingSupport({
      explicit: readOptionalBoolean(model.supports_native_streaming),
      model,
      modelId,
    });

    entries.push({
      inputModalities,
      maxContextTokens,
      maxOutputTokens,
      modelId,
      outputModalities,
      providerKey,
      reasoningLevels,
      reasoningSupport: supportsReasoning,
      supportsFunctionCalling,
      supportsReasoning,
      registrySources: registrySources({
        inputModalities,
        maxContextTokens,
        maxOutputTokens,
        outputModalities,
        source: "litellm",
        supportsFunctionCalling,
        supportsReasoning,
        supportsStreaming: streaming.value,
      }),
      streamingInferred: streaming.inferred,
      supportsStreaming: streaming.value,
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
    const tags = readStringArray(model.tags).map((tag) => tag.toLowerCase());
    const modelType = readString(model.type)?.toLowerCase() ?? null;
    const inputModalities = readVercelInputModalities({ modelType, tags });
    const outputModalities = readVercelOutputModalities({ modelType, tags });
    const maxContextTokens = readPositiveInteger(model.context_window);
    const maxOutputTokens = readPositiveInteger(model.max_tokens);
    const supportsFunctionCalling = tags.includes("tool-use");
    const supportsReasoning = tags.includes("reasoning");
    const streaming = inferStreamingSupport({
      explicit: null,
      model,
      modelId,
    });

    entries.push({
      inputModalities,
      maxContextTokens,
      maxOutputTokens,
      modelId,
      outputModalities,
      providerKey,
      reasoningSupport: supportsReasoning,
      supportsFunctionCalling,
      supportsReasoning,
      registrySources: registrySources({
        inputModalities,
        maxContextTokens,
        maxOutputTokens,
        outputModalities,
        source: "vercel-ai-gateway",
        supportsFunctionCalling,
        supportsReasoning,
        supportsStreaming: streaming.value,
      }),
      streamingInferred: streaming.inferred,
      supportsStreaming: streaming.value,
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
  for (const field of [
    "inputModalities",
    "outputModalities",
    "maxContextTokens",
    "maxOutputTokens",
    "supportsFunctionCalling",
    "supportsReasoning",
  ] as const satisfies readonly ModelCapabilityField[]) {
    mergeRegistryCapabilityField(target, source, field);
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

function mergeRegistryCapabilityField(
  target: ProviderModelRegistryEntry,
  source: ProviderModelRegistryEntry,
  field: ModelCapabilityField,
): void {
  const sourceValue = source[field];
  if (sourceValue === undefined || sourceValue === null) {
    return;
  }

  const targetValue = target[field];
  if (targetValue === undefined || targetValue === null) {
    setRegistryEntryCapabilityField(target, field, sourceValue);
    if (source.registrySources?.[field]) {
      target.registrySources = {
        ...(target.registrySources ?? {}),
        [field]: source.registrySources[field],
      };
    }
  }
}

function setRegistryEntryCapabilityField(
  target: ProviderModelRegistryEntry,
  field: ModelCapabilityField,
  value: SyncedModelCapabilities[ModelCapabilityField],
): void {
  switch (field) {
    case "inputModalities":
      target.inputModalities = value as ModelInputModality[] | null;
      return;
    case "outputModalities":
      target.outputModalities = value as ModelOutputModality[] | null;
      return;
    case "maxContextTokens":
      target.maxContextTokens = value as number | null;
      return;
    case "maxOutputTokens":
      target.maxOutputTokens = value as number | null;
      return;
    case "supportsFunctionCalling":
      target.supportsFunctionCalling = value as boolean | null;
      return;
    case "supportsReasoning":
      target.supportsReasoning = value as boolean | null;
      return;
  }
}

function registrySources(input: {
  inputModalities: ModelInputModality[] | null;
  maxContextTokens: number | null;
  maxOutputTokens: number | null;
  outputModalities: ModelOutputModality[] | null;
  source: ProviderModelRegistrySource;
  supportsFunctionCalling: boolean | null;
  supportsReasoning: boolean | null;
  supportsStreaming: boolean | null;
}): Partial<Record<ProviderModelRegistryField, ProviderModelRegistrySource>> {
  return {
    ...(input.inputModalities === null ? {} : { inputModalities: input.source }),
    ...(input.maxContextTokens === null ? {} : { maxContextTokens: input.source }),
    ...(input.maxOutputTokens === null ? {} : { maxOutputTokens: input.source }),
    ...(input.outputModalities === null ? {} : { outputModalities: input.source }),
    ...(input.supportsFunctionCalling === null ? {} : { supportsFunctionCalling: input.source }),
    ...(input.supportsReasoning === null ? {} : { supportsReasoning: input.source }),
    ...(input.supportsReasoning === null ? {} : { reasoning: input.source }),
    ...(input.supportsStreaming === null ? {} : { supportsStreaming: input.source }),
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

function readInputModalities(input: {
  attachment?: unknown;
  modalities: unknown;
}): ModelInputModality[] | null {
  const values = readStringArray(input.modalities);
  if (readOptionalBoolean(input.attachment) === true) {
    values.push("attachment");
  }
  return normalizeModelInputModalities(values);
}

function readOutputModalities(value: unknown): ModelOutputModality[] | null {
  return normalizeModelOutputModalities(readStringArray(value));
}

function readLiteLlmInputModalities(model: Record<string, unknown>): ModelInputModality[] | null {
  const values = [
    ...readStringArray(model.supported_modalities),
    ...readStringArray(model.input_modalities),
  ];
  if (readOptionalBoolean(model.supports_vision) === true) {
    values.push("vision");
  }
  if (
    readOptionalBoolean(model.supports_audio_input) === true ||
    readOptionalBoolean(model.supports_audio) === true
  ) {
    values.push("audio");
  }
  if (
    readOptionalBoolean(model.supports_video_input) === true ||
    readOptionalBoolean(model.supports_video) === true
  ) {
    values.push("video");
  }
  if (
    readOptionalBoolean(model.supports_pdf_input) === true ||
    readOptionalBoolean(model.supports_pdf) === true
  ) {
    values.push("pdf");
  }
  return normalizeModelInputModalities(values);
}

function readVercelInputModalities(input: {
  modelType: string | null;
  tags: string[];
}): ModelInputModality[] | null {
  const values: string[] = [];
  if (input.modelType === "language" || input.modelType === "embedding") {
    values.push("text");
  }
  if (input.tags.includes("vision")) {
    values.push("vision");
  }
  if (input.tags.includes("file-input") || input.tags.includes("pdf")) {
    values.push("file");
  }
  if (input.tags.includes("audio")) {
    values.push("audio");
  }
  if (input.tags.includes("video")) {
    values.push("video");
  }
  return normalizeModelInputModalities(values);
}

function readVercelOutputModalities(input: {
  modelType: string | null;
  tags: string[];
}): ModelOutputModality[] | null {
  const values: string[] = [];
  if (input.modelType === "language") {
    values.push("text");
  }
  if (input.modelType === "embedding" || input.tags.includes("embeddings")) {
    values.push("embedding");
  }
  if (input.tags.includes("image-generation")) {
    values.push("image");
  }
  if (input.tags.includes("audio-generation")) {
    values.push("audio");
  }
  if (input.tags.includes("video-generation")) {
    values.push("video");
  }
  return normalizeModelOutputModalities(values);
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
