import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createReadaheadStream,
  wrapProviderStreamWithActivityCompletion,
} from "../../packages/db/src/gateway-streaming";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";

describe("provider call timeouts", () => {
  it("fails a hung non-streaming provider call within the timeout", async () => {
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
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
});
