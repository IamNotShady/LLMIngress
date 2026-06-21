import { describe, expect, it } from "vitest";
import {
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { createOpenRouterProviderAdapter } from "../../packages/provider/src/adapters/openrouter";
import { buildProviderModelListRequest } from "../../packages/provider/src/model-list";

const openRouterBaseUrl = "https://openrouter.ai/api/v1";

describe("feat-065 OpenRouter API key provider", () => {
  it("exposes OpenRouter as a fixed remote API-key template", () => {
    const remoteGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );

    expect(remoteGroup?.templates).toEqual(
      expect.arrayContaining([
        {
          auth: {
            header: "Authorization",
            scheme: "Bearer",
          },
          baseUrlMode: "fixed_remote",
          capabilities: ["chat_completions", "streaming", "tools"],
          displayName: "OpenRouter",
          fixedBaseUrl: openRouterBaseUrl,
          id: "openrouter",
          providerKey: "openrouter",
          providerType: "api_key",
        },
      ]),
    );
    expect(normalizeProviderTemplateFormInput({ templateId: "openrouter" })).toMatchObject({
      baseUrl: openRouterBaseUrl,
      displayName: "OpenRouter",
      providerKey: "openrouter",
      providerType: "api_key",
    });
    expect(() =>
      normalizeProviderFormInput({
        baseUrl: openRouterBaseUrl,
        displayName: "OpenRouter",
        providerKey: "openrouter",
        providerType: "api_key",
      }),
    ).toThrow(/template/i);
  });

  it("sends OpenRouter attribution headers and maps numeric OpenRouter errors", async () => {
    const calls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    const adapter = createOpenRouterProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          headers: new Headers(init?.headers),
          url: String(url),
        });

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "openrouter response", role: "assistant" } }],
            id: "gen-openrouter-unit",
            object: "chat.completion",
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
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
      target: {
        apiKey: "sk-or-v1-unit-secret",
        baseUrl: openRouterBaseUrl,
        modelId: "openai/gpt-4o-mini",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      body: {
        messages: [{ role: "user", content: "hello" }],
        model: "openai/gpt-4o-mini",
        stream: false,
      },
      url: "https://openrouter.ai/api/v1/chat/completions",
    });
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-or-v1-unit-secret");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("http-referer")).toBe("https://llmingress.local");
    expect(calls[0]?.headers.get("x-openrouter-title")).toBe("LLMIngress");
    expect(result).toMatchObject({
      body: { id: "gen-openrouter-unit" },
      ok: true,
      providerRequestId: "gen-openrouter-unit",
      statusCode: 200,
    });

    const errorAdapter = createOpenRouterProviderAdapter({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 402,
              message: "OpenRouter account has insufficient credits",
              metadata: { provider_name: "OpenRouter" },
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 402,
          },
        ),
    });
    const errorResult = await errorAdapter.chatCompletion({
      request: {
        messages: [{ role: "user", content: "hello" }],
      },
      target: {
        apiKey: "sk-or-v1-unit-secret",
        baseUrl: openRouterBaseUrl,
        modelId: "openai/gpt-4o-mini",
      },
    });

    expect(errorResult).toEqual({
      body: {
        error: {
          code: 402,
          message: "OpenRouter account has insufficient credits",
          metadata: { provider_name: "OpenRouter" },
        },
      },
      errorCode: "openrouter_402",
      errorMessage: "OpenRouter account has insufficient credits",
      ok: false,
      retryable: false,
      statusCode: 402,
    });
  });

  it("builds OpenRouter model refresh requests with API key and attribution headers", () => {
    expect(
      buildProviderModelListRequest({
        apiKey: "sk-or-v1-refresh-secret",
        baseUrl: openRouterBaseUrl,
        providerKey: "openrouter",
      }),
    ).toEqual({
      init: {
        headers: {
          "HTTP-Referer": "https://llmingress.local",
          "X-OpenRouter-Title": "LLMIngress",
          authorization: "Bearer sk-or-v1-refresh-secret",
        },
        method: "GET",
      },
      url: "https://openrouter.ai/api/v1/models",
    });
  });

  it("declares the OpenRouter provider template id in a follow-up migration", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0011");

    expect(migration).toMatchObject({
      id: "0011",
      name: "openrouter_provider",
    });
    expect(migration?.sql).toContain("'openrouter'");
    expect(migration?.sql).toContain("'lmstudio'");
    expect(migration?.sql).toContain("'llama_cpp'");
  });
});
