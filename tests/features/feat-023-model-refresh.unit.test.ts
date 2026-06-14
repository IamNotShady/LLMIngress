import { describe, expect, it } from "vitest";
import { planProviderModelRefresh } from "../../apps/worker/src/model-refresh";

describe("feat-023 provider model refresh job", () => {
  it("plans derived model inserts and only treats referenced availability changes as routing-visible", () => {
    const plan = planProviderModelRefresh({
      existingModels: [
        {
          availability: "available",
          displayName: "Stable",
          id: "model-existing-stable",
          modelId: "stable",
          referenced: true,
        },
        {
          availability: "available",
          displayName: "Old Referenced",
          id: "model-old-referenced",
          modelId: "old-referenced",
          referenced: true,
        },
        {
          availability: "available",
          displayName: "Old Unreferenced",
          id: "model-old-unreferenced",
          modelId: "old-unreferenced",
          referenced: false,
        },
        {
          availability: "unavailable",
          displayName: "Returned Referenced",
          id: "model-returned-referenced",
          modelId: "returned-referenced",
          referenced: true,
        },
      ],
      listedModels: [
        { displayName: "Stable", modelId: "stable" },
        { displayName: "New Model", modelId: "new-model" },
        { displayName: "Returned Referenced", modelId: "returned-referenced" },
      ],
    });

    expect(plan.insertModels).toEqual([{ displayName: "New Model", modelId: "new-model" }]);
    expect(plan.markAvailable).toEqual([
      {
        displayName: "Returned Referenced",
        id: "model-returned-referenced",
        modelId: "returned-referenced",
        referenced: true,
      },
    ]);
    expect(plan.markUnavailable).toEqual([
      {
        id: "model-old-referenced",
        modelId: "old-referenced",
        referenced: true,
      },
    ]);
    expect(plan.markNotListed).toEqual([
      {
        id: "model-old-unreferenced",
        modelId: "old-unreferenced",
        referenced: false,
      },
    ]);
    expect(plan.routingVisibleChanges).toEqual([
      { recordId: "model-old-referenced", table: "provider_models" },
      { recordId: "model-returned-referenced", table: "provider_models" },
    ]);
  });

  it("plans no routing-visible changes when the listed model set is unchanged", () => {
    const plan = planProviderModelRefresh({
      existingModels: [
        {
          availability: "available",
          displayName: "Stable",
          id: "model-stable",
          modelId: "stable",
          referenced: true,
        },
      ],
      listedModels: [{ displayName: "Stable", modelId: "stable" }],
    });

    expect(plan).toMatchObject({
      insertModels: [],
      markAvailable: [],
      markNotListed: [],
      markUnavailable: [],
      routingVisibleChanges: [],
    });
  });

  it("deduplicates repeated provider model ids before planning inserts", () => {
    const plan = planProviderModelRefresh({
      existingModels: [],
      listedModels: [
        { displayName: "New Model", modelId: "new-model" },
        { displayName: "New Model Duplicate", modelId: "new-model" },
      ],
    });

    expect(plan.insertModels).toEqual([{ displayName: "New Model", modelId: "new-model" }]);
  });

  it("does not publish a routing-visible change for a referenced model display name-only change", () => {
    const plan = planProviderModelRefresh({
      existingModels: [
        {
          availability: "available",
          displayName: "Old Display Name",
          id: "model-stable",
          modelId: "stable",
          referenced: true,
        },
      ],
      listedModels: [{ displayName: "New Display Name", modelId: "stable" }],
    });

    expect(plan.markAvailable).toEqual([
      {
        displayName: "New Display Name",
        id: "model-stable",
        modelId: "stable",
        referenced: true,
      },
    ]);
    expect(plan.routingVisibleChanges).toEqual([]);
  });
});
