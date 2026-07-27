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

  it("leaves a capability unknown when candidates disagree or one value is unknown", () => {
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
      contract: { maxContextTokens: null },
      ok: true,
    });
  });

  it("allows different context windows and omits that field from request prechecks", () => {
    const result = resolveVirtualModelCapabilityContract([
      { ...completeCandidate, id: "candidate-round", maxContextTokens: 1_000_000 },
      { ...completeCandidate, id: "candidate-nonround", maxContextTokens: 1_048_576 },
    ]);

    expect(result).toMatchObject({
      contract: { maxContextTokens: null },
      ok: true,
    });
  });

  it("keeps only capability values shared by every candidate", () => {
    const result = resolveVirtualModelCapabilityContract([
      completeCandidate,
      {
        ...completeCandidate,
        id: "candidate-b",
        inputModalities: ["text"],
        maxOutputTokens: 4_096,
      },
    ]);

    expect(result).toMatchObject({
      contract: {
        inputModalities: null,
        maxContextTokens: 128_000,
        maxOutputTokens: null,
        outputModalities: ["text"],
        supportsFunctionCalling: true,
        supportsReasoning: false,
      },
      ok: true,
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
