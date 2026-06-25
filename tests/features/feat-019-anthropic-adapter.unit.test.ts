import { describe, expect, it } from "vitest";
import { createAnthropicProviderAdapter } from "../../packages/provider/src/adapters/anthropic";

describe("feat-019 Anthropic provider adapter", () => {
  it("sends normalized messages requests as Anthropic payloads with auth headers", async () => {
    const calls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    const adapter = createAnthropicProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return new Response(
          JSON.stringify({
            id: "msg_unit",
            type: "message",
            role: "assistant",
            content: [{ type: "text", text: "unit response" }],
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    const result = await adapter.messages({
      request: {
        maxOutputTokens: 512,
        messages: [{ role: "user", content: "hello" }],
        stream: false,
        system: "You are concise.",
        temperature: 0.2,
      },
      target: {
        apiKey: "sk-ant-unit-secret",
        baseUrl: "https://anthropic.example/v1",
        modelId: "claude-sonnet-4-5",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      body: {
        max_tokens: 512,
        messages: [{ role: "user", content: "hello" }],
        model: "claude-sonnet-4-5",
        stream: false,
        system: "You are concise.",
        temperature: 0.2,
      },
      url: "https://anthropic.example/v1/messages",
    });
    expect(calls[0]?.headers.get("x-api-key")).toBe("sk-ant-unit-secret");
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(result).toMatchObject({
      body: { id: "msg_unit" },
      ok: true,
      providerRequestId: "msg_unit",
      statusCode: 200,
    });
  });

  it("maps Anthropic provider errors into Gateway error results", async () => {
    const adapter = createAnthropicProviderAdapter({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              type: "overloaded_error",
              message: "Provider overloaded",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 529,
          },
        ),
    });

    const result = await adapter.messages({
      request: {
        maxOutputTokens: 64,
        messages: [{ role: "user", content: "hello" }],
      },
      target: {
        apiKey: "sk-ant-unit-secret",
        baseUrl: "https://anthropic.example/v1",
        modelId: "claude-sonnet-4-5",
      },
    });

    expect(result).toEqual({
      body: {
        error: {
          message: "Provider overloaded",
          type: "overloaded_error",
        },
      },
      errorCode: "overloaded_error",
      errorMessage: "Provider overloaded",
      ok: false,
      retryable: true,
      statusCode: 529,
    });
  });
});
