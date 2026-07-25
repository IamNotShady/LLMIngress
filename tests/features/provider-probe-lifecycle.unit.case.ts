import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatModelContextTokens } from "../../apps/console/src/app/_ui/model-capability-format";
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
    const dialogs = readFileSync("apps/console/src/app/_ui/providers/dialogs.tsx", "utf8");

    // The template supplies a default, but the field stays editable — a
    // self-hosted deployment of a templated provider has a different base url.
    expect(dialogs).toContain('name="baseUrl"');
    expect(dialogs).not.toContain('type="hidden" name="baseUrl"');
    expect(dialogs).not.toContain("readOnly={Boolean(provider.providerTemplateId)}");
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

    // A model whose context window or price is unknown still renders and is
    // still routable; the cell says Unknown rather than inventing a number.
    const contextFormat = readFileSync(
      "apps/console/src/app/_ui/model-capability-format.ts",
      "utf8",
    );
    expect(contextFormat).toContain('return contextWindow === null ? "Unknown"');
    expect(formatModelContextTokens(null)).toBe("Unknown");
  });
});
