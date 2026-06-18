import { describe, expect, it } from "vitest";
import {
  buildRoutePolicyHealthWarnings,
  buildRoutePolicyWarnings,
  filterRoutePolicyEditorProviderModelOptions,
  mergeRoutePolicyEditorProviderModelOptions,
  normalizeRoutePolicyEditorFilters,
} from "../../apps/console/src/server/route-policies";

describe("feat-078 route policy editor enhancements", () => {
  it("normalizes provider and model filters then keeps selected candidates in edit options", () => {
    const filters = normalizeRoutePolicyEditorFilters({
      modelQuery: " GPT ",
      providerKey: " openai ",
    });
    const openaiGpt = providerModelOption({
      id: "openai-gpt",
      modelDisplayName: "GPT 4.1 Mini",
      modelId: "gpt-4.1-mini",
      providerDisplayName: "OpenAI",
      providerKey: "openai",
    });
    const anthropicClaude = providerModelOption({
      id: "anthropic-claude",
      modelDisplayName: "Claude Sonnet 4",
      modelId: "claude-sonnet-4",
      providerDisplayName: "Anthropic",
      providerKey: "anthropic",
    });
    const openaiEmbedding = providerModelOption({
      id: "openai-embedding",
      modelDisplayName: "Text Embedding 3",
      modelId: "text-embedding-3-small",
      providerDisplayName: "OpenAI",
      providerKey: "openai",
    });

    const filtered = filterRoutePolicyEditorProviderModelOptions(
      [anthropicClaude, openaiEmbedding, openaiGpt],
      filters,
    );

    expect(filters).toEqual({ modelQuery: "GPT", providerKey: "openai" });
    expect(filtered.map((option) => option.id)).toEqual(["openai-gpt"]);
    expect(
      mergeRoutePolicyEditorProviderModelOptions(filtered, [anthropicClaude]).map(
        (option) => option.id,
      ),
    ).toEqual(["openai-gpt", "anthropic-claude"]);
  });

  it("builds availability price and health warnings for route policy candidates", () => {
    expect(
      buildRoutePolicyWarnings([
        {
          availability: "available",
          optionLabel: "Anthropic - Claude Sonnet 4 (claude-sonnet-4)",
          priceStatus: "unknown_price",
        },
        {
          availability: "unavailable",
          optionLabel: "Fireworks - Mixtral (mixtral-8x7b)",
          priceStatus: "priced",
        },
      ]),
    ).toEqual([
      "Price warning: Anthropic - Claude Sonnet 4 (claude-sonnet-4) has unknown price; save a manual price override before using budgeted routes.",
      "Route warning: Fireworks - Mixtral (mixtral-8x7b) is unavailable and excluded from Gateway routing.",
    ]);

    expect(
      buildRoutePolicyHealthWarnings([
        {
          modelHealthIsStale: true,
          modelHealthStatus: "unhealthy",
          optionLabel: "Anthropic - Claude Sonnet 4 (claude-sonnet-4)",
          providerHealthIsStale: false,
          providerHealthStatus: "degraded",
        },
      ]),
    ).toEqual([
      "Health warning: Anthropic - Claude Sonnet 4 (claude-sonnet-4) provider health is Degraded.",
      "Health warning: Anthropic - Claude Sonnet 4 (claude-sonnet-4) model health is Unhealthy.",
      "Health warning: Anthropic - Claude Sonnet 4 (claude-sonnet-4) model health is stale.",
    ]);
  });
});

function providerModelOption(input: {
  id: string;
  modelDisplayName: string;
  modelId: string;
  providerDisplayName: string;
  providerKey: string;
}) {
  return {
    availability: "available",
    id: input.id,
    modelDisplayName: input.modelDisplayName,
    modelId: input.modelId,
    optionLabel: `${input.providerDisplayName} - ${input.modelDisplayName} (${input.modelId})`,
    pricedOptionLabel: `${input.providerDisplayName} - ${input.modelDisplayName} (${input.modelId}) - Priced (built-in)`,
    priceStatus: "priced" as const,
    priceStatusLabel: "Priced (built-in)",
    providerDisplayName: input.providerDisplayName,
    providerEnabled: true,
    providerId: `${input.providerKey}-provider`,
    providerKey: input.providerKey,
  };
}
