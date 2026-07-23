import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cachedFetchJson,
  fetchProviderModelPrices,
  fetchProviderModelRegistryEntries,
  MODELS_DEV_PRICE_SOURCE_URL,
  type ProviderModelRegistryEntry,
  readModelCatalogCacheTtlMs,
  resetProviderModelCatalogCacheForTests,
  resolveProviderModelMetadataEntry,
} from "../../packages/provider/src/price-source.ts";

const syncedAt = new Date("2026-07-23T00:00:00.000Z");
const cacheTtlEnvKey = "WORKER_MODEL_CATALOG_CACHE_TTL_MS";

const modelsDevFixture = {
  anthropic: {
    models: {
      "claude-x": {
        cost: { input: 1, output: 2 },
        id: "claude-x",
        limit: { context: 200000 },
      },
    },
  },
  "cline-pass": {
    models: {
      "cline-model": {
        cost: { input: 3, output: 4 },
        id: "cline-model",
        limit: { context: 100000 },
      },
    },
  },
  zhipuai: {
    models: {
      "glm-cn": { id: "glm-cn", limit: { context: 128000 } },
    },
  },
  "z-ai": {
    models: {
      "glm-global": { id: "glm-global", limit: { context: 131072 } },
    },
  },
};

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function fixtureFetch(): typeof globalThis.fetch {
  return (async (url: string | URL | Request) => {
    const href = typeof url === "string" ? url : url.toString();
    if (href === MODELS_DEV_PRICE_SOURCE_URL) {
      return jsonResponse(modelsDevFixture);
    }
    if (href.includes("litellm")) {
      return jsonResponse({});
    }
    return jsonResponse({ data: [] });
  }) as typeof globalThis.fetch;
}

function entry(
  providerKey: string,
  modelId: string,
  maxContextTokens: number,
): ProviderModelRegistryEntry {
  return { maxContextTokens, modelId, providerKey, syncedAt };
}

describe("provider model metadata fallback", () => {
  beforeEach(() => {
    resetProviderModelCatalogCacheForTests();
  });

  afterEach(() => {
    delete process.env[cacheTtlEnvKey];
    resetProviderModelCatalogCacheForTests();
  });

  it("keeps every models.dev section in the registry catalog, not just the price-sync allowlist", async () => {
    const entries = await fetchProviderModelRegistryEntries({ fetch: fixtureFetch() });
    const keys = new Set(entries.map((item) => item.providerKey));

    expect(keys.has("anthropic")).toBe(true);
    expect(keys.has("cline_pass")).toBe(true);
    expect(keys.has("zhipuai")).toBe(true);
    // Allowlisted 13-family aliases still normalize (z-ai -> zai).
    expect(keys.has("zai")).toBe(true);
    expect(keys.has("z-ai")).toBe(false);
  });

  it("keeps the price gate closed to non-allowlist sections", async () => {
    const prices = await fetchProviderModelPrices({ fetch: fixtureFetch() });
    const priceKeys = new Set(prices.map((price) => price.providerKey));

    expect(priceKeys.has("anthropic")).toBe(true);
    expect(priceKeys.has("cline_pass")).toBe(false);
    expect(priceKeys.has("cline-pass")).toBe(false);
  });

  it("resolves metadata across catalogs in provider / tier-1 / tier-2 order", () => {
    const entries: ProviderModelRegistryEntry[] = [
      entry("qwen", "qwen3-max", 1),
      entry("deepseek", "foreign-a", 2),
      entry("deepseek", "conflict-1", 3),
      entry("openai", "conflict-1", 4),
      entry("cline_pass", "foreign-b", 5),
      entry("cline_pass", "conflict-2", 6),
      entry("zhipuai", "conflict-2", 7),
    ];

    // Provider-scoped hit keeps priority.
    expect(
      resolveProviderModelMetadataEntry(entries, { modelId: "qwen3-max", providerKey: "qwen" })
        ?.maxContextTokens,
    ).toBe(1);
    // Scope miss + exactly one tier-1 hit resolves from the trusted catalog.
    expect(
      resolveProviderModelMetadataEntry(entries, { modelId: "foreign-a", providerKey: "qwen" })
        ?.maxContextTokens,
    ).toBe(2);
    // Two tier-1 catalogs disagree -> stay unresolved.
    expect(
      resolveProviderModelMetadataEntry(entries, { modelId: "conflict-1", providerKey: "qwen" }),
    ).toBeNull();
    // No tier-1 hit + exactly one tier-2 hit resolves from the untrusted catalog.
    expect(
      resolveProviderModelMetadataEntry(entries, { modelId: "foreign-b", providerKey: "qwen" })
        ?.maxContextTokens,
    ).toBe(5);
    // Two tier-2 catalogs disagree -> stay unresolved.
    expect(
      resolveProviderModelMetadataEntry(entries, { modelId: "conflict-2", providerKey: "qwen" }),
    ).toBeNull();
  });

  it("resolves cross-catalog metadata after stripping a vendor prefix", () => {
    const entries: ProviderModelRegistryEntry[] = [
      entry("qwen", "qwen3-max", 1),
      entry("deepseek", "foreign-a", 2),
    ];

    expect(
      resolveProviderModelMetadataEntry(entries, {
        modelId: "deepseek/foreign-a",
        providerKey: "qwen",
      })?.maxContextTokens,
    ).toBe(2);
  });

  it("falls through a tier-2 conflict on one lookup form to a unique tier-1 hit on the stripped form", () => {
    const entries: ProviderModelRegistryEntry[] = [
      // Raw id `vendorx/foreign-b` is claimed by two untrusted (tier-2) catalogs.
      entry("cline_pass", "vendorx/foreign-b", 10),
      entry("zhipuai", "vendorx/foreign-b", 11),
      // Stripped id `foreign-b` is unique in a trusted (tier-1) catalog.
      entry("deepseek", "foreign-b", 12),
    ];

    expect(
      resolveProviderModelMetadataEntry(entries, {
        modelId: "vendorx/foreign-b",
        providerKey: "qwen",
      })?.maxContextTokens,
    ).toBe(12);
  });

  it("resolves via the displayName candidate when the model id misses every catalog", () => {
    const entries: ProviderModelRegistryEntry[] = [entry("deepseek", "real-name", 20)];

    expect(
      resolveProviderModelMetadataEntry(entries, {
        displayName: "real-name",
        modelId: "unlisted-id",
        providerKey: "qwen",
      })?.maxContextTokens,
    ).toBe(20);
  });

  it("reads and validates the catalog cache TTL at startup, throwing on an invalid value", () => {
    delete process.env[cacheTtlEnvKey];
    expect(readModelCatalogCacheTtlMs()).toBe(1_800_000);
    process.env[cacheTtlEnvKey] = "0";
    expect(readModelCatalogCacheTtlMs()).toBe(0);
    process.env[cacheTtlEnvKey] = "nope";
    expect(() => readModelCatalogCacheTtlMs()).toThrow(
      "WORKER_MODEL_CATALOG_CACHE_TTL_MS must be a non-negative integer",
    );
  });

  it("caches catalog fetches per URL with TTL, single-flight, and stale-on-error", async () => {
    // TTL within window: two calls fetch once.
    process.env[cacheTtlEnvKey] = "1000";
    let okCalls = 0;
    const okFetch = (async () => {
      okCalls += 1;
      return jsonResponse({ payload: okCalls });
    }) as typeof globalThis.fetch;
    const first = await cachedFetchJson(okFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 0);
    const second = await cachedFetchJson(okFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 0);
    expect(okCalls).toBe(1);
    expect(second).toEqual(first);

    // TTL disabled (0): every call fetches.
    resetProviderModelCatalogCacheForTests();
    process.env[cacheTtlEnvKey] = "0";
    okCalls = 0;
    await cachedFetchJson(okFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 0);
    await cachedFetchJson(okFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 0);
    expect(okCalls).toBe(2);

    // Single-flight: concurrent calls share one fetch.
    resetProviderModelCatalogCacheForTests();
    process.env[cacheTtlEnvKey] = "1000";
    okCalls = 0;
    const [a, b] = await Promise.all([
      cachedFetchJson(okFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 0),
      cachedFetchJson(okFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 0),
    ]);
    expect(okCalls).toBe(1);
    expect(a).toEqual(b);

    // Stale-on-error: an expired refresh that fails serves the last good payload.
    resetProviderModelCatalogCacheForTests();
    process.env[cacheTtlEnvKey] = "1000";
    let mode: "ok" | "fail" = "ok";
    const flakyFetch = (async () => {
      if (mode === "fail") {
        throw new Error("boom");
      }
      return jsonResponse({ stable: true });
    }) as typeof globalThis.fetch;
    const good = await cachedFetchJson(flakyFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 0);
    mode = "fail";
    const stale = await cachedFetchJson(flakyFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 5000);
    expect(stale).toEqual(good);
  });

  it("rejects an invalid catalog cache TTL env value with the documented message", async () => {
    const anyFetch = (async () => jsonResponse({})) as typeof globalThis.fetch;
    process.env[cacheTtlEnvKey] = "not-a-number";
    await expect(
      cachedFetchJson(anyFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 0),
    ).rejects.toThrow("WORKER_MODEL_CATALOG_CACHE_TTL_MS must be a non-negative integer");

    process.env[cacheTtlEnvKey] = "-5";
    await expect(
      cachedFetchJson(anyFetch, MODELS_DEV_PRICE_SOURCE_URL, 1000, () => 0),
    ).rejects.toThrow("WORKER_MODEL_CATALOG_CACHE_TTL_MS must be a non-negative integer");
  });

  it("still bounds a cold-cache fetch with the request timeout", async () => {
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

    await expect(
      cachedFetchJson(neverResolving, MODELS_DEV_PRICE_SOURCE_URL, 20, () => 0),
    ).rejects.toThrow(/timed out/);
  });
});
