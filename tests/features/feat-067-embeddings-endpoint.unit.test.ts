import { describe, expect, it } from "vitest";
import {
  buildOpenAIEmbeddingsRequestMetadata,
  createGatewayEmbeddingsProviderAdapter,
  normalizeOpenAIEmbeddingsRequest,
} from "../../apps/gateway/src/embeddings";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";

describe("feat-067 embeddings endpoint", () => {
  it("normalizes embeddings requests and estimates input-only usage metadata", () => {
    const normalized = normalizeOpenAIEmbeddingsRequest(
      {
        dimensions: 256,
        encoding_format: "float",
        input: ["hello embeddings", "second text"],
        model: "embedding-coding",
      },
      "req_embeddings_unit",
    );

    expect(normalized).toEqual({
      ok: true,
      request: {
        dimensions: 256,
        encodingFormat: "float",
        input: ["hello embeddings", "second text"],
      },
    });
    expect(
      normalized.ok
        ? buildOpenAIEmbeddingsRequestMetadata({
            model: "embedding-coding",
            request: normalized.request,
          })
        : null,
    ).toEqual({
      estimatedInputTokens: 7,
      estimatedOutputTokens: 0,
      messageCount: 2,
      model: "embedding-coding",
      protocol: "embeddings",
      stream: false,
      usesTools: false,
    });
  });

  it("rejects invalid embeddings request bodies", () => {
    expect(
      normalizeOpenAIEmbeddingsRequest(
        {
          input: "",
          model: "embedding-coding",
        },
        "req_bad_embeddings",
      ),
    ).toEqual({
      body: {
        error: {
          code: "invalid_embeddings_request",
          message: "Embeddings request must include non-empty input text.",
        },
        requestId: "req_bad_embeddings",
      },
      ok: false,
      statusCode: 400,
    });
  });

  it("sends OpenAI-compatible embeddings requests to the provider", async () => {
    const calls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    const adapter = createOpenAIProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          headers: new Headers(init?.headers),
          url: String(url),
        });

        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2], index: 0, object: "embedding" }],
            model: "text-embedding-3-small",
            object: "list",
            usage: { prompt_tokens: 5, total_tokens: 5 },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    const result = await adapter.embeddings?.({
      request: {
        dimensions: 256,
        encodingFormat: "float",
        input: ["hello embeddings"],
      },
      target: {
        apiKey: "sk-embeddings-unit",
        baseUrl: "https://api.openai.com/v1",
        modelId: "text-embedding-3-small",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      body: {
        dimensions: 256,
        encoding_format: "float",
        input: ["hello embeddings"],
        model: "text-embedding-3-small",
      },
      url: "https://api.openai.com/v1/embeddings",
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-embeddings-unit");
    expect(result).toMatchObject({
      body: {
        data: [{ embedding: [0.1, 0.2], index: 0, object: "embedding" }],
        model: "text-embedding-3-small",
        object: "list",
      },
      ok: true,
      statusCode: 200,
    });
  });

  it("uses the OpenRouter adapter for OpenRouter embeddings routes", async () => {
    const calls: Array<{ headers: Headers; url: string }> = [];
    const adapter = createGatewayEmbeddingsProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          headers: new Headers(init?.headers),
          url: String(url),
        });

        return new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2], index: 0, object: "embedding" }],
            model: "openai/text-embedding-3-small",
            object: "list",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
      providerKey: "openrouter",
    });

    await adapter.embeddings?.({
      request: {
        input: "hello openrouter embeddings",
      },
      target: {
        apiKey: "sk-or-unit",
        baseUrl: "https://openrouter.ai/api/v1",
        modelId: "openai/text-embedding-3-small",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/embeddings");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-or-unit");
    expect(calls[0]?.headers.get("http-referer")).toBe("https://llmingress.local");
    expect(calls[0]?.headers.get("x-openrouter-title")).toBe("LLMIngress");
  });
});
