import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";
import {
  executeFallbackChain,
  type FallbackChainCandidate,
} from "../../apps/gateway/src/fallback-chain";
import { loadSqlMigrations } from "../../packages/db/src/index";
import { fetchListedProviderModels } from "../../packages/provider/src/model-list";

const geminiBaseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";

describe("feat-066 Google Gemini API key provider", () => {
  it("exposes Gemini as a fixed remote API-key template", () => {
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
          displayName: "Google Gemini",
          fixedBaseUrl: geminiBaseUrl,
          id: "google",
          providerKey: "google",
          providerType: "api_key",
        },
      ]),
    );
    expect(normalizeProviderTemplateFormInput({ templateId: "google" })).toMatchObject({
      baseUrl: geminiBaseUrl,
      displayName: "Google Gemini",
      id: "google",
      providerKey: "google",
      providerType: "api_key",
    });
    expect(() =>
      normalizeProviderFormInput({
        baseUrl: geminiBaseUrl,
        displayName: "Google Gemini",
        providerKey: "google",
        providerType: "api_key",
      }),
    ).toThrow(/template/i);
  });

  it("does not expose a native Gemini provider adapter", () => {
    const providerPackage = JSON.parse(
      readFileSync(new URL("../../packages/provider/package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, unknown> };

    expect(providerPackage.exports).not.toHaveProperty("./gemini");
  });

  it("declares the legacy Gemini provider template id in a follow-up migration", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0012");

    expect(migration).toMatchObject({
      id: "0012",
      name: "gemini_provider",
    });
    expect(migration?.sql).toContain("'gemini'");
    expect(migration?.sql).toContain("'openrouter'");
  });

  it("routes Gemini through the OpenAI-compatible chat completions adapter", async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    globalThis.fetch = async (url, init) => {
      calls.push({
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        headers: new Headers(init?.headers),
        url: String(url),
      });
      return new Response(JSON.stringify({ choices: [], id: "gemini-openai-compatible" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      });
    };

    try {
      await executeFallbackChain({
        candidates: [buildGeminiCandidate()],
        request: {
          messages: [{ role: "user", content: "hello" }],
          stream: true,
          toolChoice: "auto",
          tools: [{ type: "function", function: { name: "lookup" } }],
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toEqual([
      {
        body: {
          messages: [{ role: "user", content: "hello" }],
          model: "gemini-3.5-flash",
          stream: true,
          tool_choice: "auto",
          tools: [{ type: "function", function: { name: "lookup" } }],
        },
        headers: expect.any(Headers),
        url: `${geminiBaseUrl}/chat/completions`,
      },
    ]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer gemini-unit-secret");
    expect(calls[0]?.headers.get("x-goog-api-key")).toBeNull();
  });

  it("normalizes Google model list ids before matching external model metadata", async () => {
    await expect(
      fetchListedProviderModels({
        apiKey: "gemini-unit-secret",
        baseUrl: geminiBaseUrl,
        fetch: async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "models/gemini-2.5-pro",
                  name: "models/gemini-2.5-pro",
                },
              ],
            }),
            {
              headers: { "content-type": "application/json" },
              status: 200,
            },
          ),
        providerKey: "google",
      }),
    ).resolves.toEqual([
      {
        displayName: "gemini-2.5-pro",
        modelId: "gemini-2.5-pro",
      },
    ]);
  });

  it("declares a migration that upgrades existing Gemini and Ollama base URLs", () => {
    const migration = loadSqlMigrations().find(
      (candidate) =>
        candidate.id === "0041" && candidate.name === "provider_openai_compatible_urls",
    );
    const sql = migration?.sql ?? "";

    expect(sql).toContain("provider_key = 'google'");
    expect(sql).toContain("provider_template_id = 'google'");
    expect(sql).toContain("https://generativelanguage.googleapis.com/v1beta/openai");
    expect(sql).toContain("provider_key = 'gemini'");
    expect(sql).toContain("provider_key = 'ollama'");
    expect(sql).toContain("'/v1'");
    expect(sql).not.toContain("schema_version");
  });
});

function buildGeminiCandidate(): FallbackChainCandidate {
  return {
    apiKey: "gemini-unit-secret",
    baseUrl: geminiBaseUrl,
    candidateOrder: 1,
    isFallback: false,
    modelId: "gemini-3.5-flash",
    providerKey: "google",
    providerModelId: "gemini-provider-model-id",
  };
}
