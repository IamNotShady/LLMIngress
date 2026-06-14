import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildRouteReasonMetadata,
  normalizeRoutePolicyFormInput,
} from "../../apps/console/src/server/route-policies";

describe("feat-029 route policy CRUD", () => {
  it("normalizes route policy form input for persistence", () => {
    const virtualModelId = randomUUID();
    const primaryModelId = randomUUID();
    const fallbackModelId = randomUUID();

    expect(
      normalizeRoutePolicyFormInput({
        fallbackProviderModelIds: ["", fallbackModelId],
        primaryProviderModelIds: [primaryModelId],
        strategy: " balanced ",
        virtualModelId,
      }),
    ).toEqual({
      fallbackProviderModelIds: [fallbackModelId],
      primaryProviderModelIds: [primaryModelId],
      strategy: "balanced",
      virtualModelId,
    });
  });

  it("rejects missing candidates invalid strategies and duplicate candidates", () => {
    const virtualModelId = randomUUID();
    const providerModelId = randomUUID();

    expect(() =>
      normalizeRoutePolicyFormInput({
        fallbackProviderModelIds: [],
        primaryProviderModelIds: [],
        strategy: "balanced",
        virtualModelId,
      }),
    ).toThrow(/primary/i);

    expect(() =>
      normalizeRoutePolicyFormInput({
        fallbackProviderModelIds: [],
        primaryProviderModelIds: [providerModelId],
        strategy: "cheapest",
        virtualModelId,
      }),
    ).toThrow(/strategy/i);

    expect(() =>
      normalizeRoutePolicyFormInput({
        fallbackProviderModelIds: [providerModelId],
        primaryProviderModelIds: [providerModelId],
        strategy: "balanced",
        virtualModelId,
      }),
    ).toThrow(/duplicate/i);
  });

  it("builds route reason metadata from strategy and fallback configuration", () => {
    expect(
      buildRouteReasonMetadata({
        fallbackCandidateCount: 1,
        primaryCandidateCount: 2,
        strategy: "cost_first",
        virtualModelName: "coding-fast",
      }),
    ).toBe("cost_first route for coding-fast uses 2 primary candidates with 1 fallback.");
  });
});
