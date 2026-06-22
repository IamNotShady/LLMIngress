import { describe, expect, it } from "vitest";
import {
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";

const localOpenAICompatibleTemplates = [
  ["ollama", "Ollama", "http://127.0.0.1:11434/v1"],
  ["lmstudio", "LM Studio", "http://127.0.0.1:1234/v1"],
  ["llama_cpp", "llama.cpp", "http://127.0.0.1:8080/v1"],
] as const;

describe("feat-064 local provider templates", () => {
  it("lists local templates with fixed OpenAI-compatible paths", () => {
    const localGroup = listProviderTemplateSelectorGroups().find((group) => group.id === "local");

    expect(localGroup).toMatchObject({
      id: "local",
      label: "Local",
    });
    expect(localGroup?.templates).toEqual(
      expect.arrayContaining(
        localOpenAICompatibleTemplates.map(([id, displayName, baseUrlPlaceholder]) => ({
          baseUrlMode: "user_local_private",
          baseUrlPlaceholder,
          capabilities: ["chat_completions", "streaming", "tools"],
          chatPath: "/chat/completions",
          displayName,
          id,
          modelListPath: "/models",
          providerKey: id,
          providerType: "local",
        })),
      ),
    );
  });

  it("accepts local, private, and public URLs", () => {
    for (const [id] of localOpenAICompatibleTemplates) {
      expect(
        normalizeProviderTemplateFormInput({
          baseUrl: "http://127.0.0.1:1234/v1",
          templateId: id,
        }),
      ).toMatchObject({
        baseUrl: "http://127.0.0.1:1234/v1",
        providerKey: id,
        providerTemplateId: id,
        providerType: "local",
      });

      expect(
        normalizeProviderTemplateFormInput({
          baseUrl: "http://192.168.1.25:8080/v1/",
          templateId: id,
        }),
      ).toMatchObject({
        baseUrl: "http://192.168.1.25:8080/v1",
        providerKey: id,
        providerTemplateId: id,
        providerType: "local",
      });

      expect(
        normalizeProviderTemplateFormInput({
          baseUrl: `https://${id}.example.com/v1`,
          templateId: id,
        }),
      ).toMatchObject({
        baseUrl: `https://${id}.example.com/v1`,
        providerKey: id,
        providerTemplateId: id,
        providerType: "local",
      });

      expect(() =>
        normalizeProviderFormInput({
          baseUrl: "http://127.0.0.1:1234/v1",
          displayName: id,
          providerKey: id,
          providerType: "local",
        }),
      ).toThrow(/template/i);
    }
  });

  it("uses OpenAI-compatible template chat path when routed through the generic adapter", async () => {
    const calls: Array<{ body: unknown; headers: Headers; method: string; url: string }> = [];
    const adapter = createOpenAIProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          url: String(url),
        });

        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "local response", role: "assistant" } }],
            id: "local-openai-compatible-response",
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
        messages: [{ role: "user", content: "hello local" }],
        stream: false,
      },
      target: {
        apiKey: "sk-local-placeholder",
        baseUrl: "http://127.0.0.1:1234/v1",
        modelId: "local-model",
      },
    });

    expect(calls).toEqual([
      {
        body: {
          messages: [{ role: "user", content: "hello local" }],
          model: "local-model",
          stream: false,
        },
        headers: expect.any(Headers),
        method: "POST",
        url: "http://127.0.0.1:1234/v1/chat/completions",
      },
    ]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer sk-local-placeholder");
    expect(result).toMatchObject({
      ok: true,
      providerRequestId: "local-openai-compatible-response",
      statusCode: 200,
    });
  });

  it("does not send Authorization for local OpenAI-compatible requests without a key", async () => {
    const calls: Array<{ headers: Headers }> = [];
    const adapter = createOpenAIProviderAdapter({
      fetch: async (_url, init) => {
        calls.push({ headers: new Headers(init?.headers) });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "local response", role: "assistant" } }],
            id: "local-openai-compatible-response",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    await adapter.chatCompletion({
      request: {
        messages: [{ role: "user", content: "hello local" }],
        stream: false,
      },
      target: {
        apiKey: null,
        baseUrl: "http://127.0.0.1:1234/v1",
        modelId: "local-model",
      },
    });

    expect(calls[0]?.headers.get("authorization")).toBeNull();
  });

  it("declares LM Studio and llama.cpp template ids in a follow-up migration", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0010");

    expect(migration).toMatchObject({
      id: "0010",
      name: "local_provider_templates",
    });
    expect(migration?.sql).toContain("'lmstudio'");
    expect(migration?.sql).toContain("'llama_cpp'");
    expect(migration?.sql).toContain("'ollama'");
  });
});
