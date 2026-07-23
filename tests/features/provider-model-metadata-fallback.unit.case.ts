import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ListedProviderModel } from "../../packages/provider/src/model-list.ts";
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
import { enrichListedProviderModels } from "../../packages/worker-runtime/src/worker-model-refresh.ts";

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
      // Carries cost, so its exclusion from prices proves the gate is closed on
      // merit (a section with real price data), not merely absent cost.
      "glm-cn": { cost: { input: 5, output: 6 }, id: "glm-cn", limit: { context: 128000 } },
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
    // Batch 4 opened cline_pass into the price-sync allowlist, so this guard now
    // samples zhipuai — a section that carries cost in the fixture but is NOT on
    // the allowlist — to prove the price path still drops non-allowlist sections
    // (the registry catalog keeps zhipuai; the price gate does not).
    expect(priceKeys.has("zhipuai")).toBe(false);
  });

  it("resolves metadata across catalogs in provider / tier-1 / tier-2 order", () => {
    const entries: ProviderModelRegistryEntry[] = [
      entry("qwen", "qwen3-max", 1),
      entry("deepseek", "foreign-a", 2),
      entry("deepseek", "conflict-1", 3),
      entry("openai", "conflict-1", 4),
      // novita/zhipuai are the tier-2 (non-allowlist) catalogs here; cline_pass
      // used to play this role but Batch 4 moved it onto the tier-1 allowlist.
      entry("novita", "foreign-b", 5),
      entry("novita", "conflict-2", 6),
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
      // Raw id `vendorx/foreign-b` is claimed by two untrusted (tier-2) catalogs
      // (novita/zhipuai — cline_pass is now a tier-1 allowlist catalog).
      entry("novita", "vendorx/foreign-b", 10),
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

const listed = (modelId: string, overrides: Partial<ListedProviderModel> = {}) => ({
  displayName: modelId,
  modelId,
  ...overrides,
});

describe("prefix-vendor resolution and price allowlist expansion", () => {
  beforeEach(() => {
    resetProviderModelCatalogCacheForTests();
  });

  afterEach(() => {
    resetProviderModelCatalogCacheForTests();
  });

  it("resolves a vendor-prefixed id directly from the prefix's catalog, beating a trusted-layer conflict", () => {
    const entries: ProviderModelRegistryEntry[] = [
      // The same vendor-prefixed id is listed by two host catalogs that Batch 4
      // put on the price-sync allowlist (both tier-1): nvidia and openrouter.
      // The tiered sweep can only treat that as an unresolvable trusted-layer
      // conflict.
      entry("nvidia", "z-ai/glm-5.2", 100),
      entry("openrouter", "z-ai/glm-5.2", 200),
      // The prefix z-ai names the zai catalog, which lists the stripped id.
      entry("zai", "glm-5.2", 300),
    ];

    // Without the prefix-vendor step this returns null (the tier-1 conflict); the
    // step reads the prefix as the vendor's own catalog signature and resolves
    // straight from zai.
    expect(
      resolveProviderModelMetadataEntry(entries, {
        modelId: "z-ai/glm-5.2",
        providerKey: "nous",
      })?.maxContextTokens,
    ).toBe(300);
  });

  it("resolves HF-style org-prefixed ids through the new metadata aliases, past a stripped-form conflict", () => {
    const entries: ProviderModelRegistryEntry[] = [
      // Bare ids are ambiguous across two trusted catalogs, so the stripped-form
      // cross-catalog sweep conflicts; only the aliased prefix disambiguates.
      entry("nvidia", "glm-5.2", 1),
      entry("openrouter", "glm-5.2", 2),
      entry("zai", "glm-5.2", 42),
      entry("nvidia", "minimax-m2", 3),
      entry("groq", "minimax-m2", 4),
      entry("minimax", "minimax-m2", 55),
    ];

    // zai-org -> zai via the new alias, and case-insensitive (GLM-5.2).
    expect(
      resolveProviderModelMetadataEntry(entries, {
        modelId: "zai-org/GLM-5.2",
        providerKey: "nous",
      })?.maxContextTokens,
    ).toBe(42);
    // minimaxai -> minimax via the new alias.
    expect(
      resolveProviderModelMetadataEntry(entries, {
        modelId: "minimaxai/minimax-m2",
        providerKey: "nous",
      })?.maxContextTokens,
    ).toBe(55);
  });

  it("matches the vendor prefix case-insensitively, including an uppercased prefix", () => {
    const entries: ProviderModelRegistryEntry[] = [
      // Stripped id `glm-5.2` is a tier-1 conflict, so only the prefix can
      // disambiguate to zai — which pins that the prefix itself, not just the
      // stripped suffix, is matched case-insensitively.
      entry("nvidia", "glm-5.2", 1),
      entry("openrouter", "glm-5.2", 2),
      entry("zai", "glm-5.2", 42),
    ];

    // Uppercased alias prefix (Z-AI -> zai) resolves via resolveRegistryCatalogKey's
    // leading trim().toLowerCase(); the suffix here stays lowercase to isolate the
    // prefix casing.
    expect(
      resolveProviderModelMetadataEntry(entries, {
        modelId: "Z-AI/glm-5.2",
        providerKey: "nous",
      })?.maxContextTokens,
    ).toBe(42);
    // Fully uppercased prefix and suffix (ZAI-ORG/GLM-5.2) resolve too.
    expect(
      resolveProviderModelMetadataEntry(entries, {
        modelId: "ZAI-ORG/GLM-5.2",
        providerKey: "nous",
      })?.maxContextTokens,
    ).toBe(42);
  });

  it("leaves bare-id resolution and the trusted-layer hard stop unchanged", () => {
    const entries: ProviderModelRegistryEntry[] = [
      entry("deepseek", "solo-model", 7),
      entry("nvidia", "clash", 1),
      entry("groq", "clash", 2),
    ];

    // Bare id with a unique tier-1 hit still resolves (no slash -> the
    // prefix-vendor step never fires).
    expect(
      resolveProviderModelMetadataEntry(entries, { modelId: "solo-model", providerKey: "nous" })
        ?.maxContextTokens,
    ).toBe(7);
    // Bare id claimed by two tier-1 catalogs still hard-stops at null rather than
    // guessing — the expansion adds no new bare-id conflict resolution.
    expect(
      resolveProviderModelMetadataEntry(entries, { modelId: "clash", providerKey: "nous" }),
    ).toBeNull();
  });

  it("stamps cross-catalog provenance when the prefix-vendor step resolves from a foreign catalog", () => {
    const registry: ProviderModelRegistryEntry[] = [
      entry("nvidia", "z-ai/glm-5.2", 100),
      entry("openrouter", "z-ai/glm-5.2", 200),
      {
        maxContextTokens: 300,
        modelId: "glm-5.2",
        providerKey: "zai",
        registrySources: { maxContextTokens: "models.dev" },
        syncedAt,
      },
    ];

    const enriched = enrichListedProviderModels({
      listedModels: [listed("z-ai/glm-5.2")],
      providerKey: "nous",
      registryEntries: registry,
    });

    // The prefix-vendor hit comes from a foreign catalog (zai), so the existing
    // worker-side provenance comparison stamps it — no new provenance code.
    expect(enriched[0]?.capabilityMetadata).toMatchObject({
      resolvedFromCatalog: "zai",
      resolvedVia: "cross-catalog",
    });
    expect(enriched[0]?.contextWindow).toBe(300);
  });

  it("expands the price allowlist: fireworks-ai/cline-pass/groq map in, ollama-cloud stays out", async () => {
    const priceFixture = {
      "cline-pass": { models: { "cline-x": { cost: { input: 3, output: 4 }, id: "cline-x" } } },
      "fireworks-ai": {
        models: { "llama-v3": { cost: { input: 1, output: 2 }, id: "llama-v3" } },
      },
      groq: { models: { "llama-70b": { cost: { input: 5, output: 6 }, id: "llama-70b" } } },
      // Deliberately off the allowlist even though it carries cost.
      "ollama-cloud": { models: { "gpt-oss": { cost: { input: 7, output: 8 }, id: "gpt-oss" } } },
    };
    const fetchImpl = (async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url.toString();
      if (href === MODELS_DEV_PRICE_SOURCE_URL) {
        return jsonResponse(priceFixture);
      }
      return jsonResponse({});
    }) as typeof globalThis.fetch;

    const prices = await fetchProviderModelPrices({ fetch: fetchImpl });
    const byKey = new Set(prices.map((price) => price.providerKey));

    // fireworks-ai and cline-pass normalize via the new price-path aliases; groq
    // is now allowlisted directly.
    expect(byKey.has("fireworks")).toBe(true);
    expect(byKey.has("groq")).toBe(true);
    expect(byKey.has("cline_pass")).toBe(true);
    // ollama_cloud is intentionally excluded from price sync — the section drops.
    expect(byKey.has("ollama_cloud")).toBe(false);
    expect(byKey.has("ollama-cloud")).toBe(false);
  });
});
