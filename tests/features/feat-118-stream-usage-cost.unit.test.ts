import { describe, expect, it } from "vitest";
import { buildStreamingProviderRequestBody } from "../../apps/gateway/src/streaming";
import {
  buildGatewayUsageCostRecords,
  createGatewayStreamingUsageCollector,
} from "../../apps/gateway/src/usage-recorder";

describe("feat-118 stream usage and cost accounting", () => {
  it("parses OpenAI-compatible chat stream final usage", () => {
    const collector = createGatewayStreamingUsageCollector();

    collector.collect('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    collector.collect(
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"prompt_tokens_details":{"cached_tokens":400},"completion_tokens":200,"completion_tokens_details":{"reasoning_tokens":25},"total_tokens":1200}}\n\n',
    );
    collector.collect("data: [DONE]\n\n");

    expect(collector.readUsage()).toEqual({
      cachedInputTokens: 400,
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 25,
    });
  });

  it("parses Responses stream completed response usage", () => {
    const collector = createGatewayStreamingUsageCollector();

    collector.collect(
      [
        'data: {"type":"response.output_text.delta","delta":"hello"}',
        "",
        'data: {"type":"response.completed","response":{"id":"resp_118","usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":10},"output_tokens":25,"output_tokens_details":{"reasoning_tokens":5}}}}',
        "",
        "",
      ].join("\n"),
    );

    expect(collector.readUsage()).toEqual({
      cachedInputTokens: 10,
      inputTokens: 50,
      outputTokens: 25,
      reasoningTokens: 5,
    });
  });

  it("parses Anthropic Messages cumulative stream usage", () => {
    const collector = createGatewayStreamingUsageCollector();

    collector.collect(
      [
        'data: {"type":"message_start","message":{"id":"msg_118","usage":{"input_tokens":60,"cache_read_input_tokens":5,"output_tokens":1}}}',
        "",
        'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
        "",
        'data: {"type":"message_delta","usage":{"output_tokens":30}}',
        "",
        "",
      ].join("\n"),
    );

    expect(collector.readUsage()).toEqual({
      cachedInputTokens: 5,
      inputTokens: 65,
      outputTokens: 30,
      reasoningTokens: 0,
    });
  });

  it("keeps Anthropic message_delta output usage when message_start usage is unavailable", () => {
    const collector = createGatewayStreamingUsageCollector();

    collector.collect(
      [
        'data: {"type":"message_delta","usage":{"output_tokens":30,"output_tokens_details":{"reasoning_tokens":7}}}',
        "",
        "",
      ].join("\n"),
    );

    expect(collector.readUsage()).toEqual({
      cachedInputTokens: 0,
      inputTokens: 0,
      outputTokens: 30,
      reasoningTokens: 7,
    });
  });

  it("ignores malformed frames and missing usage", () => {
    const collector = createGatewayStreamingUsageCollector();

    collector.collect("data: not-json\n\n");
    collector.collect('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    collector.collect("data: [DONE]\n\n");

    expect(collector.readUsage()).toBeUndefined();
  });

  it("ignores OpenRouter raw cost and computes USD from LLMIngress pricing", () => {
    const collector = createGatewayStreamingUsageCollector();
    collector.collect(
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":200,"cost":99}}\n\n',
    );

    const records = buildGatewayUsageCostRecords({
      actualPrice: pricedModel("gpt-4.1-nano", 0.1, 0.4),
      baselinePrice: pricedModel("gpt-4.1", 2, 8),
      baselineProviderModelId: "baseline-provider-model",
      estimatedInputTokens: 1,
      estimatedOutputTokens: 1,
      providerModelId: "actual-provider-model",
      providerUsage: collector.readUsage(),
    });

    expect(records.requestUsage).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      tokenSource: "provider",
    });
    expect(records.requestCost.totalCostUsd).toBe(0.00018);
  });

  it("adds stream usage requests only for known supported chat providers", () => {
    expect(
      buildStreamingProviderRequestBody({
        modelId: "gpt-4.1",
        pathSuffix: "chat/completions",
        payload: { messages: [{ content: "hi", role: "user" }] },
        providerKey: "openai",
      }),
    ).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(
      buildStreamingProviderRequestBody({
        modelId: "gemini-2.5-pro",
        pathSuffix: "chat/completions",
        payload: { messages: [{ content: "hi", role: "user" }] },
        providerKey: "google",
      }),
    ).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(
      buildStreamingProviderRequestBody({
        modelId: "local-model",
        pathSuffix: "chat/completions",
        payload: { messages: [{ content: "hi", role: "user" }] },
        providerKey: "lmstudio",
      }),
    ).toMatchObject({
      stream_options: { include_usage: true },
    });
    expect(
      buildStreamingProviderRequestBody({
        modelId: "openrouter/model",
        pathSuffix: "chat/completions",
        payload: { messages: [{ content: "hi", role: "user" }] },
        providerKey: "openrouter",
      }),
    ).not.toHaveProperty("stream_options");
    expect(
      buildStreamingProviderRequestBody({
        modelId: "gpt-4.1",
        pathSuffix: "responses",
        payload: { input: "hi" },
        providerKey: "openai",
      }),
    ).not.toHaveProperty("stream_options");
  });
});

function pricedModel(modelId: string, inputPrice: number, outputPrice: number) {
  return {
    currency: "USD" as const,
    inputUsdPerMillionTokens: inputPrice,
    modelId,
    outputUsdPerMillionTokens: outputPrice,
    priceVersion: "mvp-static-2026-06-13",
    providerKey: "openai",
    snapshotDate: "2026-06-13" as const,
    source: "built_in_static_snapshot" as const,
    sourceUrl: "https://example.test/pricing",
    status: "priced" as const,
    unit: "per_1m_tokens" as const,
  };
}
