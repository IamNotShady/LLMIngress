import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizeRoutePolicyFormInput } from "../../packages/db/src/console-route-policies";

const virtualModelId = randomUUID();
const modelIds = [randomUUID(), randomUUID(), randomUUID()] as const;

function normalizeWeightedForm(input: { candidateWeights: string[]; strategy?: string }) {
  return normalizeRoutePolicyFormInput({
    candidateWeights: input.candidateWeights,
    endpointProtocol: "chat_completions",
    providerModelIds: modelIds.slice(0, input.candidateWeights.length),
    strategy: input.strategy ?? "weighted",
    virtualModelId,
  });
}

describe("weighted route policy form normalization", () => {
  it("keeps one weight per candidate, aligned with the candidate order", () => {
    expect(normalizeWeightedForm({ candidateWeights: ["0.75", "0.25"] })).toMatchObject({
      candidateWeights: [0.75, 0.25],
      strategy: "weighted",
    });
  });

  it("accepts whole and short decimal forms and a 0.00 fallback-only weight", () => {
    expect(normalizeWeightedForm({ candidateWeights: ["1", "0"] })).toMatchObject({
      candidateWeights: [1, 0],
    });
    expect(normalizeWeightedForm({ candidateWeights: ["0.8", "0.20", "0.00"] })).toMatchObject({
      candidateWeights: [0.8, 0.2, 0],
    });
  });

  it("sums on integer hundredths, so a two-decimal split is not float-refused", () => {
    // 0.1 + 0.2 + 0.7 !== 1 in floating point; hundredths make it exact.
    expect(normalizeWeightedForm({ candidateWeights: ["0.10", "0.20", "0.70"] })).toMatchObject({
      candidateWeights: [0.1, 0.2, 0.7],
    });
  });

  it("refuses a weight shape outside two-decimal 0..1", () => {
    for (const weight of ["0.205", "-0.1", "1.01", "half", ".5", "25%"]) {
      expect(() => normalizeWeightedForm({ candidateWeights: [weight, "0.75"] })).toThrow(
        expect.objectContaining({ code: "route_policy_weight_invalid" }),
      );
    }
  });

  it("requires every candidate of a weighted route to carry a weight", () => {
    expect(() => normalizeWeightedForm({ candidateWeights: ["1.00", "  "] })).toThrow(
      expect.objectContaining({ code: "route_policy_weight_missing" }),
    );
    expect(() =>
      normalizeRoutePolicyFormInput({
        endpointProtocol: "chat_completions",
        providerModelIds: modelIds.slice(0, 2),
        strategy: "weighted",
        virtualModelId,
      }),
    ).toThrow(expect.objectContaining({ code: "route_policy_weight_missing" }));
  });

  it("requires the weights to sum to exactly 1.00 and names the sum it saw", () => {
    expect(() => normalizeWeightedForm({ candidateWeights: ["0.33", "0.33", "0.33"] })).toThrow(
      expect.objectContaining({
        code: "route_policy_weight_sum_invalid",
        message: expect.stringContaining("0.99"),
      }),
    );
    expect(() => normalizeWeightedForm({ candidateWeights: ["0.75", "0.75"] })).toThrow(
      expect.objectContaining({ code: "route_policy_weight_sum_invalid" }),
    );
  });

  it("clears candidate weights for the strategies that do not route by weight", () => {
    expect(
      normalizeWeightedForm({ candidateWeights: ["0.75", "0.25"], strategy: "fixed" }),
    ).toMatchObject({
      candidateWeights: [null, null],
      strategy: "fixed",
    });
  });
});
