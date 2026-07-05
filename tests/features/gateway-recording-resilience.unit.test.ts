import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeRecordedGatewayJsonRequest,
  executeRecordedGatewayStreamingRequest,
  type GatewayRequestRecorder,
} from "../../apps/gateway/src/request-recording";

const settleGatewayStreamBudgetMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@llmingress/db/gateway-stream-pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@llmingress/db/gateway-stream-pipeline")>();
  return {
    ...actual,
    settleGatewayStreamBudget: settleGatewayStreamBudgetMock,
  };
});

function fakeLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

const baseInput = {
  agentId: "agent-1",
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

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectResolvedBeforeRecording<T>(promise: Promise<T>): Promise<T> {
  const result = await Promise.race([
    promise.then((value) => ({ status: "resolved" as const, value })),
    delay(50).then(() => ({ status: "pending" as const })),
  ]);
  if (result.status === "pending") {
    throw new Error("Expected response to resolve before the recording task completed.");
  }
  return result.value;
}

async function readStreamBody(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function waitForErrorLogs(
  logger: ReturnType<typeof fakeLogger>,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (logger.error.mock.calls.length >= count) {
      return;
    }
    await delay(5);
  }
  expect(logger.error).toHaveBeenCalledTimes(count);
}

describe("gateway recording resilience", () => {
  beforeEach(() => {
    settleGatewayStreamBudgetMock.mockReset();
    settleGatewayStreamBudgetMock.mockResolvedValue(undefined);
  });

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

  it("returns the JSON LLM response before activity completion finishes", async () => {
    const logger = fakeLogger();
    const completionStarted = deferred();
    const completionBlocked = deferred();
    const responsePromise = executeRecordedGatewayJsonRequest({
      ...baseInput,
      execute: async () => ({ body: { ok: true }, statusCode: 200 }),
      logger,
      recorder: recorder({
        completeActivity: vi.fn(async () => {
          completionStarted.resolve();
          await completionBlocked.promise;
        }),
      }),
    });

    await completionStarted.promise;
    const response = await expectResolvedBeforeRecording(responsePromise);
    expect(response.statusCode).toBe(200);

    completionBlocked.resolve();
  });

  it("logs background JSON usage and trace write failures after returning the LLM response", async () => {
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
    await waitForErrorLogs(logger, 3);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ activityId: "act-1", requestId: baseInput.requestId }),
      "gateway usage recording failed",
    );
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: baseInput.requestId }),
      "gateway trace recording failed",
    );
  });

  it("returns a streaming error response before activity completion finishes", async () => {
    const logger = fakeLogger();
    const completionStarted = deferred();
    const completionBlocked = deferred();
    const responsePromise = executeRecordedGatewayStreamingRequest({
      ...baseInput,
      execute: async () => ({
        body: { error: { code: "provider_rejected_request" } },
        ok: false,
        statusCode: 502,
      }),
      logger,
      recorder: recorder({
        completeActivity: vi.fn(async () => {
          completionStarted.resolve();
          await completionBlocked.promise;
        }),
      }),
    });

    await completionStarted.promise;
    const response = await expectResolvedBeforeRecording(responsePromise);
    expect(response.ok).toBe(false);
    expect(response.statusCode).toBe(502);

    completionBlocked.resolve();
  });

  it("ends a successful stream after budget settlement without waiting for activity completion", async () => {
    const logger = fakeLogger();
    const completionStarted = deferred();
    const completionBlocked = deferred();
    const events: string[] = [];
    settleGatewayStreamBudgetMock.mockImplementationOnce(async () => {
      events.push("settled");
    });

    const response = await executeRecordedGatewayStreamingRequest({
      ...baseInput,
      execute: async () => ({
        body: Readable.from([Buffer.from("streamed response")]),
        contentType: "text/event-stream",
        ok: true,
        requestMetadata: {
          estimatedInputTokens: 1,
          estimatedOutputTokens: 1,
          messagesCount: 1,
        },
        statusCode: 200,
      }),
      logger,
      recorder: recorder({
        completeActivity: vi.fn(async () => {
          events.push("complete-started");
          completionStarted.resolve();
          await completionBlocked.promise;
        }),
      }),
    });

    expect(response.ok).toBe(true);
    const bodyPromise = readStreamBody(response.body);

    await completionStarted.promise;
    const body = await expectResolvedBeforeRecording(bodyPromise);
    expect(body).toBe("streamed response");
    expect(events).toEqual(["settled", "complete-started"]);

    completionBlocked.resolve();
  });
});
