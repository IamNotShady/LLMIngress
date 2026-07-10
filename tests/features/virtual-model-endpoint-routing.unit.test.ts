import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ConsoleProviderModelOption,
  filterRoutePolicyEditorProviderModelOptions,
  listProviderRouteEndpointProtocols,
  normalizeRoutePolicyEditorFilters,
  normalizeRoutePolicyFormInput,
} from "../../packages/db/src/console-route-policies";
import { executeGatewayOpenAIChatCompletion } from "../../packages/gateway-runtime/src/gateway-chat-completions";
import type { GatewayRouteCandidateSnapshot } from "../../packages/gateway-runtime/src/gateway-config-reload";

const virtualModelId = "00000000-0000-4000-8000-000000000001";
const providerModelId = "00000000-0000-4000-8000-000000000002";

describe("virtual model endpoint routing", () => {
  it("requires a Gateway endpoint protocol when saving route policies", () => {
    expect(
      normalizeRoutePolicyFormInput({
        endpointProtocol: "responses",
        providerModelIds: [providerModelId],
        strategy: "fixed",
        virtualModelId,
      }),
    ).toMatchObject({
      endpointProtocol: "responses",
      providerModelIds: [providerModelId],
      strategy: "fixed",
      virtualModelId,
    });

    expect(() =>
      normalizeRoutePolicyFormInput({
        providerModelIds: [providerModelId],
        strategy: "fixed",
        virtualModelId,
      }),
    ).toThrow(/endpoint protocol is required/i);

    expect(() =>
      normalizeRoutePolicyFormInput({
        endpointProtocol: "models",
        providerModelIds: [providerModelId],
        strategy: "fixed",
        virtualModelId,
      }),
    ).toThrow(/endpoint protocol must be chat_completions, responses, messages, or embeddings/i);
  });

  it("derives route endpoint protocols from provider templates and direct providers", () => {
    expect(
      listProviderRouteEndpointProtocols({
        providerKey: "openai",
        providerTemplateId: null,
      }),
    ).toEqual(["chat_completions", "responses", "embeddings"]);
    expect(
      listProviderRouteEndpointProtocols({
        providerKey: "anthropic",
        providerTemplateId: null,
      }),
    ).toEqual(["messages"]);
    expect(
      listProviderRouteEndpointProtocols({
        providerKey: "openrouter",
        providerTemplateId: "openrouter",
      }),
    ).toEqual(["chat_completions", "embeddings", "messages", "responses"]);
    expect(
      listProviderRouteEndpointProtocols({
        providerKey: "moonshot",
        providerTemplateId: "moonshot",
      }),
    ).toEqual(["chat_completions"]);
  });

  it("filters route policy candidate options by the selected endpoint", () => {
    const options = [
      providerOption({
        id: "chat",
        providerKey: "openai",
        supportedEndpoints: ["chat_completions", "responses", "embeddings"],
      }),
      providerOption({
        id: "messages",
        providerKey: "anthropic",
        supportedEndpoints: ["messages"],
      }),
      providerOption({
        id: "responses",
        providerKey: "openai_codex",
        supportedEndpoints: ["responses"],
      }),
    ];

    expect(
      filterRoutePolicyEditorProviderModelOptions(
        options,
        normalizeRoutePolicyEditorFilters({ endpointProtocol: "messages" }),
      ).map((option) => option.id),
    ).toEqual(["messages"]);
    expect(
      filterRoutePolicyEditorProviderModelOptions(
        options,
        normalizeRoutePolicyEditorFilters({ endpointProtocol: "responses" }),
      ).map((option) => option.id),
    ).toEqual(["chat", "responses"]);
  });

  it("rejects Gateway requests made through a different endpoint than the saved route policy", async () => {
    const response = await executeGatewayOpenAIChatCompletion({
      agentId: randomUUID(),
      requestBody: {
        messages: [{ content: "hello", role: "user" }],
      },
      requestId: "req-endpoint-mismatch",
      snapshot: {
        loadedAt: new Date(),
        providers: [],
        routePolicies: [
          {
            candidates: [candidateSnapshot()],
            id: "route-1",
            rules: { endpointProtocol: "messages" },
            strategy: "fixed",
            virtualModelId: "vm-1",
            virtualModelName: "vm",
          },
        ],
        version: 1,
      },
      virtualModel: {
        id: "vm-1",
        name: "vm",
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      error: {
        code: "provider_protocol_unsupported",
      },
      requestId: "req-endpoint-mismatch",
    });
  });
});

function providerOption(
  overrides: Partial<ConsoleProviderModelOption> & Pick<ConsoleProviderModelOption, "id">,
): ConsoleProviderModelOption {
  return {
    availability: "available",
    contextWindow: 128000,
    id: overrides.id,
    inputUsdPerMillionTokens: 0.1,
    modelDisplayName: `${overrides.id} model`,
    modelId: `${overrides.id}-model`,
    optionLabel: `${overrides.id} provider - ${overrides.id} model`,
    outputUsdPerMillionTokens: 0.2,
    pricedOptionLabel: `${overrides.id} provider - ${overrides.id} model - Priced`,
    priceStatus: "priced",
    priceStatusLabel: "Priced",
    providerDisplayName: `${overrides.providerKey ?? "openai"} provider`,
    providerEnabled: true,
    providerId: randomUUID(),
    providerKey: overrides.providerKey ?? "openai",
    supportedEndpoints: overrides.supportedEndpoints ?? ["chat_completions"],
    supportsStreaming: true,
    supportsTools: true,
  };
}

function candidateSnapshot(
  overrides: Partial<GatewayRouteCandidateSnapshot> = {},
): GatewayRouteCandidateSnapshot {
  return {
    candidateOrder: 1,
    displayName: "Fake Model",
    healthStatus: "healthy",
    modelId: "fake-model",
    price: {
      modelId: "fake-model",
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId: randomUUID(),
    providerKey: "openai",
    providerModelId: randomUUID(),
    ...overrides,
  };
}
