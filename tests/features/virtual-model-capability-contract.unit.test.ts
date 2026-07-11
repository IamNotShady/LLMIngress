import { describe, expect, it } from "vitest";
import {
  resolveVirtualModelCapabilityContract,
  type VirtualModelCapabilityContract,
  validateVirtualModelRequestCapabilities,
} from "../../packages/domain/src/index.ts";

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
  it("rejects candidates with unknown capability fields", () => {
    const result = resolveVirtualModelCapabilityContract([
      {
        ...completeCandidate,
        supportsReasoning: null,
      },
    ]);

    expect(result).toMatchObject({
      code: "route_policy_candidate_capability_incomplete",
      details: {
        fields: ["supportsReasoning"],
        providerModelId: "candidate-a",
      },
      ok: false,
    });
  });

  it("rejects candidates whose capability contract differs from the first candidate", () => {
    const result = resolveVirtualModelCapabilityContract([
      completeCandidate,
      {
        ...completeCandidate,
        id: "candidate-b",
        inputModalities: ["image", "text"],
        maxOutputTokens: 4_096,
      },
    ]);

    expect(result).toMatchObject({
      code: "route_policy_candidate_capability_mismatch",
      details: {
        referenceProviderModelId: "candidate-a",
        field: "maxOutputTokens",
        providerModelId: "candidate-b",
      },
      ok: false,
    });
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
});
