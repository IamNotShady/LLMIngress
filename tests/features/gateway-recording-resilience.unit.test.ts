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
} from "../../packages/gateway-runtime/src/gateway-fallback-chain";

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

vi.mock("@llmingress/gateway-runtime/gateway-agent-limits", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@llmingress/gateway-runtime/gateway-agent-limits")>();
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
    recordActivity: vi.fn(async () => undefined),
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

  it("returns the JSON LLM response before completed activity recording finishes", async () => {
    const logger = fakeLogger();
    const recordStarted = deferred();
    const recordBlocked = deferred();
    const execute = vi.fn(async () => ({ body: { ok: true }, statusCode: 200 }));
    const responsePromise = executeRecordedGatewayJsonRequest({
      ...baseInput,
      execute,
      logger,
      recorder: recorder({
        recordActivity: vi.fn(async () => {
          recordStarted.resolve();
          await recordBlocked.promise;
        }),
      }),
    });

    await recordStarted.promise;
    const response = await expectResolvedBeforeRecording(responsePromise);
    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith();

    recordBlocked.resolve();
  });

  it("logs background JSON activity failures after returning the LLM response", async () => {
    const logger = fakeLogger();
    const failing = recorder({
      recordActivity: vi.fn(async () => {
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
    await waitForErrorLogs(logger, 1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ activityId: expect.any(String), requestId: baseInput.requestId }),
      "gateway activity recording failed",
    );
  });

  it("returns a streaming error response before activity completion finishes", async () => {
    const logger = fakeLogger();
    const recordStarted = deferred();
    const recordBlocked = deferred();
    const responsePromise = executeRecordedGatewayStreamingRequest({
      ...baseInput,
      execute: async () => ({
        body: { error: { code: "provider_rejected_request" } },
        ok: false,
        statusCode: 502,
      }),
      logger,
      recorder: recorder({
        recordActivity: vi.fn(async () => {
          recordStarted.resolve();
          await recordBlocked.promise;
        }),
      }),
    });

    await recordStarted.promise;
    const response = await expectResolvedBeforeRecording(responsePromise);
    expect(response.ok).toBe(false);
    expect(response.statusCode).toBe(502);

    recordBlocked.resolve();
  });

  it("ends a successful stream without waiting for budget usage or activity recording", async () => {
    const logger = fakeLogger();
    const budgetStarted = deferred();
    const budgetBlocked = deferred();
    const recordStarted = deferred();
    const recordBlocked = deferred();
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
        recordActivity: vi.fn(async () => {
          events.push("activity-started");
          recordStarted.resolve();
          await recordBlocked.promise;
        }),
      }),
    });

    expect(response.ok).toBe(true);
    const bodyPromise = readStreamBody(response.body);

    await budgetStarted.promise;
    await recordStarted.promise;
    const body = await expectResolvedBeforeRecording(bodyPromise);
    expect(body).toBe("streamed response");
    expect(events).toEqual(["budget-started", "activity-started"]);

    budgetBlocked.resolve();
    recordBlocked.resolve();
  });

  it("returns a successful fallback result without writing fallback events immediately", async () => {
    const fallbackAttempts = [];
    const result = await executeProviderFallbackAttempts({
      callProvider: vi.fn(async () => ({ body: { ok: true }, ok: true, statusCode: 200 })),
      candidates: [fallbackCandidate()],
      fallbackAttempts,
      requestId: "req-1",
    });

    expect(result?.result.statusCode).toBe(200);
    expect(fallbackAttempts).toEqual([]);
    expect(postgresQueryMock).not.toHaveBeenCalled();
  });

  it("continues fallback after a failed attempt without writing fallback events immediately", async () => {
    const fallbackAttempts = [];
    const callProvider = vi
      .fn()
      .mockResolvedValueOnce({
        errorCode: "provider_request_failed",
        errorMessage: "socket hang up",
        ok: false,
        statusCode: null,
      })
      .mockResolvedValueOnce({ body: { ok: true }, ok: true, statusCode: 200 });

    const result = await executeProviderFallbackAttempts({
      callProvider,
      candidates: [
        fallbackCandidate({ providerModelId: "provider-model-1" }),
        fallbackCandidate({ providerModelId: "provider-model-2" }),
      ],
      fallbackAttempts,
      recordHealthEvent: vi.fn(),
      requestId: "req-1",
    });

    expect(result?.candidate.providerModelId).toBe("provider-model-2");
    expect(callProvider).toHaveBeenCalledTimes(2);
    expect(fallbackAttempts).toHaveLength(1);
    expect(postgresQueryMock).not.toHaveBeenCalled();
  });

  it("keeps gateway observability writes off the awaited request path", () => {
    const runtimeFiles = [
      "packages/gateway-runtime/src/gateway-protocol-request.ts",
      "packages/gateway-runtime/src/gateway-streaming.ts",
      "packages/gateway-runtime/src/gateway-fallback-chain.ts",
    ];
    const source = runtimeFiles
      .map((file) => readFileSync(join(process.cwd(), file), "utf8"))
      .join("\n");

    expect(source).not.toMatch(/\bawait\s+recordSucceededAttemptInDatabase\(/);
    expect(source).not.toMatch(/\bawait\s+recordFailedAttemptInDatabase\(/);
    expect(source).not.toMatch(/\bawait\s+recordGatewayProviderApiKeyLastUsed\(/);
    expect(source).not.toContain("requestActivityId");
  });
});
