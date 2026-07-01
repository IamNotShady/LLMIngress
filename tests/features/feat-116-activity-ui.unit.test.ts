import {
  formatConsoleActivityMetadata,
  normalizeConsoleActivityFilters,
} from "@llmingress/db/console-activity";
import { describe, expect, it } from "vitest";

describe("feat-116 activity reference UI", () => {
  it("normalizes reference Activity filters for server-side querying", () => {
    expect(
      normalizeConsoleActivityFilters({
        agentApiKeyId: " agent-116 ",
        limit: "8",
        page: "2",
        providerId: " provider-116 ",
        requestId: " req_exact_116 ",
        requestIdQuery: " req_search_116 ",
        status: "failed",
        virtualModelId: " vm-116 ",
      }),
    ).toEqual({
      agentApiKeyId: "agent-116",
      from: undefined,
      limit: 8,
      page: 2,
      protocol: undefined,
      providerId: "provider-116",
      providerModelId: undefined,
      requestId: "req_exact_116",
      requestIdQuery: "req_search_116",
      status: "failed",
      to: undefined,
      virtualModelId: "vm-116",
    });
  });

  it("formats safe metadata as stable key value lines", () => {
    expect(
      formatConsoleActivityMetadata({
        channel: "cli",
        promptPreview: "must not be displayed",
        region: "local",
        tokenUsage: {
          inputTokens: 12,
          totalTokens: 34,
        },
        user_id: "u_12345",
      }),
    ).toEqual([
      "channel: cli",
      "region: local",
      "tokenUsage.inputTokens: 12",
      "tokenUsage.totalTokens: 34",
      "user_id: u_12345",
    ]);
  });

  it("uses a readable empty metadata label", () => {
    expect(formatConsoleActivityMetadata({})).toEqual(["No request metadata recorded"]);
    expect(formatConsoleActivityMetadata(null)).toEqual(["No request metadata recorded"]);
  });
});
