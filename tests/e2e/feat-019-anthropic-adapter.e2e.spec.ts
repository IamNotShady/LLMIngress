import { expect, test } from "@playwright/test";
import { createAnthropicProviderAdapter } from "../../apps/gateway/src/provider-adapters/anthropic";
import { createFakeProviderServer } from "../support/fake-provider";

test("anthropic adapter sends messages payload auth headers and maps response error", async () => {
  const server = await createFakeProviderServer();
  const adapter = createAnthropicProviderAdapter();

  try {
    const success = await adapter.messages({
      request: {
        maxOutputTokens: 64,
        messages: [{ role: "user", content: "Say hi" }],
        stream: false,
      },
      target: {
        apiKey: "sk-anthropic-adapter-e2e",
        baseUrl: `${server.url}/v1`,
        modelId: "claude-sonnet-4-5",
      },
    });

    expect(success).toMatchObject({
      body: {
        content: [{ text: "fake provider response", type: "text" }],
        id: "fake-provider-message",
        type: "message",
      },
      ok: true,
      providerRequestId: "fake-provider-message",
      statusCode: 200,
    });
    expect(server.requests[0]).toMatchObject({
      bodyJson: {
        max_tokens: 64,
        messages: [{ role: "user", content: "Say hi" }],
        model: "claude-sonnet-4-5",
        stream: false,
      },
      method: "POST",
      path: "/v1/messages",
    });
    expect(server.requests[0]?.headers["x-api-key"]).toBe("sk-anthropic-adapter-e2e");
    expect(server.requests[0]?.headers["anthropic-version"]).toBe("2023-06-01");

    const error = await adapter.messages({
      request: {
        maxOutputTokens: 64,
        messages: [{ role: "user", content: "fail" }],
      },
      target: {
        apiKey: "sk-anthropic-adapter-e2e",
        baseUrl: `${server.url}/v1?mode=error`,
        modelId: "claude-sonnet-4-5",
      },
    });

    expect(error).toEqual({
      body: {
        error: {
          code: "fake_provider_error",
          message: "Fake provider error",
        },
      },
      errorCode: "fake_provider_error",
      errorMessage: "Fake provider error",
      ok: false,
      retryable: true,
      statusCode: 503,
    });
    expect(server.requests[1]).toMatchObject({
      mode: "error",
      path: "/v1/messages",
    });
  } finally {
    await server.close();
  }
});
