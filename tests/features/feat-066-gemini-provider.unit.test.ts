import { describe, expect, it } from "vitest";
import {
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { createGeminiProviderAdapter } from "../../packages/provider/src/adapters/gemini";

const geminiBaseUrl = "https://generativelanguage.googleapis.com/v1beta";

describe("feat-066 Google Gemini API key provider", () => {
  it("exposes Gemini as a fixed remote API-key template", () => {
    const remoteGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "remote_api_key",
    );

    expect(remoteGroup?.templates).toEqual(
      expect.arrayContaining([
        {
          auth: {
            header: "x-goog-api-key",
            scheme: "API key",
          },
          baseUrlMode: "fixed_remote",
          capabilities: ["chat_completions"],
          displayName: "Google Gemini",
          fixedBaseUrl: geminiBaseUrl,
          id: "gemini",
          providerKey: "gemini",
          providerType: "api_key",
        },
      ]),
    );
    expect(normalizeProviderTemplateFormInput({ templateId: "gemini" })).toMatchObject({
      baseUrl: geminiBaseUrl,
      displayName: "Google Gemini",
      providerKey: "gemini",
      providerType: "api_key",
    });
    expect(() =>
      normalizeProviderFormInput({
        baseUrl: geminiBaseUrl,
        displayName: "Google Gemini",
        providerKey: "gemini",
        providerType: "api_key",
      }),
    ).toThrow(/template/i);
  });

  it("maps OpenAI chat requests to Gemini generateContent and returns OpenAI-compatible chat", async () => {
    const calls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    const adapter = createGeminiProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          headers: new Headers(init?.headers),
          url: String(url),
        });

        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  role: "model",
                  parts: [{ text: "gemini response" }],
                },
                finishReason: "STOP",
                index: 0,
              },
            ],
            responseId: "gemini-response-id",
            usageMetadata: {
              candidatesTokenCount: 3,
              promptTokenCount: 7,
              totalTokenCount: 10,
            },
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
        maxOutputTokens: 128,
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "hello" },
          { role: "assistant", content: "hi" },
          { role: "user", content: "continue" },
        ],
        temperature: 0.2,
      },
      target: {
        apiKey: "gemini-unit-secret",
        baseUrl: geminiBaseUrl,
        modelId: "gemini-3.5-flash",
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      body: {
        contents: [
          { parts: [{ text: "hello" }], role: "user" },
          { parts: [{ text: "hi" }], role: "model" },
          { parts: [{ text: "continue" }], role: "user" },
        ],
        generationConfig: {
          maxOutputTokens: 128,
          temperature: 0.2,
        },
        systemInstruction: {
          parts: [{ text: "Be concise." }],
        },
      },
      url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
    });
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.headers.get("x-goog-api-key")).toBe("gemini-unit-secret");
    expect(result).toEqual({
      body: {
        choices: [
          {
            finish_reason: "stop",
            index: 0,
            message: { content: "gemini response", role: "assistant" },
          },
        ],
        id: "gemini-response-id",
        model: "gemini-3.5-flash",
        object: "chat.completion",
        usage: {
          completion_tokens: 3,
          prompt_tokens: 7,
          total_tokens: 10,
        },
      },
      ok: true,
      providerRequestId: "gemini-response-id",
      statusCode: 200,
    });
  });

  it("maps Gemini errors to provider error codes", async () => {
    const adapter = createGeminiProviderAdapter({
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 403,
              message: "API key does not have permission",
              status: "PERMISSION_DENIED",
            },
          }),
          {
            headers: { "content-type": "application/json" },
            status: 403,
          },
        ),
    });

    await expect(
      adapter.chatCompletion({
        request: {
          messages: [{ role: "user", content: "hello" }],
        },
        target: {
          apiKey: "gemini-unit-secret",
          baseUrl: geminiBaseUrl,
          modelId: "gemini-3.5-flash",
        },
      }),
    ).resolves.toEqual({
      body: {
        error: {
          code: 403,
          message: "API key does not have permission",
          status: "PERMISSION_DENIED",
        },
      },
      errorCode: "gemini_PERMISSION_DENIED",
      errorMessage: "API key does not have permission",
      ok: false,
      retryable: false,
      statusCode: 403,
    });
  });

  it("declares the Gemini provider template id in a follow-up migration", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0012");

    expect(migration).toMatchObject({
      id: "0012",
      name: "gemini_provider",
    });
    expect(migration?.sql).toContain("'gemini'");
    expect(migration?.sql).toContain("'openrouter'");
  });
});
