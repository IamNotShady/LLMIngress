import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeRecordedGatewayJsonRequest,
  executeRecordedGatewayStreamingRequest,
  type GatewayRequestRecorder,
} from "../../apps/gateway/src/request-recording";
import {
  executeProviderFallbackAttempts,
  type FallbackChainCandidate,
} from "../../packages/db/src/gateway-fallback-chain";
import { wrapProviderStreamWithErrorRecording } from "../../packages/db/src/gateway-stream-pipeline";

const postgresQueryMock = vi.hoisted(() => vi.fn(async () => ({ rows: [] })));
const recordGatewayBudgetUsageMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@llmingress/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@llmingress/db/client")>();
  return {
    ...actual,
    getPostgresPool: vi.fn(() => ({
      query: postgresQueryMock,
    })),
  };
});

vi.mock("@llmingress/db/gateway-agent-limits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@llmingress/db/gateway-agent-limits")>();
  return {
    ...actual,
    recordGatewayBudgetUsage: recordGatewayBudgetUsageMock,
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

function fallbackCandidate(
  overrides: Partial<FallbackChainCandidate> = {},
): FallbackChainCandidate {
  return {
    apiKey: "provider-key",
    baseUrl: "http://provider.local",
    displayName: "Provider Model",
    healthStatus: "healthy",
    modelId: "model-1",
    price: { status: "unknown_price", priceVersion: "v0" } as never,
    providerId: "provider-1",
    providerKey: "openai",
    providerModelId: "provider-model-1",
    ...overrides,
  };
}

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
    postgresQueryMock.mockReset();
    postgresQueryMock.mockResolvedValue({ rows: [] });
    recordGatewayBudgetUsageMock.mockReset();
    recordGatewayBudgetUsageMock.mockResolvedValue(undefined);
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

  it("ends a successful stream without waiting for budget usage or activity completion", async () => {
    const logger = fakeLogger();
    const budgetStarted = deferred();
    const budgetBlocked = deferred();
    const completionStarted = deferred();
    const completionBlocked = deferred();
    const events: string[] = [];
    recordGatewayBudgetUsageMock.mockImplementationOnce(async () => {
      events.push("budget-started");
      budgetStarted.resolve();
      await budgetBlocked.promise;
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
        budgetSettlement: {
          periodEnd: new Date("2026-07-06T00:00:00.000Z"),
          periodStart: new Date("2026-07-05T00:00:00.000Z"),
          periodType: "day",
        },
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

    await budgetStarted.promise;
    await completionStarted.promise;
    const body = await expectResolvedBeforeRecording(bodyPromise);
    expect(body).toBe("streamed response");
    expect(events).toEqual(["budget-started", "complete-started"]);

    budgetBlocked.resolve();
    completionBlocked.resolve();
  });

  it("returns a successful fallback result before recording the succeeded attempt finishes", async () => {
    const insertStarted = deferred();
    const insertBlocked = deferred();
    postgresQueryMock.mockImplementationOnce(async () => {
      insertStarted.resolve();
      await insertBlocked.promise;
      return { rows: [] };
    });

    const resultPromise = executeProviderFallbackAttempts({
      callProvider: vi.fn(async () => ({ body: { ok: true }, ok: true, statusCode: 200 })),
      candidates: [fallbackCandidate()],
      fallbackAttempts: [],
      requestActivityId: "activity-1",
      requestId: "req-1",
    });

    await insertStarted.promise;
    const result = await expectResolvedBeforeRecording(resultPromise);
    expect(result?.result.statusCode).toBe(200);

    insertBlocked.resolve();
  });

  it("continues fallback before recording the failed attempt finishes", async () => {
    const failedInsertStarted = deferred();
    const failedInsertBlocked = deferred();
    postgresQueryMock
      .mockImplementationOnce(async () => {
        failedInsertStarted.resolve();
        await failedInsertBlocked.promise;
        return { rows: [] };
      })
      .mockResolvedValue({ rows: [] });
    const callProvider = vi
      .fn()
      .mockResolvedValueOnce({
        errorCode: "provider_request_failed",
        errorMessage: "socket hang up",
        ok: false,
        statusCode: null,
      })
      .mockResolvedValueOnce({ body: { ok: true }, ok: true, statusCode: 200 });

    const resultPromise = executeProviderFallbackAttempts({
      callProvider,
      candidates: [
        fallbackCandidate({ providerModelId: "provider-model-1" }),
        fallbackCandidate({ providerModelId: "provider-model-2" }),
      ],
      fallbackAttempts: [],
      requestActivityId: "activity-1",
      requestId: "req-1",
    });

    await failedInsertStarted.promise;
    const result = await expectResolvedBeforeRecording(resultPromise);
    expect(result?.candidate.providerModelId).toBe("provider-model-2");
    expect(callProvider).toHaveBeenCalledTimes(2);

    failedInsertBlocked.resolve();
  });

  it("propagates stream runtime errors before runtime error recording finishes", async () => {
    const recordStarted = deferred();
    const recordBlocked = deferred();
    const source = new Readable({
      read() {},
    });
    const output = wrapProviderStreamWithErrorRecording(source, {
      recordRuntimeError: async () => {
        recordStarted.resolve();
        await recordBlocked.promise;
      },
    });
    const errorPromise = new Promise<Error>((resolve) => {
      output.once("error", (error) => resolve(error));
    });

    source.destroy(new Error("midstream boom"));

    await recordStarted.promise;
    const error = await expectResolvedBeforeRecording(errorPromise);
    expect(error.message).toBe("midstream boom");

    recordBlocked.resolve();
  });

  it("keeps gateway observability writes off the awaited request path", () => {
    const runtimeFiles = [
      "packages/db/src/gateway-protocol-request.ts",
      "packages/db/src/gateway-streaming.ts",
      "packages/db/src/gateway-fallback-chain.ts",
    ];
    const source = runtimeFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/\bawait\s+recordGatewayProviderTrace\(/);
    expect(source).not.toMatch(/\bawait\s+recordSucceededAttemptInDatabase\(/);
    expect(source).not.toMatch(/\bawait\s+recordFailedAttemptInDatabase\(/);
    expect(source).not.toMatch(/\bawait\s+recordGatewayProviderApiKeyLastUsed\(/);
  });
});
