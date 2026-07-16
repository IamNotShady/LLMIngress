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

  it("names the exact conflicting values when two context windows round to the same display", () => {
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
    if (!result.ok) {
      expect(result.message).toContain("maxOutputTokens");
      expect(result.message).toContain("8192");
      expect(result.message).toContain("4096");
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
