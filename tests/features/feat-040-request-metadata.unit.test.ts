import { describe, expect, it } from "vitest";
import {
  buildAnthropicMessagesRequestMetadata,
  buildOpenAIChatCompletionRequestMetadata,
  buildOpenAIResponsesRequestMetadata,
} from "../../packages/db/src/gateway-request-metadata";

describe("feat-040 request metadata and token estimation", () => {
  it("extracts chat completion model protocol stream messages tools and token estimates", () => {
    const withTools = buildOpenAIChatCompletionRequestMetadata({
      model: "chat-coding",
      rawBody: {
        tools: [{ function: { name: "lookup_repo" }, type: "function" }],
      },
      request: {
        maxOutputTokens: 64,
        messages: [
          { content: "You are concise.", role: "system" },
          { content: "Explain the diff.", role: "user" },
        ],
        stream: true,
      },
    });
    const withoutTools = buildOpenAIChatCompletionRequestMetadata({
      model: "chat-coding",
      rawBody: {},
      request: {
        maxOutputTokens: 64,
        messages: [
          { content: "You are concise.", role: "system" },
          { content: "Explain the diff.", role: "user" },
        ],
        stream: true,
      },
    });

    expect(withTools).toMatchObject({
      estimatedOutputTokens: 64,
      messageCount: 2,
      model: "chat-coding",
      protocol: "chat_completions",
      stream: true,
      usesTools: true,
    });
    expect(withTools.estimatedInputTokens).toBeGreaterThan(withoutTools.estimatedInputTokens);
  });

  it("extracts Responses API metadata from string and message inputs", () => {
    expect(
      buildOpenAIResponsesRequestMetadata({
        model: "responses-coding",
        rawBody: {
          tools: [{ name: "search", type: "web_search_preview" }],
        },
        request: {
          input: [
            { content: "Summarize this.", role: "user" },
            { content: "Use bullet points.", role: "assistant" },
          ],
          maxOutputTokens: 128,
          stream: false,
        },
      }),
    ).toMatchObject({
      estimatedOutputTokens: 128,
      messageCount: 2,
      model: "responses-coding",
      protocol: "responses",
      stream: false,
      usesTools: true,
    });

    expect(
      buildOpenAIResponsesRequestMetadata({
        model: "responses-coding",
        rawBody: {},
        request: {
          input: "Short question",
        },
      }),
    ).toMatchObject({
      estimatedOutputTokens: 1024,
      messageCount: 1,
      usesTools: false,
    });
  });

  it("extracts Anthropic messages metadata including system text and required output cap", () => {
    const withTools = buildAnthropicMessagesRequestMetadata({
      model: "messages-coding",
      rawBody: {
        tools: [{ input_schema: { type: "object" }, name: "read_file" }],
      },
      request: {
        maxOutputTokens: 256,
        messages: [
          { content: "Review this patch.", role: "user" },
          { content: "I need concrete issues.", role: "assistant" },
        ],
        stream: false,
        system: "You are a code reviewer.",
      },
    });
    const withoutSystem = buildAnthropicMessagesRequestMetadata({
      model: "messages-coding",
      rawBody: {},
      request: {
        maxOutputTokens: 256,
        messages: [
          { content: "Review this patch.", role: "user" },
          { content: "I need concrete issues.", role: "assistant" },
        ],
        stream: false,
      },
    });

    expect(withTools).toMatchObject({
      estimatedOutputTokens: 256,
      messageCount: 2,
      model: "messages-coding",
      protocol: "messages",
      stream: false,
      usesTools: true,
    });
    expect(withTools.estimatedInputTokens).toBeGreaterThan(withoutSystem.estimatedInputTokens);
  });
});
