import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  resolveVirtualModelCapabilityContract,
  type VirtualModelCapabilityContract,
  validateVirtualModelRequestCapabilities,
} from "../../packages/domain/src/index.ts";
import type {
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "../../packages/gateway-runtime/src/gateway-config-reload.ts";
import type { GatewayRequestMetadata } from "../../packages/gateway-runtime/src/gateway-request-metadata.ts";
import { assertGatewayRequestWithinVirtualModelCapabilities } from "../../packages/gateway-runtime/src/gateway-virtual-model-capabilities.ts";

const completeCandidate = {
  id: "candidate-a",
  inputModalities: ["text", "image"],
  maxContextTokens: 128_000,
  maxOutputTokens: 8_192,
  outputModalities: ["text"],
  supportsFunctionCalling: true,
  supportsReasoning: false,
} as const;

describe("virtual model capability contract", () => {
  it("allows unknown capability fields and keeps them unknown in the contract", () => {
    const result = resolveVirtualModelCapabilityContract([
      {
        ...completeCandidate,
        supportsReasoning: null,
      },
    ]);

    expect(result).toMatchObject({
      contract: { supportsReasoning: null },
      ok: true,
    });
  });

  it("does not let unknown values hide conflicts between known candidates", () => {
    const result = resolveVirtualModelCapabilityContract([
      completeCandidate,
      {
        ...completeCandidate,
        id: "candidate-unknown",
        maxContextTokens: null,
      },
      {
        ...completeCandidate,
        id: "candidate-conflict",
        maxContextTokens: 64_000,
      },
    ]);

    expect(result).toMatchObject({
      code: "route_policy_candidate_capability_mismatch",
      details: {
        field: "maxContextTokens",
        providerModelId: "candidate-conflict",
        referenceProviderModelId: "candidate-a",
      },
      ok: false,
    });
    if (!result.ok) {
      expect(result.message).toContain("maxContextTokens");
      expect(result.message).toContain("128000");
      expect(result.message).toContain("64000");
    }
  });

  it("names the exact conflicting values for different context windows", () => {
    const result = resolveVirtualModelCapabilityContract([
      { ...completeCandidate, id: "candidate-round", maxContextTokens: 1_000_000 },
      { ...completeCandidate, id: "candidate-nonround", maxContextTokens: 1_048_576 },
    ]);

    expect(result).toMatchObject({
      code: "route_policy_candidate_capability_mismatch",
      details: { field: "maxContextTokens" },
      ok: false,
    });
    if (!result.ok) {
      expect(result.message).toContain("1000000");
      expect(result.message).toContain("1048576");
    }
  });

  it("reports every capability difference with candidate names and values", () => {
    const result = resolveVirtualModelCapabilityContract([
      {
        ...completeCandidate,
        id: "candidate-wide",
        label: "Nous - Aion 2.0 (aion-2.0)",
      },
      {
        ...completeCandidate,
        id: "candidate-narrow",
        label: "Grok - Grok 4.5 (grok-4.5)",
        inputModalities: ["text"],
        maxContextTokens: 500_000,
      },
    ]);

    expect(result).toMatchObject({
      code: "route_policy_candidate_capability_mismatch",
      details: {
        field: "inputModalities",
        mismatches: [{ field: "inputModalities" }, { field: "maxContextTokens" }],
      },
      ok: false,
    });
    if (!result.ok) {
      expect(result.message).toContain("must agree on inputModalities and maxContextTokens");
      expect(result.message).toContain(
        "inputModalities: Nous - Aion 2.0 (aion-2.0) has text, image",
      );
      expect(result.message).toContain("Grok - Grok 4.5 (grok-4.5) has text.");
      expect(result.message).toContain("maxContextTokens: Nous - Aion 2.0 (aion-2.0) has 128000");
      expect(result.message).toContain("Grok - Grok 4.5 (grok-4.5) has 500000.");
    }
  });

  it("validates request capabilities against the resolved Virtual Model contract", () => {
    const contract: VirtualModelCapabilityContract = {
      inputModalities: ["text"],
      maxContextTokens: 8_192,
      maxOutputTokens: 1_024,
      outputModalities: ["text"],
      supportsFunctionCalling: false,
      supportsReasoning: false,
    };

    expect(
      validateVirtualModelRequestCapabilities(contract, {
        estimatedInputTokens: 7_000,
        estimatedOutputTokens: 2_000,
        inputModalities: ["text"],
        outputModalities: ["text"],
        usesFunctionCalling: false,
        usesReasoning: false,
      }),
    ).toMatchObject({
      code: "virtual_model_capability_mismatch",
      details: { field: "maxOutputTokens" },
      ok: false,
    });

    expect(
      validateVirtualModelRequestCapabilities(contract, {
        estimatedInputTokens: 10,
        estimatedOutputTokens: 10,
        inputModalities: ["text"],
        outputModalities: ["text"],
        usesFunctionCalling: true,
        usesReasoning: false,
      }),
    ).toMatchObject({
      code: "virtual_model_capability_mismatch",
      details: { field: "supportsFunctionCalling" },
      ok: false,
    });
  });

  it("skips request checks only for unknown contract fields", () => {
    const contract: VirtualModelCapabilityContract = {
      inputModalities: ["text"],
      maxContextTokens: null,
      maxOutputTokens: 1_024,
      outputModalities: ["text"],
      supportsFunctionCalling: null,
      supportsReasoning: false,
    };

    expect(
      validateVirtualModelRequestCapabilities(contract, {
        estimatedInputTokens: 100_000,
        estimatedOutputTokens: 512,
        inputModalities: ["text"],
        outputModalities: ["text"],
        usesFunctionCalling: true,
        usesReasoning: false,
      }),
    ).toEqual({ ok: true });

    expect(
      validateVirtualModelRequestCapabilities(contract, {
        estimatedInputTokens: 1,
        estimatedOutputTokens: 2_048,
        inputModalities: ["text"],
        outputModalities: ["text"],
        usesFunctionCalling: true,
        usesReasoning: false,
      }),
    ).toMatchObject({
      code: "virtual_model_capability_mismatch",
      details: { field: "maxOutputTokens" },
      ok: false,
    });
  });
});

describe("gateway capability contract scope by strategy", () => {
  const fastCandidate = gatewayCandidate({ maxOutputTokens: 512, tags: ["fast"] });
  const defaultCandidate = gatewayCandidate({ maxOutputTokens: 8_192, tags: ["default"] });

  it("checks a tag request against the candidate its tag selected, not the whole policy", () => {
    const routePolicy = gatewayRoutePolicy("tag", [defaultCandidate, fastCandidate]);

    // The tagged candidate cannot serve the request even though the default can.
    expect(() =>
      assertGatewayRequestWithinVirtualModelCapabilities({
        chain: [fastCandidate, defaultCandidate],
        requestMetadata: gatewayRequestMetadata({ estimatedOutputTokens: 1_024 }),
        routePolicy,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "virtual_model_capability_mismatch",
        message: expect.stringContaining("maxOutputTokens"),
      }),
    );

    // The same request against the default candidate is inside its contract, so
    // candidates that disagree never make a tag policy unusable.
    expect(() =>
      assertGatewayRequestWithinVirtualModelCapabilities({
        chain: [defaultCandidate],
        requestMetadata: gatewayRequestMetadata({ estimatedOutputTokens: 1_024 }),
        routePolicy,
      }),
    ).not.toThrow();
  });

  it("keeps the shared all-candidate contract for the ordering strategies", () => {
    expect(() =>
      assertGatewayRequestWithinVirtualModelCapabilities({
        chain: [defaultCandidate, fastCandidate],
        requestMetadata: gatewayRequestMetadata({ estimatedOutputTokens: 10 }),
        routePolicy: gatewayRoutePolicy("fixed", [defaultCandidate, fastCandidate]),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "virtual_model_configuration_invalid",
        message: expect.stringContaining("maxOutputTokens"),
      }),
    );
  });
});

function gatewayCandidate(input: {
  maxOutputTokens: number;
  tags: string[];
}): GatewayRouteCandidateSnapshot {
  const modelId = `model-${input.tags.join("-")}`;
  return {
    candidateOrder: 1,
    contextWindow: 128_000,
    displayName: modelId,
    inputModalities: ["text"],
    maxOutputTokens: input.maxOutputTokens,
    modelId,
    outputModalities: ["text"],
    price: {
      modelId,
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId: randomUUID(),
    providerKey: "openai",
    providerModelId: randomUUID(),
    supportsFunctionCalling: true,
    supportsReasoning: false,
    tags: input.tags,
    weight: null,
  };
}

function gatewayRoutePolicy(
  strategy: GatewayRoutePolicySnapshot["strategy"],
  candidates: GatewayRouteCandidateSnapshot[],
): GatewayRoutePolicySnapshot {
  return {
    candidates,
    endpointProtocol: "chat_completions",
    id: "rp-1",
    strategy,
    virtualModelId: "vm-1",
    virtualModelName: "vm",
  };
}

function gatewayRequestMetadata(input: { estimatedOutputTokens: number }): GatewayRequestMetadata {
  return {
    estimatedInputTokens: 10,
    estimatedOutputTokens: input.estimatedOutputTokens,
    inputModalities: ["text"],
    messageCount: 1,
    model: "vm",
    outputModalities: ["text"],
    protocol: "chat_completions",
    stream: false,
    usesReasoning: false,
    usesTools: false,
  };
}
