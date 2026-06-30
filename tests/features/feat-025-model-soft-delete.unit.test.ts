import { planProviderModelRefresh } from "@llmingress/db/worker-model-refresh";
import { describe, expect, it } from "vitest";
import { buildRoutePolicyWarnings } from "../../apps/console/src/server/route-policies";

describe("feat-025 model availability soft delete", () => {
  it("marks a missing referenced model unavailable and routing-visible", () => {
    const plan = planProviderModelRefresh({
      existingModels: [
        {
          availability: "available",
          displayName: "Old Referenced",
          id: "model-old-referenced",
          modelId: "old-referenced",
          referenced: true,
        },
      ],
      listedModels: [],
    });

    expect(plan.markUnavailable).toEqual([
      {
        id: "model-old-referenced",
        modelId: "old-referenced",
        referenced: true,
      },
    ]);
    expect(plan.markNotListed).toEqual([]);
    expect(plan.routingVisibleChanges).toEqual([
      { recordId: "model-old-referenced", table: "provider_models" },
    ]);
  });

  it("builds Console route warnings for candidates excluded from Gateway routing", () => {
    expect(
      buildRoutePolicyWarnings([
        {
          availability: "unavailable",
          optionLabel: "OpenAI - Old Referenced (old-referenced)",
        },
        {
          availability: "available",
          optionLabel: "OpenAI - Stable (stable)",
        },
      ]),
    ).toEqual([
      "Route warning: OpenAI - Old Referenced (old-referenced) is unavailable and excluded from Gateway routing.",
    ]);
  });
});
