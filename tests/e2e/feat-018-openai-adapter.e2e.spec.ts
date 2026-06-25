import { expect, test } from "@playwright/test";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";
import { createFakeProviderServer } from "../support/fake-provider";

test("openai adapter sends compatible payload auth header and maps response error", async () => {
  const server = await createFakeProviderServer();
  const adapter = createOpenAIProviderAdapter();

  try {
    const success = await adapter.chatCompletion({
      request: {
        maxOutputTokens: 64,
        messages: [{ role: "user", content: "Say hi" }],
        stream: false,
      },
      target: {
        apiKey: "sk-openai-adapter-e2e",
        baseUrl: `${server.url}/v1`,
        modelId: "gpt-4.1-mini",
      },
    });

    expect(success).toMatchObject({
      body: {
        choices: [{ message: { content: "fake provider response" } }],
        id: "fake-provider-response",
      },
      ok: true,
      providerRequestId: "fake-provider-response",
      statusCode: 200,
    });
    expect(server.requests[0]).toMatchObject({
      bodyJson: {
        max_tokens: 64,
        messages: [{ role: "user", content: "Say hi" }],
        model: "gpt-4.1-mini",
        stream: false,
      },
      method: "POST",
      path: "/v1/chat/completions",
    });
    expect(server.requests[0]?.headers.authorization).toBe("Bearer sk-openai-adapter-e2e");

    const error = await adapter.chatCompletion({
      request: {
        messages: [{ role: "user", content: "fail" }],
      },
      target: {
        apiKey: "sk-openai-adapter-e2e",
        baseUrl: `${server.url}/v1?mode=error`,
        modelId: "gpt-4.1-mini",
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
      path: "/v1/chat/completions",
    });
  } finally {
    await server.close();
  }
});
