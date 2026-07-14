import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  composeGatewayProviderStreamPipeline,
  createReadaheadStream,
  wrapProviderStreamWithActivityCompletion,
} from "../../packages/gateway-runtime/src/gateway-stream-pipeline";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";
import {
  createClaudeCodeProviderAdapter,
  createCodexSubscriptionAdapter,
} from "../../packages/provider/src/adapters/subscription";
import { resolveProviderStreamingDialect } from "../../packages/provider/src/dialect";

describe("provider call timeouts", () => {
  it("fails a hung non-streaming provider call within the timeout", async () => {
    const hangingFetch = createHangingFetch();
    const adapter = createOpenAIProviderAdapter({ fetch: hangingFetch, timeoutMs: 20 });
    const result = await adapter.chatCompletion({
      request: {
        messages: [{ content: "hi", role: "user" }],
        payload: { messages: [{ content: "hi", role: "user" }] },
      },
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
      request: {
        input: [{ content: [{ text: "hi", type: "input_text" }], role: "user" }],
        payload: {
          input: [{ content: [{ text: "hi", type: "input_text" }], role: "user" }],
        },
      },
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
      request: {
        maxOutputTokens: 128,
        messages: [{ content: "hi", role: "user" }],
        payload: { max_tokens: 128, messages: [{ content: "hi", role: "user" }] },
      },
      target: { apiKey: "k", baseUrl: "http://provider.test/v1", modelId: "m" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.errorMessage).toContain("timed out");
    }
  });
});

describe("responses tool passthrough", () => {
  it("passes Responses tools to OpenAI-compatible providers", async () => {
    const capture = createJsonCaptureFetch();
    const adapter = createOpenAIProviderAdapter({ fetch: capture.fetch, timeoutMs: 200 });
    const tool = {
      name: "terminal",
      parameters: { properties: { command: { type: "string" } }, type: "object" },
      type: "function",
    };
    const toolOutput = {
      call_id: "call_terminal",
      output: '{"stdout":"ok"}',
      type: "function_call_output",
    };

    const result = await adapter.response?.({
      request: {
        input: [{ content: "run pwd", role: "user" }, toolOutput],
        payload: {
          input: [{ content: "run pwd", role: "user" }, toolOutput],
          parallel_tool_calls: false,
          tool_choice: "auto",
          tools: [tool],
        },
        parallelToolCalls: false,
        toolChoice: "auto",
        tools: [tool],
      },
      target: { apiKey: "k", baseUrl: "http://provider.test/v1", modelId: "m" },
    });

    expect(result?.ok).toBe(true);
    expect(capture.calls[0]?.url).toBe("http://provider.test/v1/responses");
    expect(capture.calls[0]?.body).toMatchObject({
      input: [{ content: "run pwd", role: "user" }, toolOutput],
      model: "m",
      parallel_tool_calls: false,
      tool_choice: "auto",
      tools: [tool],
    });
  });

  it("passes Responses tools and raw tool outputs to Codex subscriptions", async () => {
    const capture = createJsonCaptureFetch();
    const adapter = createCodexSubscriptionAdapter({ fetch: capture.fetch, timeoutMs: 200 });
    const tool = {
      name: "terminal",
      parameters: { properties: { command: { type: "string" } }, type: "object" },
      type: "function",
    };
    const toolOutput = {
      call_id: "call_terminal",
      output: '{"stdout":"ok"}',
      type: "function_call_output",
    };

    const result = await adapter.response?.({
      request: {
        input: [{ content: [{ text: "run pwd", type: "input_text" }], role: "user" }, toolOutput],
        payload: {
          input: [{ content: [{ text: "run pwd", type: "input_text" }], role: "user" }, toolOutput],
          parallel_tool_calls: false,
          store: true,
          stream: false,
          tool_choice: "required",
          tools: [tool],
        },
        parallelToolCalls: false,
        toolChoice: "required",
        tools: [tool],
      },
      target: { apiKey: "k", baseUrl: "http://provider.test/v1", modelId: "m" },
    });

    expect(result?.ok).toBe(true);
    expect(capture.calls[0]?.url).toBe("http://provider.test/v1/codex/responses");
    expect(capture.calls[0]?.body).toMatchObject({
      input: [{ content: [{ text: "run pwd", type: "input_text" }], role: "user" }, toolOutput],
      model: "m",
      parallel_tool_calls: false,
      store: true,
      stream: false,
      tool_choice: "required",
      tools: [tool],
    });
  });

  it("does not convert a Codex SSE response into a non-streaming JSON response", async () => {
    const raw = 'data: {"output_text":"provider text"}\n\n';
    const adapter = createCodexSubscriptionAdapter({
      fetch: (async () =>
        new Response(raw, {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        })) as typeof fetch,
      timeoutMs: 200,
    });

    const result = await adapter.response?.({
      request: {
        input: [{ content: [{ text: "hi", type: "input_text" }], role: "user" }],
        payload: {
          input: [{ content: [{ text: "hi", type: "input_text" }], role: "user" }],
          stream: false,
        },
        stream: false,
      },
      target: { apiKey: "k", baseUrl: "http://provider.test/v1", modelId: "m" },
    });

    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.body).toEqual({ raw });
    }
  });

  it("passes the canonical Responses body to Codex without forcing or dropping fields", async () => {
    const capture = createJsonCaptureFetch();
    const adapter = createCodexSubscriptionAdapter({ fetch: capture.fetch, timeoutMs: 200 });
    const canonicalInput = [
      { content: [{ text: "hello", type: "input_text" }], role: "user" as const },
    ];

    const result = await adapter.response?.({
      request: {
        input: canonicalInput,
        maxOutputTokens: 1024,
        payload: {
          input: canonicalInput,
          max_output_tokens: 1024,
          metadata: { source: "client" },
          prompt_cache_retention: "24h",
          safety_identifier: "client-user",
          store: true,
          stream: false,
          temperature: 0.7,
          top_p: 0.9,
          truncation: "auto",
        },
        temperature: 0.7,
      },
      target: { apiKey: "k", baseUrl: "http://provider.test/v1", modelId: "m" },
    });

    expect(result?.ok).toBe(true);
    expect(capture.calls[0]?.body).toEqual({
      input: canonicalInput,
      max_output_tokens: 1024,
      metadata: { source: "client" },
      model: "m",
      prompt_cache_retention: "24h",
      safety_identifier: "client-user",
      store: true,
      stream: false,
      temperature: 0.7,
      top_p: 0.9,
      truncation: "auto",
    });
  });

  it("leaves streaming Codex request bodies unchanged", () => {
    const requestBody = {
      input: [{ content: [{ text: "hello", type: "input_text" }], role: "user" }],
      max_output_tokens: 1024,
      store: true,
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
    };
    expect(
      resolveProviderStreamingDialect("openai_codex").transformBody(requestBody, "responses"),
    ).toBe(requestBody);
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

  it("cancels the readahead reader through the composed stream pipeline when the client side closes", async () => {
    let cancelCalls = 0;
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
    const source = composeGatewayProviderStreamPipeline({
      firstValue: first.value as Uint8Array,
      idleTimeoutMs: 10_000,
      lease: undefined,
      reader,
    });
    const wrapped = wrapProviderStreamWithActivityCompletion(source, {
      completeActivity: async () => undefined,
      statusCode: 200,
    });

    wrapped.resume();
    await delay(10);
    wrapped.destroy();
    await waitFor(() => cancelCalls === 1);
  });
});

function createHangingFetch(): typeof fetch {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
}

function createJsonCaptureFetch(): {
  calls: Array<{ body: unknown; url: string }>;
  fetch: typeof fetch;
} {
  const calls: Array<{ body: unknown; url: string }> = [];
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
      });
      return new Response(JSON.stringify({ output: [] }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    },
  };
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
