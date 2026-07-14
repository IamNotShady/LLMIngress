import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeModelInputModalities,
  normalizeModelOutputModalities,
  resolveProviderModelCapabilities,
} from "../../packages/domain/src/index.ts";
import {
  mergeProviderModelRegistryEntries,
  normalizeLiteLlmProviderModelRegistryEntries,
  normalizeModelsDevProviderModelRegistryEntries,
  normalizeOpenRouterProviderModelRegistryEntries,
  normalizeVercelAiGatewayProviderModelRegistryEntries,
} from "../../packages/provider/src/price-source.ts";

const syncedAt = new Date("2026-07-10T00:00:00.000Z");

describe("provider model capability sync", () => {
  it("normalizes core modality aliases in stable enum order", () => {
    expect(normalizeModelInputModalities(["vision", "file", "text", "TEXT", "pdf"])).toEqual([
      "text",
      "image",
      "document",
    ]);
    expect(normalizeModelOutputModalities(["embeddings", "text", "IMAGE"])).toEqual([
      "text",
      "image",
      "embedding",
    ]);
  });

  it("maps models.dev stable capability fields", () => {
    const [entry] = normalizeModelsDevProviderModelRegistryEntries(
      {
        openai: {
          models: {
            "gpt-4o": {
              attachment: true,
              id: "gpt-4o",
              limit: { context: 128000, output: 16384 },
              modalities: { input: ["text", "vision"], output: ["text"] },
              reasoning: true,
              tool_call: true,
            },
          },
        },
      },
      { sourceUrl: "models.dev://test", syncedAt },
    );

    expect(entry).toMatchObject({
      inputModalities: ["text", "image", "document"],
      maxContextTokens: 128000,
      maxOutputTokens: 16384,
      modelId: "gpt-4o",
      outputModalities: ["text"],
      providerKey: "openai",
      supportsFunctionCalling: true,
      supportsReasoning: true,
    });
    expect(entry?.registrySources).toMatchObject({
      inputModalities: "models.dev",
      outputModalities: "models.dev",
      supportsFunctionCalling: "models.dev",
    });
  });

  it("maps OpenRouter, LiteLLM, and Vercel capability fields without model-name inference", () => {
    expect(
      normalizeOpenRouterProviderModelRegistryEntries(
        {
          data: [
            {
              architecture: {
                input_modalities: ["text", "image"],
                output_modalities: ["text"],
              },
              context_length: 128000,
              id: "openai/gpt-4o",
              supported_parameters: ["tools", "reasoning"],
              top_provider: { max_completion_tokens: 4096 },
            },
          ],
        },
        { sourceUrl: "openrouter://test", syncedAt },
      )[0],
    ).toMatchObject({
      inputModalities: ["text", "image"],
      maxContextTokens: 128000,
      maxOutputTokens: 4096,
      outputModalities: ["text"],
      supportsFunctionCalling: true,
      supportsReasoning: true,
    });

    expect(
      normalizeLiteLlmProviderModelRegistryEntries(
        {
          "openai/gpt-audio": {
            litellm_provider: "openai",
            max_input_tokens: 64000,
            max_output_tokens: 2048,
            output_modalities: ["text"],
            supported_modalities: ["text", "audio"],
            supports_function_calling: true,
            supports_reasoning: false,
          },
        },
        { sourceUrl: "litellm://test", syncedAt },
      )[0],
    ).toMatchObject({
      inputModalities: ["text", "audio"],
      maxContextTokens: 64000,
      maxOutputTokens: 2048,
      outputModalities: ["text"],
      supportsFunctionCalling: true,
      supportsReasoning: false,
    });

    expect(
      normalizeVercelAiGatewayProviderModelRegistryEntries(
        {
          data: [
            {
              context_window: 32768,
              id: "openai/gpt-vision",
              max_tokens: 4096,
              owned_by: "openai",
              tags: ["vision", "tool-use", "reasoning"],
              type: "language",
            },
          ],
        },
        { sourceUrl: "vercel://test", syncedAt },
      )[0],
    ).toMatchObject({
      inputModalities: ["text", "image"],
      maxContextTokens: 32768,
      maxOutputTokens: 4096,
      outputModalities: ["text"],
      supportsFunctionCalling: true,
      supportsReasoning: true,
    });
  });

  it("keeps higher-priority capability values and lets manual capabilities win", () => {
    const [merged] = mergeProviderModelRegistryEntries(
      [
        {
          inputModalities: ["text"],
          maxContextTokens: 128000,
          maxOutputTokens: 4096,
          modelId: "gpt-4o",
          outputModalities: ["text"],
          providerKey: "openai",
          registrySources: {
            maxOutputTokens: "models.dev",
          },
          supportsFunctionCalling: true,
          supportsReasoning: true,
          syncedAt,
        },
      ],
      [
        {
          maxOutputTokens: 8192,
          modelId: "gpt-4o",
          providerKey: "openai",
          registrySources: {
            maxOutputTokens: "litellm",
          },
          syncedAt,
        },
      ],
    );

    expect(merged?.maxOutputTokens).toBe(4096);
    expect(merged).not.toHaveProperty("capabilityConflicts");

    expect(
      resolveProviderModelCapabilities({
        manualCapabilities: { maxOutputTokens: 8192 },
        syncedCapabilities: merged,
      }).effectiveCapabilities,
    ).toMatchObject({
      maxOutputTokens: 8192,
      supportsFunctionCalling: true,
    });
  });

  it("ships independent effective capability columns in the core baseline", () => {
    const migration = readFileSync("packages/db/migrations/0001_core_baseline.sql", "utf8");

    expect(migration).toContain("input_modalities text[]");
    expect(migration).toContain("output_modalities text[]");
    expect(migration).toContain("max_output_tokens integer");
    expect(migration).toContain("supports_function_calling boolean");
    expect(migration).toContain("supports_reasoning boolean");
    expect(migration).toContain("provider_models_input_modalities_values_check");
    expect(migration).toContain("provider_models_output_modalities_values_check");
  });
});
