import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  listProviderTemplateSelectorGroups,
  normalizeProviderTemplateFormInput,
} from "../../packages/db/src/console-provider-templates";
import { buildProviderConnectionProbeJobPayload } from "../../packages/db/src/provider-jobs";
import { selectProviderProbeModel } from "../../packages/provider/src/connectivity";
import { planProviderModelRefresh } from "../../packages/worker-runtime/src/worker-model-refresh";

describe("provider probe lifecycle", () => {
  it("treats remote API key and subscription template URLs as editable defaults", () => {
    const groups = listProviderTemplateSelectorGroups();
    const remote = groups
      .find((group) => group.id === "remote_api_key")
      ?.templates.find((template) => template.id === "google");
    const subscription = groups
      .find((group) => group.id === "subscription")
      ?.templates.find((template) => template.id === "openai_codex");

    expect(remote?.baseUrlMode).toBe("user_remote");
    expect(subscription?.baseUrlMode).toBe("user_remote");
    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "https://proxy.example.test/google/v1/",
        displayName: "Google Gemini",
        templateId: "google",
      }).baseUrl,
    ).toBe("https://proxy.example.test/google/v1");
    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "https://proxy.example.test/codex/",
        displayName: "OpenAI Codex",
        templateId: "openai_codex",
      }).baseUrl,
    ).toBe("https://proxy.example.test/codex");
    expect(() =>
      normalizeProviderTemplateFormInput({
        baseUrl: "http://provider.example.test/v1",
        displayName: "Google Gemini",
        templateId: "google",
      }),
    ).toThrow(/https/i);
    expect(
      normalizeProviderTemplateFormInput({
        baseUrl: "http://127.0.0.1:4010/v1",
        displayName: "Google Gemini",
        templateId: "google",
      }).baseUrl,
    ).toBe("http://127.0.0.1:4010/v1");
  });

  it("submits and edits base URLs for template providers", () => {
    const createForm = readFileSync(
      "apps/console/src/app/_modules/provider-create-form.tsx",
      "utf8",
    );
    const providerSection = readFileSync(
      "apps/console/src/app/_modules/providers-section.tsx",
      "utf8",
    );

    expect(createForm).toContain('name="baseUrl"');
    expect(createForm).not.toContain('type="hidden" name="baseUrl"');
    expect(providerSection).not.toContain("readOnly={Boolean(provider.providerTemplateId)}");
    expect(providerSection).toContain('name="baseUrl"');
    expect(providerSection).toMatch(/name="baseUrl"[\s\S]{0,160}required/);
  });

  it("uses a connection-scoped probe job independent from model refresh", () => {
    expect(
      buildProviderConnectionProbeJobPayload({
        providerConnectionId: "connection-1",
        providerId: "provider-1",
        source: "manual_probe",
      }),
    ).toEqual({
      providerConnectionId: "connection-1",
      providerId: "provider-1",
      source: "manual_probe",
    });

    const refreshSource = readFileSync(
      "packages/worker-runtime/src/worker-model-refresh.ts",
      "utf8",
    );
    expect(refreshSource).not.toContain("probeProvider");
  });

  it("keeps unknown models and allows an unknown-context chat model to be probed", () => {
    const models = [
      {
        displayName: "Known context",
        contextWindow: 4096,
        modelId: "known-context",
      },
      { displayName: "Unknown", modelId: "unknown-chat" },
    ];

    expect(
      planProviderModelRefresh({ existingModels: [], listedModels: models }).insertModels.map(
        (model) => model.modelId,
      ),
    ).toEqual(["known-context", "unknown-chat"]);
    expect(
      selectProviderProbeModel([
        {
          contextWindow: null,
          inputUsdPerMillionTokens: null,
          modelId: "unknown-chat",
          outputUsdPerMillionTokens: null,
        },
      ]),
    ).toBe("unknown-chat");

    const providerModelsUi = readFileSync(
      "apps/console/src/app/_modules/providers-client-section.tsx",
      "utf8",
    );
    expect(providerModelsUi).toMatch(/function formatModelContext[\s\S]*?return "Unknown";/);
    expect(providerModelsUi).toMatch(/function formatModelPrice[\s\S]*?return "Unknown";/);
  });
});
