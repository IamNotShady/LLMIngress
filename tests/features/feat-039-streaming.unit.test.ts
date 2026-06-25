import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  buildStreamingProviderHeaders,
  buildStreamingProviderRequestBody,
  buildStreamingProviderUrl,
  isStreamingProtocolSupportedByProvider,
  wrapProviderStreamWithErrorRecording,
} from "../../apps/gateway/src/streaming";

describe("feat-039 streaming response passthrough", () => {
  it("uses codex subscription endpoint and headers for streaming responses", () => {
    expect(
      buildStreamingProviderUrl({
        baseUrl: "https://chatgpt.com/backend-api",
        pathSuffix: "responses",
        providerKey: "openai_codex",
      }),
    ).toBe("https://chatgpt.com/backend-api/codex/responses");

    const headers = buildStreamingProviderHeaders({
      apiKey: "sk-codex",
      headersWithApiKey: () => {
        throw new Error("openai_codex should not use generic headers");
      },
      providerKey: "openai_codex",
    });

    expect(headers).toMatchObject({
      authorization: "Bearer sk-codex",
      originator: "codex_cli_rs",
    });
  });

  it("does not treat chat completions as a supported openai codex streaming protocol", () => {
    expect(
      isStreamingProtocolSupportedByProvider({
        pathSuffix: "chat/completions",
        providerKey: "openai_codex",
      }),
    ).toBe(false);
    expect(
      isStreamingProtocolSupportedByProvider({
        pathSuffix: "responses",
        providerKey: "openai_codex",
      }),
    ).toBe(true);
  });

  it("adds required instructions for codex streaming responses", () => {
    expect(
      buildStreamingProviderRequestBody({
        modelId: "gpt-5.4",
        pathSuffix: "responses",
        payload: { input: "hello", store: false },
        providerKey: "openai_codex",
      }),
    ).toEqual({
      input: "hello",
      instructions: "You are a helpful assistant.",
      model: "gpt-5.4",
      store: false,
      stream: true,
    });
  });

  it("strips Codex-unsupported parameters for streaming responses", () => {
    expect(
      buildStreamingProviderRequestBody({
        modelId: "gpt-5.4",
        pathSuffix: "responses",
        payload: {
          input: "hello",
          max_output_tokens: 2048,
          metadata: { agent: "hermes" },
          prompt_cache_retention: "24h",
          safety_identifier: "agent-1",
          temperature: 0.7,
          top_p: 1,
          truncation: "auto",
        },
        providerKey: "openai_codex",
      }),
    ).toEqual({
      input: "hello",
      instructions: "You are a helpful assistant.",
      model: "gpt-5.4",
      store: false,
      stream: true,
    });
  });

  it("injects the Claude Code system identifier for claude_code streaming messages", () => {
    expect(
      buildStreamingProviderRequestBody({
        modelId: "claude-sonnet-4-5",
        pathSuffix: "messages",
        payload: {
          max_tokens: 16,
          messages: [{ content: "ping", role: "user" }],
          system: "You are a helpful assistant.",
        },
        providerKey: "claude_code",
      }),
    ).toEqual({
      max_tokens: 16,
      messages: [{ content: "ping", role: "user" }],
      model: "claude-sonnet-4-5",
      stream: true,
      system: [
        { text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", type: "text" },
        { text: "You are a helpful assistant.", type: "text" },
      ],
    });
  });

  it("forwards provider stream chunks in order", async () => {
    const recordedErrors: unknown[] = [];
    const stream = wrapProviderStreamWithErrorRecording(Readable.from(["first", "second"]), {
      recordRuntimeError: async (error) => {
        recordedErrors.push(error);
      },
    });

    await expect(readStream(stream)).resolves.toBe("firstsecond");
    expect(recordedErrors).toEqual([]);
  });

  it("records mid-stream errors once and propagates the stream failure", async () => {
    const source = new Readable({
      read() {
        this.push("first");
        this.destroy(new Error("provider socket closed mid-stream"));
      },
    });
    const recordedErrors: unknown[] = [];
    const stream = wrapProviderStreamWithErrorRecording(source, {
      recordRuntimeError: async (error) => {
        recordedErrors.push(error);
      },
    });

    await expect(readStream(stream)).rejects.toThrow("provider socket closed mid-stream");
    expect(recordedErrors).toEqual([
      {
        errorCode: "provider_stream_error",
        errorMessage: "provider socket closed mid-stream",
      },
    ]);
  });
});

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
