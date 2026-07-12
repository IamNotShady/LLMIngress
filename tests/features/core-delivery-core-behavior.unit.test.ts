import {
  formatAgentLimitSummaries,
  normalizeAgentLimitFormInput,
} from "@llmingress/db/console-agent-limits";
import {
  getVirtualModelDeleteDependencyError,
  normalizeVirtualModelFormInput,
} from "@llmingress/db/console-virtual-models";
import type { ListedProviderModel } from "@llmingress/provider/model-list";
import type {
  ProviderModelRegistryEntry,
  ProviderModelSyncedPrice,
} from "@llmingress/provider/price-source";
import {
  buildChainedConnectivityCheckJobPayload,
  buildChainedPriceSyncJobPayload,
  enrichListedProviderModels,
  filterRefreshableListedProviderModels,
  isUnfinishedChainedConnectivityCheckStatus,
  isUnfinishedChainedPriceSyncStatus,
  planProviderModelRefresh,
} from "@llmingress/worker-runtime/worker-model-refresh";
import { describe, expect, it } from "vitest";
import {
  buildPlaygroundChatRequest,
  buildPlaygroundMessagesRequest,
  buildPlaygroundResponsesRequest,
  formatPlaygroundFetchError,
  isValidPlaygroundGatewayBaseUrl,
  normalizePlaygroundGatewayBaseUrl,
  readPlaygroundResponseText,
  readPlaygroundStreamResponseText,
} from "../../apps/console/src/app/playground-helpers.ts";

const listed = (modelId: string, overrides: Partial<ListedProviderModel> = {}) => ({
  displayName: modelId,
  modelId,
  ...overrides,
});

describe("core delivery behavior coverage", () => {
  it("normalizes limits and returns stable summaries", () => {
    const normalized = normalizeAgentLimitFormInput({
      agentId: " agent-1 ",
      budgetPeriod: "week",
      budgetUsd: "12.5",
      concurrency: "3",
      rpm: "60",
      tokenLimit: "4096",
      tpm: "120000",
    });
    expect(normalized.agentId).toBe("agent-1");
    expect(normalized.rules.map((rule) => [rule.limitType, rule.limitValue, rule.period])).toEqual([
      ["budget", 12.5, "week"],
      ["rpm", 60, "minute"],
      ["tpm", 120000, "minute"],
      ["concurrency", 3, "request"],
      ["token", 4096, "request"],
    ]);
    expect(() => normalizeAgentLimitFormInput({ agentId: "", budgetPeriod: "year" })).toThrow();
    expect(
      formatAgentLimitSummaries([
        {
          agentId: "agent-1",
          enabled: true,
          enforcementPolicy: "block",
          id: "limit-1",
          limitType: "rpm",
          limitValue: 60,
          manualBypass: false,
          period: "minute",
          unit: "requests",
        },
      ]),
    ).toMatchObject({ rpm: "60 requests / minute" });
  });

  it("normalizes virtual models and reports each delete dependency", () => {
    expect(
      normalizeVirtualModelFormInput({ description: "  Primary route ", name: " My Model " }),
    ).toEqual({
      description: "Primary route",
      name: "my-model",
    });
    expect(() => normalizeVirtualModelFormInput({ description: "ok", name: "bad/name" })).toThrow();
    expect(() => normalizeVirtualModelFormInput({ description: "", name: "valid" })).toThrow();
    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 0,
        defaultAgentCount: 0,
        routePolicyCount: 1,
      }),
    ).toBeNull();
    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 0,
        defaultAgentCount: 1,
        routePolicyCount: 0,
      }),
    ).toContain("default");
    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 1,
        defaultAgentCount: 0,
        routePolicyCount: 0,
      }),
    ).toContain("allowed");
    expect(
      getVirtualModelDeleteDependencyError({
        allowedAgentCount: 0,
        defaultAgentCount: 0,
        routePolicyCount: 0,
      }),
    ).toBeNull();
  });

  it("builds all Playground protocol shapes and reads JSON and SSE responses", () => {
    const input = {
      maxTokens: 64,
      model: " virtual ",
      prompt: " hello ",
      stream: true,
      systemPrompt: " system ",
      temperature: 0.2,
      topP: 0.9,
    };
    expect(normalizePlaygroundGatewayBaseUrl(" https://gateway.test/// ")).toBe(
      "https://gateway.test",
    );
    expect(isValidPlaygroundGatewayBaseUrl("https://gateway.test")).toBe(true);
    expect(isValidPlaygroundGatewayBaseUrl("file:///tmp/model")).toBe(false);
    expect(isValidPlaygroundGatewayBaseUrl("not a url")).toBe(false);
    expect(buildPlaygroundChatRequest(input)).toMatchObject({ model: "virtual", stream: true });
    expect(buildPlaygroundMessagesRequest(input)).toMatchObject({ system: "system" });
    expect(buildPlaygroundResponsesRequest(input)).toEqual({
      input: [
        {
          content: [{ text: "hello", type: "input_text" }],
          role: "user",
        },
      ],
      instructions: "system",
      model: "virtual",
      store: false,
      stream: true,
    });
    expect(readPlaygroundResponseText({ choices: [{ message: { content: " answer " } }] })).toBe(
      "answer",
    );
    expect(readPlaygroundResponseText({ output: [{ content: [{ text: " response " }] }] })).toBe(
      "response",
    );
    expect(readPlaygroundResponseText({ content: [{ text: " message " }] })).toBe("message");
    expect(readPlaygroundResponseText(null)).toBe("No response text");
    expect(
      readPlaygroundStreamResponseText(
        [
          'data: {"choices":[{"delta":{"content":"hel"}}]}',
          'data: {"delta":{"text":"lo"}}',
          "data: [DONE]",
        ].join("\n"),
      ),
    ).toBe("hello");
    expect(readPlaygroundStreamResponseText("data: invalid")).toBe("No response text");
    expect(formatPlaygroundFetchError("sending", new Error("secret"))).not.toContain("secret");
  });

  it("plans model refresh state transitions without duplicate models", () => {
    const plan = planProviderModelRefresh({
      existingModels: [
        {
          availability: "deprecated",
          displayName: "A old",
          id: "a",
          modelId: "a",
          referenced: true,
        },
        { availability: "available", displayName: "B", id: "b", modelId: "b", referenced: true },
        { availability: "available", displayName: "C", id: "c", modelId: "c", referenced: false },
        { availability: "not_listed", displayName: "D", id: "d", modelId: "d", referenced: false },
      ],
      listedModels: [listed("a", { displayName: "A" }), listed("a"), listed("new")],
    });
    expect(plan.insertModels.map((model) => model.modelId)).toEqual(["new"]);
    expect(plan.markAvailable).toHaveLength(1);
    expect(plan.markUnavailable.map((model) => model.modelId)).toEqual(["b"]);
    expect(plan.markNotListed.map((model) => model.modelId)).toEqual(["c"]);
    expect(plan.routingVisibleChanges).toHaveLength(2);
  });

  it("enriches and filters synced models while building deterministic chained jobs", () => {
    const syncedAt = new Date("2026-01-02T03:04:05.000Z");
    const registry: ProviderModelRegistryEntry[] = [
      {
        inputModalities: ["text", "image"],
        maxContextTokens: 128000,
        maxOutputTokens: 8192,
        modelId: "vision",
        outputModalities: ["text"],
        providerKey: "openai",
        reasoningLevels: ["medium"],
        supportsFunctionCalling: true,
        supportsReasoning: true,
        supportsStreaming: true,
        syncedAt,
      },
    ];
    const enriched = enrichListedProviderModels({
      listedModels: [listed("vision"), listed("unknown")],
      providerKey: "openai",
      registryEntries: registry,
    });
    expect(enriched[0]).toMatchObject({
      contextWindow: 128000,
      inputModalities: ["text", "image"],
      maxOutputTokens: 8192,
      supportsFunctionCalling: true,
      supportsReasoning: true,
      supportsStreaming: true,
    });
    expect(enriched[1]).toEqual(listed("unknown"));

    const prices: ProviderModelSyncedPrice[] = [
      {
        cachedInputUsdPerMillionTokens: null,
        inputUsdPerMillionTokens: 1,
        modelId: "priced",
        outputUsdPerMillionTokens: 2,
        priceVersion: "v1",
        providerKey: "openai",
        source: "models.dev",
        sourceUrl: "https://models.dev",
        syncedAt,
      },
    ];
    expect(
      filterRefreshableListedProviderModels({
        listedModels: [
          listed("context", { contextWindow: 4096 }),
          listed("priced"),
          listed("missing"),
        ],
        providerKey: "openai",
        syncedPrices: prices,
      }).map((model) => model.modelId),
    ).toEqual(["context", "priced"]);
    expect(
      buildChainedPriceSyncJobPayload({
        listedModels: [listed("b"), listed("a"), listed("b")],
        providerId: "provider-1",
        providerKey: " OpenAI ",
      }),
    ).toEqual({
      modelIds: ["a", "b"],
      providerId: "provider-1",
      providerKey: "openai",
      source: "model_refresh",
    });
    expect(buildChainedConnectivityCheckJobPayload({ providerId: "provider-1" })).toEqual({
      providerId: "provider-1",
      source: "model_refresh",
    });
    expect(["pending", "running", "complete"].map(isUnfinishedChainedPriceSyncStatus)).toEqual([
      true,
      true,
      false,
    ]);
    expect(
      ["pending", "running", "failed"].map(isUnfinishedChainedConnectivityCheckStatus),
    ).toEqual([true, true, false]);
  });
});
