import { describe, expect, it, vi } from "vitest";
import {
  executeRecordedGatewayJsonRequest,
  type GatewayRequestRecorder,
} from "../../apps/gateway/src/request-recording";

function fakeLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

const baseInput = {
  agentApiKeyId: "agent-1",
  agentApiKeyPrefix: "llmi_",
  model: "vm-a",
  protocol: "chat_completions" as const,
  requestLoggingEnabled: true,
  requestId: "req-1",
  virtualModelId: "vm-id-1",
};

function recorder(overrides: Partial<GatewayRequestRecorder> = {}): GatewayRequestRecorder {
  return {
    completeActivity: vi.fn(async () => undefined),
    createActivity: vi.fn(async () => ({ id: "act-1", startedAt: new Date() })),
    recordTrace: vi.fn(async () => undefined),
    recordUsageCost: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("gateway recording resilience", () => {
  it("returns the LLM response when activity creation fails", async () => {
    const logger = fakeLogger();
    const execute = vi.fn(async () => ({ body: { ok: true }, statusCode: 200 }));
    const response = await executeRecordedGatewayJsonRequest({
      ...baseInput,
      execute,
      logger,
      recorder: recorder({
        createActivity: vi.fn(async () => {
          throw new Error("db down");
        }),
      }),
    });
    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(undefined);
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns the LLM response when completion usage and trace writes fail", async () => {
    const logger = fakeLogger();
    const failing = recorder({
      completeActivity: vi.fn(async () => {
        throw new Error("write failed");
      }),
      recordTrace: vi.fn(async () => {
        throw new Error("write failed");
      }),
      recordUsageCost: vi.fn(async () => {
        throw new Error("write failed");
      }),
    });
    const response = await executeRecordedGatewayJsonRequest({
      ...baseInput,
      execute: async () => ({
        body: { ok: true },
        statusCode: 200,
        usageCost: {
          actualPrice: { status: "unknown_price", priceVersion: "v0" } as never,
          baselinePrice: { status: "unknown_price", priceVersion: "v0" } as never,
          baselineProviderModelId: "pm-1",
          estimatedInputTokens: 1,
          estimatedOutputTokens: 1,
          providerModelId: "pm-1",
        },
      }),
      logger,
      recorder: failing,
    });
    expect(response.statusCode).toBe(200);
    expect(logger.error).toHaveBeenCalledTimes(3);
  });
});
