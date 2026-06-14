import { describe, expect, it } from "vitest";
import {
  buildMvpHappyPathModelOptionLabel,
  buildMvpHappyPathRequestId,
  mvpHappyPathNames,
} from "../support/mvp-happy-path";

describe("feat-050 MVP happy path support", () => {
  it("uses stable labels and request ids for the clean setup and hot reload assertions", () => {
    expect(mvpHappyPathNames.virtualModelName).toBe("mvp-happy");
    expect(mvpHappyPathNames.initialProviderModelId).toBe("gpt-4.1-mini");
    expect(mvpHappyPathNames.reloadedProviderModelId).toBe("gpt-4.1-nano");
    expect(buildMvpHappyPathRequestId("initial")).toBe("req_mvp_initial_050");
    expect(buildMvpHappyPathRequestId("reloaded")).toBe("req_mvp_reloaded_050");
    expect(
      buildMvpHappyPathModelOptionLabel({
        modelDisplayName: "GPT 4.1 Mini",
        modelId: "gpt-4.1-mini",
        providerDisplayName: "MVP Happy Provider",
      }),
    ).toBe("MVP Happy Provider - GPT 4.1 Mini (gpt-4.1-mini)");
  });
});
