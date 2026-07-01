import { describe, expect, it, vi } from "vitest";
import type { GatewayRoutePolicySnapshot } from "../../packages/db/src/gateway-config-reload";
import {
  executeFallbackChain,
  type FallbackChainCandidate,
} from "../../packages/db/src/gateway-fallback-chain";
import { buildRouteAttemptCandidates } from "../../packages/domain/src/index";

describe("feat-033 fallback chain execution", () => {
  it("falls back after a first-byte failure and records the failed provider attempt", async () => {
    const primary = candidate({ candidateOrder: 1, providerModelId: "primary-model" });
    const fallback = candidate({
      candidateOrder: 2,
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
        retryable: true,
        statusCode: null,
      },
    ]);
  });

  it("builds an attempt sequence covering the full ordered eligible chain", () => {
    const routePolicy: GatewayRoutePolicySnapshot = {
      candidates: [
        candidate({ candidateOrder: 1, providerModelId: "first" }),
        candidate({ candidateOrder: 2, providerModelId: "second" }),
        candidate({ candidateOrder: 3, providerModelId: "third" }),
        candidate({ candidateOrder: 4, providerModelId: "fourth" }),
      ],
      id: "route-policy",
      strategy: "cost_first",
      virtualModelId: "virtual-model",
      virtualModelName: "coding",
    };

    // cost_first with equal prices → sorted by candidateOrder asc
    expect(
      buildRouteAttemptCandidates({
        routePolicy,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
      }).map((c) => c.providerModelId),
    ).toEqual(["first", "second", "third", "fourth"]);
  });

  it("orders quality_first fallback attempts from most expensive to least expensive", () => {
    const routePolicy: GatewayRoutePolicySnapshot = {
      candidates: [
        candidate({
          candidateOrder: 1,
          inputPrice: 10,
          outputPrice: 20,
          providerModelId: "expensive",
        }),
        candidate({
          candidateOrder: 2,
          inputPrice: 2,
          outputPrice: 4,
          providerModelId: "cheap",
        }),
        candidate({
          candidateOrder: 3,
          inputPrice: 6,
          outputPrice: 12,
          providerModelId: "medium",
        }),
      ],
      id: "route-policy",
      strategy: "quality_first",
      virtualModelId: "virtual-model",
      virtualModelName: "coding",
    };

    // quality_first: sorted by cost desc → expensive first, then medium, then cheap
    expect(
      buildRouteAttemptCandidates({
        routePolicy,
        estimatedInputTokens: 100,
        estimatedOutputTokens: 100,
      }).map((c) => c.providerModelId),
    ).toEqual(["expensive", "medium", "cheap"]);
  });
});

function candidate(input: {
  candidateOrder: number;
  inputPrice?: number;
  modelId?: string;
  outputPrice?: number;
  providerModelId: string;
}): FallbackChainCandidate {
  return {
    apiKey: "provider-key",
    baseUrl: "https://provider.example/v1",
    candidateOrder: input.candidateOrder,
    displayName: input.modelId ?? "primary",
    healthStatus: "unknown",
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
