import { describe, expect, it } from "vitest";
import {
  buildChainedPriceSyncJobPayload,
  isUnfinishedChainedPriceSyncStatus,
} from "../../apps/worker/src/model-refresh";

describe("feat-097 model refresh price sync chain", () => {
  it("builds a stable provider-scoped price sync payload from refreshed models", () => {
    expect(
      buildChainedPriceSyncJobPayload({
        listedModels: [
          { displayName: "Zeta", modelId: "zeta" },
          { displayName: "Alpha", modelId: "alpha" },
          { displayName: "Alpha Duplicate", modelId: "alpha" },
        ],
        providerId: "provider-097",
        providerKey: "OpenAI",
      }),
    ).toEqual({
      modelIds: ["alpha", "zeta"],
      providerId: "provider-097",
      providerKey: "openai",
      source: "model_refresh",
    });
  });

  it("only treats pending and running chained price sync jobs as unfinished", () => {
    expect(isUnfinishedChainedPriceSyncStatus("pending")).toBe(true);
    expect(isUnfinishedChainedPriceSyncStatus("running")).toBe(true);
    expect(isUnfinishedChainedPriceSyncStatus("succeeded")).toBe(false);
    expect(isUnfinishedChainedPriceSyncStatus("failed")).toBe(false);
    expect(isUnfinishedChainedPriceSyncStatus("canceled")).toBe(false);
  });
});
