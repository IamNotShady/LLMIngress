import { describe, expect, it } from "vitest";
import {
  getOpenAICompatibleProviderTemplate,
  normalizeProviderTemplateFormInput,
} from "../../apps/console/src/server/provider-templates";
import { normalizeProviderFormInput } from "../../apps/console/src/server/providers";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-020 OpenAI-compatible provider template", () => {
  it("accepts a whitelisted template with fixed base URL and capabilities", () => {
    const template = getOpenAICompatibleProviderTemplate("deepseek");

    expect(template).toEqual({
      baseUrl: "https://api.deepseek.com/v1",
      capabilities: {
        chatCompletions: true,
        streaming: true,
        tools: true,
      },
      displayName: "DeepSeek",
      id: "deepseek",
      providerKey: "deepseek",
      providerType: "api_key",
    });
    expect(normalizeProviderTemplateFormInput({ templateId: "deepseek" })).toEqual(template);
  });

  it("rejects unknown templates and arbitrary custom OpenAI-compatible endpoints", () => {
    expect(() => normalizeProviderTemplateFormInput({ templateId: "custom" })).toThrow(
      /whitelisted provider template/i,
    );

    expect(() =>
      normalizeProviderTemplateFormInput({
        baseUrl: "https://arbitrary.example/v1",
        templateId: "deepseek",
      }),
    ).toThrow(/custom OpenAI-compatible endpoints are not allowed/i);

    expect(() =>
      normalizeProviderFormInput({
        baseUrl: "https://arbitrary.example/v1",
        displayName: "Custom",
        providerKey: "custom",
        providerType: "api_key",
      }),
    ).toThrow(/custom OpenAI-compatible endpoints are not allowed/i);
  });

  it("declares a provider template marker so fixed-template URLs can stay locked", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0007");

    expect(migration).toMatchObject({
      id: "0007",
      name: "provider_templates",
    });
    expect(migration?.sql).toContain("add column if not exists provider_template_id text");
    expect(migration?.sql).toContain("provider_template_id in ('deepseek')");
  });
});
