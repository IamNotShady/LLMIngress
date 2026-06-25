import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRouteReasonMetadata,
  normalizeRoutePolicyFormInput,
} from "../../apps/console/src/server/route-policies";

describe("feat-029 route policy CRUD", () => {
  it("normalizes route policy form input into a single ordered candidate pool", () => {
    const virtualModelId = randomUUID();
    const firstModelId = randomUUID();
    const secondModelId = randomUUID();

    expect(
      normalizeRoutePolicyFormInput({
        providerModelIds: [firstModelId, "", secondModelId],
        strategy: " random ",
        virtualModelId,
      }),
    ).toEqual({
      providerModelIds: [firstModelId, secondModelId],
      strategy: "random",
      virtualModelId,
    });
  });

  it("rejects empty candidates invalid strategies and duplicate candidates", () => {
    const virtualModelId = randomUUID();
    const providerModelId = randomUUID();

    expect(() =>
      normalizeRoutePolicyFormInput({
        providerModelIds: [],
        strategy: "random",
        virtualModelId,
      }),
    ).toThrow(/at least one provider model/i);

    expect(() =>
      normalizeRoutePolicyFormInput({
        providerModelIds: [providerModelId],
        strategy: "cheapest",
        virtualModelId,
      }),
    ).toThrow(/strategy/i);

    expect(() =>
      normalizeRoutePolicyFormInput({
        providerModelIds: [providerModelId, providerModelId],
        strategy: "random",
        virtualModelId,
      }),
    ).toThrow(/duplicate/i);

    expect(() =>
      normalizeRoutePolicyFormInput({
        providerModelIds: [providerModelId],
        strategy: "balanced",
        virtualModelId,
      }),
    ).toThrow(/strategy/i);
  });

  it("builds route reason metadata from strategy and candidate count", () => {
    expect(
      buildRouteReasonMetadata({
        candidateCount: 3,
        strategy: "cost_first",
        virtualModelName: "coding-fast",
      }),
    ).toBe("cost_first route for coding-fast uses 3 candidates.");

    expect(
      buildRouteReasonMetadata({
        candidateCount: 1,
        strategy: "fixed",
        virtualModelName: "coding-fast",
      }),
    ).toBe("fixed route for coding-fast uses 1 candidate.");
  });
});
