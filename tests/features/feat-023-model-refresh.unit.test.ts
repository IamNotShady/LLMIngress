import {
  enrichListedProviderModels,
  filterRefreshableListedProviderModels,
  planProviderModelRefresh,
} from "@llmingress/db/worker-model-refresh";
import { describe, expect, it } from "vitest";
import {
  buildProviderModelListRequest,
  fetchListedProviderModels,
  parseProviderModelList,
} from "../../packages/provider/src/model-list";

describe("feat-023 provider model refresh job", () => {
  it("plans derived model inserts and only treats referenced availability changes as routing-visible", () => {
    const plan = planProviderModelRefresh({
      existingModels: [
        {
          availability: "available",
          displayName: "Stable",
          id: "model-existing-stable",
          modelId: "stable",
          referenced: true,
        },
        {
          availability: "available",
          displayName: "Old Referenced",
          id: "model-old-referenced",
          modelId: "old-referenced",
          referenced: true,
        },
        {
          availability: "available",
          displayName: "Old Unreferenced",
          id: "model-old-unreferenced",
          modelId: "old-unreferenced",
          referenced: false,
        },
        {
          availability: "unavailable",
          displayName: "Returned Referenced",
          id: "model-returned-referenced",
          modelId: "returned-referenced",
          referenced: true,
        },
      ],
      listedModels: [
        { displayName: "Stable", modelId: "stable" },
        { displayName: "New Model", modelId: "new-model" },
        { displayName: "Returned Referenced", modelId: "returned-referenced" },
      ],
    });

    expect(plan.insertModels).toEqual([{ displayName: "New Model", modelId: "new-model" }]);
    expect(plan.markAvailable).toEqual([
      {
        displayName: "Returned Referenced",
        id: "model-returned-referenced",
        modelId: "returned-referenced",
        referenced: true,
      },
    ]);
    expect(plan.markUnavailable).toEqual([
      {
        id: "model-old-referenced",
        modelId: "old-referenced",
        referenced: true,
      },
    ]);
    expect(plan.markNotListed).toEqual([
      {
        id: "model-old-unreferenced",
        modelId: "old-unreferenced",
        referenced: false,
      },
    ]);
    expect(plan.routingVisibleChanges).toEqual([
      { recordId: "model-old-referenced", table: "provider_models" },
      { recordId: "model-returned-referenced", table: "provider_models" },
    ]);
  });

  it("plans no routing-visible changes when the listed model set is unchanged", () => {
    const plan = planProviderModelRefresh({
      existingModels: [
        {
          availability: "available",
          displayName: "Stable",
          id: "model-stable",
          modelId: "stable",
          referenced: true,
        },
      ],
      listedModels: [{ displayName: "Stable", modelId: "stable" }],
    });

    expect(plan).toMatchObject({
      insertModels: [],
      markAvailable: [],
      markNotListed: [],
      markUnavailable: [],
      routingVisibleChanges: [],
    });
  });

  it("deduplicates repeated provider model ids before planning inserts", () => {
    const plan = planProviderModelRefresh({
      existingModels: [],
      listedModels: [
        { displayName: "New Model", modelId: "new-model" },
        { displayName: "New Model Duplicate", modelId: "new-model" },
      ],
    });

    expect(plan.insertModels).toEqual([{ displayName: "New Model", modelId: "new-model" }]);
  });

  it("filters models with no context or token prices before planning refresh writes", () => {
    const syncedAt = new Date("2026-06-21T00:00:00.000Z");

    expect(
      filterRefreshableListedProviderModels({
        listedModels: [
          { displayName: "No Metadata", modelId: "no-metadata" },
          { contextWindow: 128_000, displayName: "Has Context", modelId: "has-context" },
          { displayName: "Has Price", modelId: "has-price" },
        ],
        providerKey: "OpenAI",
        syncedPrices: [
          {
            cachedInputUsdPerMillionTokens: null,
            inputUsdPerMillionTokens: 0.4,
            modelId: "has-price",
            outputUsdPerMillionTokens: 1.6,
            priceVersion: "models.dev:test",
            providerKey: "openai",
            source: "models.dev",
            sourceUrl: "https://models.dev/api.json",
            syncedAt,
          },
        ],
      }),
    ).toEqual([
      { contextWindow: 128_000, displayName: "Has Context", modelId: "has-context" },
      { displayName: "Has Price", modelId: "has-price" },
    ]);
  });

  it("keeps Claude Code models when Anthropic metadata supplies context", () => {
    const syncedAt = new Date("2026-06-21T00:00:00.000Z");
    const enriched = enrichListedProviderModels({
      listedModels: [
        {
          displayName: "Claude Sonnet 4",
          modelId: "claude-sonnet-4-20250514",
        },
      ],
      providerKey: "claude_code",
      registryEntries: [
        {
          contextWindow: 200_000,
          modelId: "claude-sonnet-4-20250514",
          providerKey: "anthropic",
          supportsStreaming: true,
          supportsTools: true,
          syncedAt,
        },
      ],
    });

    expect(
      filterRefreshableListedProviderModels({
        listedModels: enriched,
        providerKey: "claude_code",
        syncedPrices: [],
      }),
    ).toEqual([
      {
        capabilityMetadata: {
          registrySyncedAt: "2026-06-21T00:00:00.000Z",
          tools: true,
        },
        contextWindow: 200_000,
        displayName: "Claude Sonnet 4",
        modelId: "claude-sonnet-4-20250514",
        supportsStreaming: true,
        supportsTools: true,
      },
    ]);
  });

  it("keeps local models without registry metadata or token prices", () => {
    const enriched = enrichListedProviderModels({
      listedModels: [{ displayName: "llama3.2:3b", modelId: "llama3.2:3b" }],
      providerKey: "ollama",
      registryEntries: [],
    });

    expect(
      filterRefreshableListedProviderModels({
        listedModels: enriched,
        providerKey: "ollama",
        syncedPrices: [],
      }),
    ).toEqual([
      {
        contextWindow: 4096,
        displayName: "llama3.2:3b",
        modelId: "llama3.2:3b",
      },
    ]);
  });

  it("reads LM Studio model capabilities from its local API response", () => {
    expect(
      buildProviderModelListRequest({
        baseUrl: "http://127.0.0.1:1234/v1",
        providerKey: "lmstudio",
      }),
    ).toEqual({
      init: { method: "GET" },
      url: "http://127.0.0.1:1234/api/v0/models",
    });

    expect(
      parseProviderModelList({
        data: [
          {
            capabilities: ["tool_use"],
            id: "qwen/qwen3-1.7b",
            max_context_length: 40960,
            object: "model",
          },
        ],
        object: "list",
      }),
    ).toEqual([
      {
        contextWindow: 40960,
        displayName: "qwen/qwen3-1.7b",
        modelId: "qwen/qwen3-1.7b",
        supportsTools: true,
      },
    ]);
  });

  it("reads llama.cpp capabilities from models and context from data metadata", () => {
    expect(
      parseProviderModelList({
        data: [
          {
            id: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
            meta: { n_ctx: 8192 },
            object: "model",
          },
        ],
        models: [
          {
            capabilities: ["completion", "tools"],
            name: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
          },
        ],
        object: "list",
      }),
    ).toEqual([
      {
        contextWindow: 8192,
        displayName: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
        modelId: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
        supportsTools: true,
      },
    ]);
  });

  it("adds llama.cpp tool support from props when models only list completion", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      calls.push(String(url));
      if (String(url).endsWith("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
                meta: { n_ctx: 8192 },
                object: "model",
              },
            ],
            models: [
              {
                capabilities: ["completion"],
                name: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
              },
            ],
            object: "list",
          }),
        );
      }
      return new Response(
        JSON.stringify({
          chat_template_caps: { supports_tools: true },
          default_generation_settings: { params: { n_ctx: 8192 } },
        }),
      );
    }) as typeof globalThis.fetch;

    await expect(
      fetchListedProviderModels({
        baseUrl: "http://127.0.0.1:8080/v1",
        fetch: fetchImpl,
        providerKey: "llama_cpp",
      }),
    ).resolves.toEqual([
      {
        contextWindow: 8192,
        displayName: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
        modelId: "Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF:Q4_K_M",
        supportsTools: true,
      },
    ]);
    expect(calls).toEqual(["http://127.0.0.1:8080/v1/models", "http://127.0.0.1:8080/props"]);
  });

  it("builds an authenticated provider model list request", () => {
    expect(
      buildProviderModelListRequest({
        apiKey: "sk-refresh-secret",
        baseUrl: "https://api.openai.com/v1",
        providerKey: "openai",
      }),
    ).toEqual({
      init: {
        headers: {
          authorization: "Bearer sk-refresh-secret",
        },
        method: "GET",
      },
      url: "https://api.openai.com/v1/models",
    });
  });

  it("builds an Anthropic provider model list request with Anthropic API key headers", () => {
    expect(
      buildProviderModelListRequest({
        apiKey: "sk-ant-refresh-secret",
        baseUrl: "https://api.anthropic.com/v1",
        providerKey: "anthropic",
      }),
    ).toEqual({
      init: {
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": "sk-ant-refresh-secret",
        },
        method: "GET",
      },
      url: "https://api.anthropic.com/v1/models",
    });
  });

  it("does not publish a routing-visible change for a referenced model display name-only change", () => {
    const plan = planProviderModelRefresh({
      existingModels: [
        {
          availability: "available",
          displayName: "Old Display Name",
          id: "model-stable",
          modelId: "stable",
          referenced: true,
        },
      ],
      listedModels: [{ displayName: "New Display Name", modelId: "stable" }],
    });

    expect(plan.markAvailable).toEqual([
      {
        displayName: "New Display Name",
        id: "model-stable",
        modelId: "stable",
        referenced: true,
      },
    ]);
    expect(plan.routingVisibleChanges).toEqual([]);
  });
});
