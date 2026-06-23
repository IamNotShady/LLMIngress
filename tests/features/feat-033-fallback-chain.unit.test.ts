import { describe, expect, it, vi } from "vitest";
import type { GatewayRoutePolicySnapshot } from "../../apps/gateway/src/config-reload";
import {
  buildFallbackAttemptCandidates,
  executeFallbackChain,
  type FallbackChainCandidate,
} from "../../apps/gateway/src/fallback-chain";

describe("feat-033 fallback chain execution", () => {
  it("falls back after a first-byte failure and records the failed provider attempt", async () => {
    const primary = candidate({ candidateOrder: 1, providerModelId: "primary-model" });
    const fallback = candidate({
      candidateOrder: 2,
      isFallback: true,
      modelId: "fallback",
      providerModelId: "fallback-model",
    });
    const adapter = {
      chatCompletion: vi
        .fn()
        .mockResolvedValueOnce({
          body: null,
          errorCode: "provider_request_failed",
          errorMessage: "socket closed before first byte",
          ok: false,
          retryable: true,
          statusCode: null,
        })
        .mockResolvedValueOnce({
          body: {
            choices: [{ message: { content: "fallback response", role: "assistant" } }],
            id: "fallback-response",
          },
          ok: true,
          providerRequestId: "fallback-response",
          statusCode: 200,
        }),
    };
    const recordedAttempts: unknown[] = [];

    const result = await executeFallbackChain({
      adapter,
      candidates: [primary, fallback],
      recordFailedAttempt: async (attempt) => {
        recordedAttempts.push(attempt);
      },
      request: {
        messages: [{ content: "hello", role: "user" }],
        stream: false,
      },
    });

    expect(result.selectedCandidate.providerModelId).toBe("fallback-model");
    expect(result.result).toMatchObject({
      body: { id: "fallback-response" },
      ok: true,
    });
    expect(adapter.chatCompletion).toHaveBeenCalledTimes(2);
    expect(recordedAttempts).toEqual([
      {
        attemptOrder: 1,
        errorCode: "provider_request_failed",
        errorMessage: "socket closed before first byte",
        failedBeforeFirstByte: true,
        providerModelId: "primary-model",
      },
    ]);
  });

  it("builds an attempt sequence from the selected candidate followed by fallbacks", () => {
    const selected = candidate({ candidateOrder: 2, providerModelId: "selected" });
    const routePolicy: GatewayRoutePolicySnapshot = {
      candidates: [
        candidate({ candidateOrder: 1, providerModelId: "not-selected" }),
        selected,
        candidate({
          candidateOrder: 3,
          isFallback: true,
          providerModelId: "fallback-one",
        }),
        candidate({
          candidateOrder: 4,
          isFallback: true,
          providerModelId: "fallback-two",
        }),
      ],
      id: "route-policy",
      strategy: "cost_first",
      virtualModelId: "virtual-model",
      virtualModelName: "coding",
    };

    expect(
      buildFallbackAttemptCandidates({
        routePolicy,
        selectedProviderModelId: "selected",
      }).map((attempt) => attempt.providerModelId),
    ).toEqual(["selected", "fallback-one", "fallback-two"]);
  });

  it("orders quality_first fallback attempts from most expensive to least expensive", () => {
    const selected = candidate({
      candidateOrder: 1,
      inputPrice: 10,
      outputPrice: 20,
      providerModelId: "selected",
    });
    const routePolicy: GatewayRoutePolicySnapshot = {
      candidates: [
        selected,
        candidate({
          candidateOrder: 2,
          inputPrice: 2,
          isFallback: true,
          outputPrice: 4,
          providerModelId: "fallback-cheap",
        }),
        candidate({
          candidateOrder: 3,
          inputPrice: 6,
          isFallback: true,
          outputPrice: 12,
          providerModelId: "fallback-expensive",
        }),
      ],
      id: "route-policy",
      strategy: "quality_first",
      virtualModelId: "virtual-model",
      virtualModelName: "coding",
    };

    expect(
      buildFallbackAttemptCandidates({
        routePolicy,
        selectedProviderModelId: "selected",
      }).map((attempt) => attempt.providerModelId),
    ).toEqual(["selected", "fallback-expensive", "fallback-cheap"]);
  });
});

function candidate(input: {
  candidateOrder: number;
  inputPrice?: number;
  isFallback?: boolean;
  modelId?: string;
  outputPrice?: number;
  providerModelId: string;
}): FallbackChainCandidate {
  return {
    apiKey: "provider-key",
    baseUrl: "https://provider.example/v1",
    candidateOrder: input.candidateOrder,
    displayName: input.modelId ?? "primary",
    isFallback: input.isFallback ?? false,
    modelId: input.modelId ?? "primary",
    price: {
      currency: "USD",
      inputUsdPerMillionTokens: input.inputPrice ?? 1,
      modelId: input.modelId ?? "primary",
      outputUsdPerMillionTokens: input.outputPrice ?? 1,
      priceVersion: "mvp-static-2026-06-13",
      providerKey: "openai",
      snapshotDate: "2026-06-13",
      source: "built_in_static_snapshot",
      status: "priced",
      unit: "per_1m_tokens",
    },
    providerId: "provider",
    providerKey: "openai",
    providerModelId: input.providerModelId,
  };
}
