import { describe, expect, it } from "vitest";
import { checkProviderConnectivity } from "../../apps/worker/src/provider-connectivity-check";

describe("feat-024 provider connectivity check", () => {
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
        providerKey: "openai",
      },
      timeoutMs: 1_000,
    });

    expect(result).toEqual({
      checkedAt: "1970-01-01T00:00:00.100Z",
      errorCode: null,
      errorMessage: null,
      latencyMs: 42,
      ok: true,
      providerId: "provider-success",
      providerKey: "openai",
      retryable: false,
      status: "healthy",
      statusCode: 200,
    });
    expect(requests).toEqual([
      {
        body: {
          max_tokens: 1,
          messages: [{ content: "ping", role: "user" }],
          model: "connectivity-check",
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
      status: "failed",
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
        providerKey: "openai",
      },
      timeoutMs: 1,
    });

    expect(timeout).toMatchObject({
      errorCode: "provider_probe_timeout",
      ok: false,
      providerId: "provider-timeout",
      retryable: true,
      status: "failed",
      statusCode: null,
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
