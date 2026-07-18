import {
  formatApiKeyLimitSummaries,
  normalizeApiKeyLimitFormInput,
} from "@llmingress/db/console-api-key-limits";
import {
  getVirtualModelDeleteDependencyError,
  normalizeVirtualModelFormInput,
} from "@llmingress/db/console-virtual-models";
import type { ListedProviderModel } from "@llmingress/provider/model-list";
import type { ProviderModelRegistryEntry } from "@llmingress/provider/price-source";
import {
  buildChainedPriceSyncJobPayload,
  enrichListedProviderModels,
  isUnfinishedChainedPriceSyncStatus,
  planProviderModelRefresh,
} from "@llmingress/worker-runtime/worker-model-refresh";
import { describe, expect, it, vi } from "vitest";
import {
  buildPlaygroundChatRequest,
  buildPlaygroundMessagesRequest,
  buildPlaygroundResponsesRequest,
  formatPlaygroundFetchError,
  isValidPlaygroundGatewayBaseUrl,
  normalizePlaygroundGatewayBaseUrl,
  readOptionalPlaygroundNumber,
  readPlaygroundResponseText,
  readPlaygroundStreamResponseText,
  retryPlaygroundRequestDetail,
} from "../../apps/console/src/app/playground-helpers.ts";

const listed = (modelId: string, overrides: Partial<ListedProviderModel> = {}) => ({
  displayName: modelId,
  modelId,
  ...overrides,
});

describe("core delivery behavior coverage", () => {
  it("normalizes limits and returns stable summaries", () => {
    const normalized = normalizeApiKeyLimitFormInput({
      apiKeyId: " api-key-1 ",
      budgetPeriod: "week",
      budgetUsd: "12.5",
      concurrency: "3",
      rpm: "60",
      tokenLimit: "4096",
      tpm: "120000",
    });
    expect(normalized.apiKeyId).toBe("api-key-1");
    expect(normalized.rules.map((rule) => [rule.limitType, rule.limitValue, rule.period])).toEqual([
      ["budget", 12.5, "week"],
      ["rpm", 60, "minute"],
      ["tpm", 120000, "minute"],
      ["concurrency", 3, "request"],
      ["token", 4096, "request"],
    ]);
    expect(() => normalizeApiKeyLimitFormInput({ apiKeyId: "", budgetPeriod: "year" })).toThrow();
    expect(
      formatApiKeyLimitSummaries([
        {
          apiKeyId: "api-key-1",
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
        allowedApiKeyCount: 0,
        defaultApiKeyCount: 0,
        routePolicyCount: 1,
      }),
    ).toBeNull();
    expect(
      getVirtualModelDeleteDependencyError({
        allowedApiKeyCount: 0,
        defaultApiKeyCount: 1,
        routePolicyCount: 0,
      }),
    ).toContain("default");
    expect(
      getVirtualModelDeleteDependencyError({
        allowedApiKeyCount: 1,
        defaultApiKeyCount: 0,
        routePolicyCount: 0,
      }),
    ).toContain("allowed");
    expect(
      getVirtualModelDeleteDependencyError({
        allowedApiKeyCount: 0,
        defaultApiKeyCount: 0,
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
    expect(buildPlaygroundChatRequest(input)).toMatchObject({
      max_tokens: 64,
      model: "virtual",
      stream: true,
      temperature: 0.2,
      top_p: 0.9,
    });
    expect(buildPlaygroundMessagesRequest(input)).toMatchObject({
      max_tokens: 64,
      system: "system",
      temperature: 0.2,
      top_p: 0.9,
    });
    const inputWithoutOptionalParameters = {
      ...input,
      maxTokens: undefined,
      temperature: undefined,
      topP: undefined,
    };
    for (const request of [
      buildPlaygroundChatRequest(inputWithoutOptionalParameters),
      buildPlaygroundMessagesRequest(inputWithoutOptionalParameters),
    ]) {
      expect(request).not.toHaveProperty("max_tokens");
      expect(request).not.toHaveProperty("temperature");
      expect(request).not.toHaveProperty("top_p");
    }
    expect(readOptionalPlaygroundNumber("")).toBeUndefined();
    expect(readOptionalPlaygroundNumber("  ")).toBeUndefined();
    expect(readOptionalPlaygroundNumber("0.4")).toBe(0.4);
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

  it("retries delayed Playground request details without polling forever", async () => {
    const delayedDetail = { requestId: "playground-delayed" };
    const loadDelayedDetail = vi
      .fn<() => Promise<typeof delayedDetail | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(delayedDetail);

    await expect(
      retryPlaygroundRequestDetail(loadDelayedDetail, { delayMs: 0, maxAttempts: 4 }),
    ).resolves.toEqual(delayedDetail);
    expect(loadDelayedDetail).toHaveBeenCalledTimes(3);

    const neverAvailable = vi.fn<() => Promise<null>>().mockResolvedValue(null);
    await expect(
      retryPlaygroundRequestDetail(neverAvailable, { delayMs: 0, maxAttempts: 2 }),
    ).resolves.toBeNull();
    expect(neverAvailable).toHaveBeenCalledTimes(2);
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

  it("enriches synced models while building deterministic chained jobs", () => {
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
    expect(["pending", "running", "complete"].map(isUnfinishedChainedPriceSyncStatus)).toEqual([
      true,
      true,
      false,
    ]);
  });
});
