import { describe, expect, it } from "vitest";
import {
  filterRefreshableListedProviderModels,
  planProviderModelRefresh,
} from "../../apps/worker/src/model-refresh";
import { buildProviderModelListRequest } from "../../packages/provider/src/model-list";

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

  it("filters models with no context or token prices before planning refresh writes", () => {
    const syncedAt = new Date("2026-06-21T00:00:00.000Z");

    expect(
      filterRefreshableListedProviderModels({
        listedModels: [
          { displayName: "No Metadata", modelId: "no-metadata" },
          { contextWindow: 128_000, displayName: "Has Context", modelId: "has-context" },
          { displayName: "Has Price", modelId: "has-price" },
        ],
        providerKey: "OpenAI",
        syncedPrices: [
          {
            cachedInputUsdPerMillionTokens: null,
            inputUsdPerMillionTokens: 0.4,
            modelId: "has-price",
            outputUsdPerMillionTokens: 1.6,
            priceVersion: "models.dev:test",
            providerKey: "openai",
            source: "models.dev",
            sourceUrl: "https://models.dev/api.json",
            syncedAt,
          },
        ],
      }),
    ).toEqual([
      { contextWindow: 128_000, displayName: "Has Context", modelId: "has-context" },
      { displayName: "Has Price", modelId: "has-price" },
    ]);
  });

  it("builds an authenticated provider model list request", () => {
    expect(
      buildProviderModelListRequest({
        apiKey: "sk-refresh-secret",
        baseUrl: "https://api.openai.com/v1",
        providerKey: "openai",
      }),
    ).toEqual({
      init: {
        headers: {
          authorization: "Bearer sk-refresh-secret",
        },
        method: "GET",
      },
      url: "https://api.openai.com/v1/models",
    });
  });

  it("builds an Anthropic provider model list request with Anthropic API key headers", () => {
    expect(
      buildProviderModelListRequest({
        apiKey: "sk-ant-refresh-secret",
        baseUrl: "https://api.anthropic.com/v1",
        providerKey: "anthropic",
      }),
    ).toEqual({
      init: {
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          "x-api-key": "sk-ant-refresh-secret",
        },
        method: "GET",
      },
      url: "https://api.anthropic.com/v1/models",
    });
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
