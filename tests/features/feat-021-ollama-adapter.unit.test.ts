import { describe, expect, it } from "vitest";
import {
  getOllamaProviderTemplate,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { createOllamaProviderAdapter } from "../../packages/provider/src/adapters/ollama";

describe("feat-021 Ollama local provider adapter", () => {
  it("accepts loopback and private Ollama base URLs while public URLs need risk confirmation", () => {
    const template = getOllamaProviderTemplate("ollama");

    expect(template).toEqual({
      baseUrlPlaceholder: "http://127.0.0.1:11434",
      capabilities: ["chat_completions"],
      chatPath: "/api/chat",
      displayName: "Ollama",
      id: "ollama",
      modelListPath: "/api/tags",
      providerKey: "ollama",
      providerType: "local",
    });

    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "http://127.0.0.1:11434",
        templateId: "ollama",
      }),
    ).toMatchObject({
      baseUrl: "http://127.0.0.1:11434",
      providerKey: "ollama",
      providerTemplateId: "ollama",
      providerType: "local",
    });

    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "http://[::1]:11434",
        templateId: "ollama",
      }),
    ).toMatchObject({
      baseUrl: "http://[::1]:11434",
      providerKey: "ollama",
      providerTemplateId: "ollama",
      providerType: "local",
    });

    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "http://[fd00::1]:11434",
        templateId: "ollama",
      }),
    ).toMatchObject({
      baseUrl: "http://[fd00::1]:11434",
      providerKey: "ollama",
      providerTemplateId: "ollama",
      providerType: "local",
    });

    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "http://192.168.1.10:11434",
        templateId: "ollama",
      }),
    ).toMatchObject({
      baseUrl: "http://192.168.1.10:11434",
      providerKey: "ollama",
      providerTemplateId: "ollama",
      providerType: "local",
    });

    expect(() =>
      normalizeProviderTemplateFormInput({
        baseUrl: "https://ollama.example.com",
        templateId: "ollama",
      }),
    ).toThrow(/public network.*risk confirmation/i);

    expect(() =>
      normalizeProviderTemplateFormInput({
        baseUrl: "https://fd.example.com",
        templateId: "ollama",
      }),
    ).toThrow(/public network.*risk confirmation/i);

    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "https://ollama.example.com",
        publicNetworkRiskAccepted: "true",
        templateId: "ollama",
      }),
    ).toMatchObject({
      baseUrl: "https://ollama.example.com",
      providerKey: "ollama",
      providerTemplateId: "ollama",
      providerType: "local",
    });

    expect(() =>
      normalizeProviderFormInput({
        baseUrl: "http://127.0.0.1:11434",
        displayName: "Ollama",
        providerKey: "ollama",
        providerType: "local",
      }),
    ).toThrow(/ollama.*template/i);

    expect(() =>
      normalizeProviderFormInput({
        baseUrl: "http://127.0.0.1:11434",
        displayName: "Custom Local",
        providerKey: "myollama",
        providerType: "local",
      }),
    ).toThrow(/local providers.*template/i);
  });

  it("uses Ollama template paths for model list and chat calls", async () => {
    const calls: Array<{ body: unknown; headers: Headers; method: string; url: string }> = [];
    const adapter = createOllamaProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          headers: new Headers(init?.headers),
          method: init?.method ?? "GET",
          url: String(url),
        });

        if (String(url).endsWith("/api/tags")) {
          return new Response(
            JSON.stringify({
              models: [{ name: "llama3.2:latest", size: 123 }],
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          );
        }

        return new Response(
          JSON.stringify({
            done: true,
            message: { role: "assistant", content: "unit response" },
            model: "llama3.2",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    const models = await adapter.listModels({
      target: {
        baseUrl: "http://127.0.0.1:11434",
      },
    });
    const chat = await adapter.chat({
      request: {
        messages: [{ role: "user", content: "hello" }],
        stream: false,
      },
      target: {
        baseUrl: "http://127.0.0.1:11434",
        modelId: "llama3.2",
      },
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      method: "GET",
      url: "http://127.0.0.1:11434/api/tags",
    });
    expect(calls[1]).toMatchObject({
      body: {
        messages: [{ role: "user", content: "hello" }],
        model: "llama3.2",
        stream: false,
      },
      method: "POST",
      url: "http://127.0.0.1:11434/api/chat",
    });
    expect(calls[1]?.headers.get("content-type")).toBe("application/json");
    expect(models).toMatchObject({
      body: { models: [{ name: "llama3.2:latest" }] },
      ok: true,
      statusCode: 200,
    });
    expect(chat).toMatchObject({
      body: { message: { content: "unit response" } },
      ok: true,
      statusCode: 200,
    });
  });

  it("declares an Ollama template marker in a follow-up migration", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0008");

    expect(migration).toMatchObject({
      id: "0008",
      name: "ollama_provider_template",
    });
    expect(migration?.sql).toContain("provider_template_id in ('deepseek', 'ollama')");
  });
});
