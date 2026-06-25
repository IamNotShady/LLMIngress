import { describe, expect, it } from "vitest";
import {
  buildChainedConnectivityCheckJobPayload,
  buildChainedPriceSyncJobPayload,
  isUnfinishedChainedConnectivityCheckStatus,
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

  it("builds a stable provider-scoped connectivity check payload after model refresh writes models", () => {
    expect(buildChainedConnectivityCheckJobPayload({ providerId: "provider-097" })).toEqual({
      providerId: "provider-097",
      source: "model_refresh",
    });
  });

  it("only treats pending and running chained connectivity check jobs as unfinished", () => {
    expect(isUnfinishedChainedConnectivityCheckStatus("pending")).toBe(true);
    expect(isUnfinishedChainedConnectivityCheckStatus("running")).toBe(true);
    expect(isUnfinishedChainedConnectivityCheckStatus("succeeded")).toBe(false);
    expect(isUnfinishedChainedConnectivityCheckStatus("failed")).toBe(false);
    expect(isUnfinishedChainedConnectivityCheckStatus("canceled")).toBe(false);
  });
});
