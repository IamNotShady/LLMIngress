import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAnthropicProviderAdapter } from "../../packages/provider/src/adapters/anthropic";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";
import { checkProviderConnectivity } from "../../packages/provider/src/connectivity";
import { fetchListedProviderModels } from "../../packages/provider/src/model-list";

describe("provider authenticated HTTP safety", () => {
  it("routes Gateway streaming provider fetches through the credentialed helper", () => {
    const source = readFileSync("packages/gateway-runtime/src/gateway-streaming.ts", "utf8");
    expect(source).toContain("@llmingress/provider/authenticated-http");
    expect(source).toContain("fetchCredentialedProviderRequest(");
    expect(source).toContain("provider_redirect_rejected");
  });

  it("rejects credentialed OpenAI adapter redirects without following them", async () => {
    const calls: Array<{ init: RequestInit; url: string }> = [];
    const adapter = createOpenAIProviderAdapter({
      fetch: async (url, init) => {
        calls.push({ init: init ?? {}, url: String(url) });
        return new Response(null, {
          headers: { location: "https://redirect-target.test/leak" },
          status: 302,
        });
      },
    });

    const result = await adapter.chatCompletion({
      request: {
        messages: [{ content: "hello", role: "user" }],
        payload: { messages: [{ content: "hello", role: "user" }] },
      },
      target: {
        apiKey: "sk-provider-secret",
        baseUrl: "https://provider.test/v1",
        modelId: "gpt-test",
      },
    });

    expect(calls[0]?.init.redirect).toBe("manual");
    expect(result).toMatchObject({
      errorCode: "provider_redirect_rejected",
      ok: false,
      retryable: false,
      statusCode: 302,
    });
  });

  it("rejects credentialed model-list redirects with a stable error code", async () => {
    const calls: RequestInit[] = [];

    await expect(
      fetchListedProviderModels({
        apiKey: "sk-provider-secret",
        baseUrl: "https://provider.test/v1",
        fetch: async (_url, init) => {
          calls.push(init ?? {});
          return new Response(null, {
            headers: { location: "https://redirect-target.test/models" },
            status: 307,
          });
        },
        providerKey: "openai",
      }),
    ).rejects.toMatchObject({
      code: "provider_redirect_rejected",
      statusCode: 307,
    });

    expect(calls[0]?.redirect).toBe("manual");
  });

  it("refuses redirects on the model-list no-apiKey branch", async () => {
    const calls: RequestInit[] = [];

    await expect(
      fetchListedProviderModels({
        baseUrl: "https://provider.test/v1",
        fetch: async (_url, init) => {
          calls.push(init ?? {});
          return new Response(null, {
            headers: { location: "https://redirect-target.test/models" },
            status: 302,
          });
        },
        providerKey: "openai",
      }),
    ).rejects.toMatchObject({
      code: "provider_redirect_rejected",
      statusCode: 302,
    });

    expect(calls[0]?.redirect).toBe("manual");
  });

  it("times out a model-list fetch that never resolves", async () => {
    const neverResolving: typeof globalThis.fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });

    await expect(
      fetchListedProviderModels({
        apiKey: "sk-provider-secret",
        baseUrl: "https://provider.test/v1",
        fetch: neverResolving,
        providerKey: "openai",
        timeoutMs: 20,
      }),
    ).rejects.toMatchObject({
      code: "provider_request_timeout",
    });
  });

  it("uses the official Anthropic messages probe shape without Bearer Authorization", async () => {
    const calls: Array<{ body: unknown; headers: Headers; init: RequestInit; url: string }> = [];
    const result = await checkProviderConnectivity({
      apiKey: "sk-ant-provider-secret",
      fetch: async (url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
          init: init ?? {},
          url: String(url),
        });
        return Response.json({ id: "msg_probe" });
      },
      provider: {
        baseUrl: "https://api.anthropic.com/v1",
        displayName: "Anthropic",
        id: "provider-anthropic",
        modelId: "claude-3-5-sonnet-latest",
        providerKey: "anthropic",
      },
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(calls[0]?.headers.get("x-api-key")).toBe("sk-ant-provider-secret");
    expect(calls[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(calls[0]?.headers.get("authorization")).toBeNull();
    expect(calls[0]?.body).toMatchObject({
      max_tokens: 1,
      messages: [{ content: "ping", role: "user" }],
      model: "claude-3-5-sonnet-latest",
    });
  });

  it("uses manual redirects for Anthropic adapter x-api-key requests", async () => {
    const calls: RequestInit[] = [];
    const adapter = createAnthropicProviderAdapter({
      fetch: async (_url, init) => {
        calls.push(init ?? {});
        return new Response(null, {
          headers: { location: "https://redirect-target.test/messages" },
          status: 301,
        });
      },
    });

    const result = await adapter.messages({
      request: {
        maxOutputTokens: 1,
        messages: [{ content: "hello", role: "user" }],
        payload: { max_tokens: 1, messages: [{ content: "hello", role: "user" }] },
      },
      target: {
        apiKey: "sk-ant-provider-secret",
        baseUrl: "https://api.anthropic.com/v1",
        modelId: "claude-test",
      },
    });

    expect(calls[0]?.redirect).toBe("manual");
    expect(result).toMatchObject({
      errorCode: "provider_redirect_rejected",
      ok: false,
      retryable: false,
      statusCode: 301,
    });
  });
});
