import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createReadaheadStream,
  wrapProviderStreamWithActivityCompletion,
  wrapProviderStreamWithErrorRecording,
} from "../../packages/db/src/gateway-streaming";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";
import {
  createClaudeCodeProviderAdapter,
  createCodexSubscriptionAdapter,
} from "../../packages/provider/src/adapters/subscription";

describe("provider call timeouts", () => {
  it("fails a hung non-streaming provider call within the timeout", async () => {
    const hangingFetch = createHangingFetch();
    const adapter = createOpenAIProviderAdapter({ fetch: hangingFetch, timeoutMs: 20 });
    const result = await adapter.chatCompletion({
      request: { messages: [{ content: "hi", role: "user" }] },
      target: { apiKey: "k", baseUrl: "http://provider.test/v1", modelId: "m" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.errorMessage).toContain("timed out");
    }
  });

  it("fails a hung Codex subscription responses call within the timeout", async () => {
    const adapter = createCodexSubscriptionAdapter({
      fetch: createHangingFetch(),
      timeoutMs: 20,
    });
    const result = await adapter.response?.({
      request: { input: "hi" },
      target: { apiKey: "k", baseUrl: "http://provider.test/v1", modelId: "m" },
    });

    expect(result?.ok).toBe(false);
    if (result && !result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.errorMessage).toContain("timed out");
    }
  });

  it("fails a hung Claude Code subscription messages call within the timeout", async () => {
    const adapter = createClaudeCodeProviderAdapter({
      fetch: createHangingFetch(),
      timeoutMs: 20,
    });
    const result = await adapter.messages({
      request: { maxOutputTokens: 128, messages: [{ content: "hi", role: "user" }] },
      target: { apiKey: "k", baseUrl: "http://provider.test/v1", modelId: "m" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.errorMessage).toContain("timed out");
    }
  });
});

describe("streaming idle timeout", () => {
  it("errors the stream when the provider stalls between chunks", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
    });
    const reader = stalled.getReader();
    const first = await reader.read();
    const stream = createReadaheadStream(reader, first.value as Uint8Array, { idleTimeoutMs: 20 });
    await expect(
      new Promise((_resolve, reject) => stream.on("error", reject).resume()),
    ).rejects.toThrow(/stalled/i);
  });
});

describe("streaming backpressure", () => {
  it("stops pulling from the provider when the client does not read", () => {
    const source = new PassThrough({ highWaterMark: 1024 });
    wrapProviderStreamWithActivityCompletion(source, {
      completeActivity: async () => undefined,
      statusCode: 200,
    });
    let writes = 0;
    while (source.write(Buffer.alloc(1024)) && writes < 1000) {
      writes += 1;
    }
    expect(writes).toBeLessThan(64);
  });

  it("destroys the upstream source when the client side closes", async () => {
    const source = new PassThrough();
    const wrapped = wrapProviderStreamWithActivityCompletion(source, {
      completeActivity: async () => undefined,
      statusCode: 200,
    });
    wrapped.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source.destroyed).toBe(true);
  });

  it("cancels the readahead reader through nested wrappers when the client side closes", async () => {
    let cancelCalls = 0;
    let runtimeErrorRecords = 0;
    const stalled = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalls += 1;
      },
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
      },
    });
    const reader = stalled.getReader();
    const first = await reader.read();
    const source = createReadaheadStream(reader, first.value as Uint8Array, {
      idleTimeoutMs: 10_000,
    });
    const recorded = wrapProviderStreamWithErrorRecording(source, {
      recordRuntimeError: async () => {
        runtimeErrorRecords += 1;
      },
    });
    const wrapped = wrapProviderStreamWithActivityCompletion(recorded, {
      completeActivity: async () => undefined,
      statusCode: 200,
    });

    wrapped.resume();
    await delay(10);
    wrapped.destroy();
    await waitFor(() => cancelCalls === 1);

    expect(runtimeErrorRecords).toBe(0);
  });
});

function createHangingFetch(): typeof fetch {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) {
      return;
    }
    await delay(10);
  }
  expect(predicate()).toBe(true);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
