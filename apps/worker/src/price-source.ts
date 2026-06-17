export const MODELS_DEV_PRICE_SOURCE_URL = "https://models.dev/api.json";
export const LITELLM_PRICE_SOURCE_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export type ProviderModelPriceSource = "litellm" | "models.dev";

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

type NormalizePriceOptions = {
  sourceUrl: string;
  syncedAt: Date;
};

type FetchProviderModelPricesOptions = {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};

const supportedProviderKeys = new Set([
  "anthropic",
  "deepseek",
  "fireworks",
  "gemini",
  "groq",
  "llama_cpp",
  "lmstudio",
  "minimax",
  "mistral",
  "moonshot",
  "ollama",
  "openai",
  "openrouter",
  "qwen",
  "xai",
  "zai",
]);

const providerKeyAliases = new Map<string, string>([
  ["alibaba", "qwen"],
  ["dashscope", "qwen"],
  ["fireworks-ai", "fireworks"],
  ["fireworks_ai", "fireworks"],
  ["google", "gemini"],
  ["google-ai-studio", "gemini"],
  ["google_ai_studio", "gemini"],
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
      const modelId = readString(model.id);
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

function dedupeProviderModelPrices(prices: ProviderModelSyncedPrice[]): ProviderModelSyncedPrice[] {
  const deduped = new Map<string, ProviderModelSyncedPrice>();

  for (const price of prices) {
    deduped.set(`${priceKey(price)}:${price.source}`, price);
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
    "fireworks-ai",
    "fireworks_ai",
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

function readNonNegativeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
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
