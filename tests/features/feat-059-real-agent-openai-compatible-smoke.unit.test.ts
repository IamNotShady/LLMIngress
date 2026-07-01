import { describe, expect, it } from "vitest";
import { defaultAgentLimitFormValues } from "../../apps/console/src/server/agent-limits";
import { normalizeOpenAIChatCompletionRequest } from "../../packages/db/src/gateway-chat-completions";
import { buildOpenAIChatCompletionRequestMetadata } from "../../packages/db/src/gateway-request-metadata";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";
import {
  buildHermesLikeOpenAICompatibleChatBody,
  realAgentOpenAICompatibleSmokeNames,
} from "../support/real-agent-openai-compatible-smoke";

describe("feat-059 real Agent OpenAI-compatible smoke support", () => {
  it("builds a Hermes-like chat request that fits Agent-ready default limits", () => {
    const body = buildHermesLikeOpenAICompatibleChatBody();
    const normalized = normalizeOpenAIChatCompletionRequest(
      body,
      realAgentOpenAICompatibleSmokeNames.requestId,
    );

    expect(normalized).toMatchObject({
      ok: true,
      request: {
        maxOutputTokens: body.max_tokens,
        stream: false,
        toolChoice: "auto",
        tools: body.tools,
      },
    });
    if (!normalized.ok) {
      throw new Error("Hermes-like OpenAI-compatible request should normalize.");
    }

    const metadata = buildOpenAIChatCompletionRequestMetadata({
      model: body.model,
      rawBody: body,
      request: normalized.request,
    });
    const totalEstimatedTokens = metadata.estimatedInputTokens + metadata.estimatedOutputTokens;

    expect(metadata).toMatchObject({
      estimatedOutputTokens: body.max_tokens,
      messageCount: 2,
      model: realAgentOpenAICompatibleSmokeNames.virtualModel,
      protocol: "chat_completions",
      stream: false,
      usesTools: true,
    });
    expect(metadata.estimatedInputTokens).toBeGreaterThan(5_000);
    expect(totalEstimatedTokens).toBeGreaterThan(10_000);
    expect(totalEstimatedTokens).toBeLessThanOrEqual(defaultAgentLimitFormValues.tokenLimit);
    expect(totalEstimatedTokens).toBeLessThanOrEqual(defaultAgentLimitFormValues.tpm);
    expect(defaultAgentLimitFormValues.rpm).toBeGreaterThanOrEqual(60);
    expect(
      normalizeOpenAIChatCompletionRequest(
        { ...body, tool_choice: "unsupported-mode" },
        realAgentOpenAICompatibleSmokeNames.requestId,
      ),
    ).toMatchObject({ ok: false, statusCode: 400 });
  });

  it("forwards OpenAI-compatible tool schemas to the provider adapter", async () => {
    const body = buildHermesLikeOpenAICompatibleChatBody();
    const normalized = normalizeOpenAIChatCompletionRequest(
      body,
      realAgentOpenAICompatibleSmokeNames.requestId,
    );
    if (!normalized.ok) {
      throw new Error("Hermes-like OpenAI-compatible request should normalize.");
    }

    const providerCalls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    const adapter = createOpenAIProviderAdapter({
      fetch: async (url, init) => {
        providerCalls.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok", role: "assistant" } }],
            id: "chatcmpl_feat_059",
            object: "chat.completion",
          }),
          { status: 200 },
        );
      },
    });

    const result = await adapter.chatCompletion({
      request: normalized.request,
      target: {
        apiKey: realAgentOpenAICompatibleSmokeNames.providerApiKey,
        baseUrl: "https://openai-compatible.example/v1",
        modelId: realAgentOpenAICompatibleSmokeNames.providerModel,
      },
    });

    expect(result.ok).toBe(true);
    expect(providerCalls).toEqual([
      {
        body: {
          max_tokens: body.max_tokens,
          messages: body.messages,
          model: realAgentOpenAICompatibleSmokeNames.providerModel,
          stream: false,
          temperature: body.temperature,
          tool_choice: "auto",
          tools: body.tools,
        },
        headers: expect.any(Headers),
        url: "https://openai-compatible.example/v1/chat/completions",
      },
    ]);
    expect(providerCalls[0]?.headers.get("authorization")).toBe(
      `Bearer ${realAgentOpenAICompatibleSmokeNames.providerApiKey}`,
    );
  });
});
