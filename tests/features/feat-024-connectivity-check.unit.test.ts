import { describe, expect, it } from "vitest";
import {
  checkProviderConnectivity,
  selectProviderProbeModel,
} from "../../packages/provider/src/connectivity";

describe("feat-024 provider connectivity check", () => {
  it("selects a deterministic low-cost ordinary chat probe model", () => {
    expect(
      selectProviderProbeModel([
        {
          contextWindow: 8192,
          inputUsdPerMillionTokens: "0.02",
          modelId: "text-embedding-3-small",
          outputUsdPerMillionTokens: "0.02",
        },
        {
          contextWindow: 128_000,
          inputUsdPerMillionTokens: "2.50",
          modelId: "gpt-4o",
          outputUsdPerMillionTokens: "10.00",
        },
        {
          contextWindow: 128_000,
          inputUsdPerMillionTokens: "0.15",
          modelId: "gpt-4o-mini",
          outputUsdPerMillionTokens: "0.60",
        },
      ]),
    ).toBe("gpt-4o-mini");
  });

  it("selects cheaper lightweight Qwen-style models without provider-specific ids", () => {
    expect(
      selectProviderProbeModel([
        {
          contextWindow: 128_000,
          inputUsdPerMillionTokens: "0.60",
          modelId: "qwen3-max",
          outputUsdPerMillionTokens: "2.40",
        },
        {
          contextWindow: 1_000_000,
          inputUsdPerMillionTokens: "0.05",
          modelId: "qwen-turbo",
          outputUsdPerMillionTokens: "0.20",
        },
        {
          contextWindow: 128_000,
          inputUsdPerMillionTokens: "0.01",
          modelId: "qwen-vl-plus",
          outputUsdPerMillionTokens: "0.01",
        },
      ]),
    ).toBe("qwen-turbo");
  });

  it("ranks OpenAI reasoning-style models behind ordinary low-cost chat models", () => {
    expect(
      selectProviderProbeModel([
        {
          contextWindow: 128_000,
          inputUsdPerMillionTokens: "0.15",
          modelId: "o3-mini",
          outputUsdPerMillionTokens: "0.60",
        },
        {
          contextWindow: 128_000,
          inputUsdPerMillionTokens: "0.15",
          modelId: "gpt-4o-mini",
          outputUsdPerMillionTokens: "0.60",
        },
      ]),
    ).toBe("gpt-4o-mini");
  });

  it("refuses provider probe selection when only non-chat models are available", () => {
    expect(
      selectProviderProbeModel([
        { contextWindow: 8192, modelId: "gpt-image-1" },
        { contextWindow: 8192, modelId: "text-embedding-3-small" },
        { contextWindow: 128_000, modelId: "qwen-vl-plus" },
      ]),
    ).toBeNull();
  });

  it("returns a healthy result for a reachable OpenAI-compatible provider", async () => {
    const requests: Array<{ body: unknown; headers: HeadersInit | undefined; url: string }> = [];
    const result = await checkProviderConnectivity({
      apiKey: "sk-test-connectivity",
      fetch: async (url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          headers: init?.headers,
          url: String(url),
        });
        return jsonResponse(200, {
          id: "fake-provider-response",
          choices: [{ message: { content: "ok" } }],
        });
      },
      nowMs: sequenceNow(100, 142),
      provider: {
        baseUrl: "http://provider.test/v1",
        displayName: "Fake Provider",
        id: "provider-success",
        modelId: "gpt-4o-mini",
        providerKey: "openai-compatible",
      },
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      checkedAt: "1970-01-01T00:00:00.100Z",
      errorCode: null,
      errorMessage: null,
      latencyMs: 42,
      ok: true,
      probeModelId: "gpt-4o-mini",
      providerId: "provider-success",
      providerKey: "openai-compatible",
      retryable: false,
      status: "healthy",
      statusCode: 200,
    });
    expect(requests).toEqual([
      {
        body: {
          max_tokens: 1,
          messages: [{ content: "ping", role: "user" }],
          model: "gpt-4o-mini",
          stream: false,
        },
        headers: {
          authorization: "Bearer sk-test-connectivity",
          "content-type": "application/json",
        },
        url: "http://provider.test/v1/chat/completions",
      },
    ]);
  });

  it("probes local OpenAI-compatible providers without an API key", async () => {
    const requests: Array<{ headers: HeadersInit | undefined; url: string }> = [];
    const result = await checkProviderConnectivity({
      apiKey: null,
      fetch: async (url, init) => {
        requests.push({ headers: init?.headers, url: String(url) });
        return jsonResponse(200, {
          choices: [{ message: { content: "ok" } }],
          id: "local-provider-response",
        });
      },
      provider: {
        baseUrl: "http://127.0.0.1:11434/v1",
        displayName: "Ollama",
        id: "local-provider",
        modelId: "llama3.2:3b",
        providerKey: "ollama",
      },
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(requests).toEqual([
      {
        headers: {
          "content-type": "application/json",
        },
        url: "http://127.0.0.1:11434/v1/chat/completions",
      },
    ]);
  });

  it("uses max_completion_tokens only for OpenAI reasoning-style probe requests", async () => {
    const requests: Array<{ body: unknown }> = [];
    await checkProviderConnectivity({
      apiKey: "sk-test-connectivity",
      fetch: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)) });
        return jsonResponse(200, {
          choices: [{ message: { content: "ok" } }],
          id: "fake-provider-response",
        });
      },
      nowMs: sequenceNow(400, 421),
      provider: {
        baseUrl: "http://provider.test/v1",
        displayName: "OpenAI",
        id: "provider-openai",
        modelId: "selected-reasoning-model",
        providerKey: "openai",
      },
      timeoutMs: 1_000,
    });

    expect(requests).toEqual([
      {
        body: {
          max_completion_tokens: 1,
          messages: [{ content: "ping", role: "user" }],
          model: "selected-reasoning-model",
          stream: false,
        },
      },
    ]);
  });

  it("returns structured failures for bad credentials and timeout", async () => {
    const badCredentials = await checkProviderConnectivity({
      apiKey: "bad-provider-key",
      fetch: async () =>
        jsonResponse(401, {
          error: {
            code: "invalid_api_key",
            message: "Invalid API key",
          },
        }),
      nowMs: sequenceNow(200, 212),
      provider: {
        baseUrl: "http://provider.test/v1",
        displayName: "Fake Provider",
        id: "provider-bad-key",
        modelId: "gpt-4o-mini",
        providerKey: "openai",
      },
      timeoutMs: 1_000,
    });

    expect(badCredentials).toMatchObject({
      errorCode: "invalid_api_key",
      errorMessage: "Invalid API key",
      ok: false,
      providerId: "provider-bad-key",
      retryable: false,
      status: "auth_failed",
      statusCode: 401,
    });

    const timeout = await checkProviderConnectivity({
      apiKey: "sk-test-connectivity",
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("Provider connectivity check timed out."));
          });
        }),
      nowMs: sequenceNow(300, 375),
      provider: {
        baseUrl: "http://provider.test/v1",
        displayName: "Fake Provider",
        id: "provider-timeout",
        modelId: "gpt-4o-mini",
        providerKey: "openai",
      },
      timeoutMs: 1,
    });

    expect(timeout).toMatchObject({
      errorCode: "provider_probe_timeout",
      ok: false,
      providerId: "provider-timeout",
      retryable: true,
      status: "network_error",
      statusCode: null,
    });
  });

  it("classifies provider quota errors from Gemini-style array error bodies", async () => {
    const result = await checkProviderConnectivity({
      apiKey: "quota-provider-key",
      fetch: async () =>
        jsonResponse(429, [
          {
            error: {
              code: 429,
              message: "Quota exceeded for metric generate_content_free_tier_requests.",
              status: "RESOURCE_EXHAUSTED",
            },
          },
        ]),
      nowMs: sequenceNow(500, 518),
      provider: {
        baseUrl: "http://provider.test/v1",
        displayName: "Quota Provider",
        id: "provider-quota",
        modelId: "selected-chat-model",
        providerKey: "google",
      },
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      errorCode: "RESOURCE_EXHAUSTED",
      errorMessage: "Quota exceeded for metric generate_content_free_tier_requests.",
      ok: false,
      providerId: "provider-quota",
      retryable: true,
      status: "quota_limited",
      statusCode: 429,
    });
  });

  it("classifies unrecognized provider HTTP errors as unhealthy", async () => {
    const result = await checkProviderConnectivity({
      apiKey: "sk-test-connectivity",
      fetch: async () =>
        jsonResponse(500, {
          error: {
            code: "provider_overloaded",
            message: "Provider failed to process the request.",
          },
        }),
      nowMs: sequenceNow(600, 633),
      provider: {
        baseUrl: "http://provider.test/v1",
        displayName: "Generic Provider",
        id: "provider-generic-error",
        modelId: "selected-chat-model",
        providerKey: "openai-compatible",
      },
      timeoutMs: 1_000,
    });

    expect(result).toMatchObject({
      errorCode: "provider_overloaded",
      errorMessage: "Provider failed to process the request.",
      ok: false,
      providerId: "provider-generic-error",
      retryable: true,
      status: "unhealthy",
      statusCode: 500,
    });
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function sequenceNow(...values: number[]): () => number {
  return () => values.shift() ?? 0;
}
