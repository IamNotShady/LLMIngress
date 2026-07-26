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

  it("reports every capability the candidates disagree on, not only the first", () => {
    const result = resolveVirtualModelCapabilityContract([
      { ...completeCandidate, id: "candidate-wide", label: "Nous - Aion 2.0 (aion-2.0)" },
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
      // Both differences in one message: the operator fixes the pair once
      // instead of saving, being told about modalities, and coming back to
      // discover the context windows never matched either.
      expect(result.message).toContain("must agree on inputModalities and maxContextTokens");
      expect(result.message).toContain(
        "inputModalities: Nous - Aion 2.0 (aion-2.0) has text, image",
      );
      expect(result.message).toContain("Grok - Grok 4.5 (grok-4.5) has text.");
      expect(result.message).toContain("maxContextTokens: Nous - Aion 2.0 (aion-2.0) has 128000");
      expect(result.message).toContain("Grok - Grok 4.5 (grok-4.5) has 500000.");
    }
  });

  it("names the two candidates that disagree, falling back to the id without a label", () => {
    const result = resolveVirtualModelCapabilityContract([
      { ...completeCandidate, id: "candidate-a", label: "OpenRouter - GPT-5 (openai/gpt-5)" },
      { ...completeCandidate, id: "candidate-unlabelled", maxOutputTokens: 4_096 },
    ]);

    if (!result.ok) {
      expect(result.message).toBe(
        "Route policy candidates must agree on maxOutputTokens, but they differ: " +
          "OpenRouter - GPT-5 (openai/gpt-5) has 8192; candidate-unlabelled has 4096.",
      );
      expect(result.details).toMatchObject({
        mismatches: [
          {
            label: "candidate-unlabelled",
            providerModelId: "candidate-unlabelled",
            referenceLabel: "OpenRouter - GPT-5 (openai/gpt-5)",
            referenceProviderModelId: "candidate-a",
          },
        ],
      });
    }
    expect(result.ok).toBe(false);
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
