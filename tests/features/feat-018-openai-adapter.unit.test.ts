import { describe, expect, it } from "vitest";
import { createOpenAIProviderAdapter } from "../../apps/gateway/src/provider-adapters/openai";

describe("feat-018 OpenAI provider adapter", () => {
  it("sends normalized chat requests as OpenAI-compatible payloads with bearer auth", async () => {
    const calls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    const adapter = createOpenAIProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return new Response(
          JSON.stringify({
            id: "chatcmpl-unit",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "unit response" } }],
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    const result = await adapter.chatCompletion({
      request: {
        maxOutputTokens: 321,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        temperature: 0.2,
      },
      target: {
        apiKey: "sk-openai-unit-secret",
        baseUrl: "https://provider.example/v1",
        modelId: "gpt-4.1-mini",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      body: {
        max_tokens: 321,
        messages: [{ role: "user", content: "hello" }],
        model: "gpt-4.1-mini",
        stream: false,
        temperature: 0.2,
      },
      url: "https://provider.example/v1/chat/completions",
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-openai-unit-secret");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(result).toMatchObject({
      body: { id: "chatcmpl-unit" },
      ok: true,
      providerRequestId: "chatcmpl-unit",
      statusCode: 200,
    });
  });

  it("maps provider error responses into Gateway error results", async () => {
    const adapter = createOpenAIProviderAdapter({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "rate_limit_exceeded",
              message: "Rate limit exceeded",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 429,
          },
        ),
    });

    const result = await adapter.chatCompletion({
      request: {
        messages: [{ role: "user", content: "hello" }],
      },
      target: {
        apiKey: "sk-openai-unit-secret",
        baseUrl: "https://provider.example/v1",
        modelId: "gpt-4.1-mini",
      },
    });

    expect(result).toEqual({
      body: {
        error: {
          code: "rate_limit_exceeded",
          message: "Rate limit exceeded",
        },
      },
      errorCode: "rate_limit_exceeded",
      errorMessage: "Rate limit exceeded",
      ok: false,
      retryable: true,
      statusCode: 429,
    });
  });
});
