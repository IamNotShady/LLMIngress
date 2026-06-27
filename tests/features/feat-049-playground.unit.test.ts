import { describe, expect, it } from "vitest";
import {
  buildPlaygroundChatRequest,
  buildPlaygroundMessagesRequest,
  buildPlaygroundResponsesRequest,
  formatPlaygroundFetchError,
  isValidPlaygroundGatewayBaseUrl,
  normalizePlaygroundGatewayBaseUrl,
  readPlaygroundStreamResponseText,
} from "../../apps/console/src/app/playground-helpers";
import { isAllowedGatewayCorsOrigin } from "../../apps/gateway/src/cors";

describe("feat-049 Playground live public API test", () => {
  it("normalizes Gateway base URLs and builds the live chat request body", () => {
    expect(normalizePlaygroundGatewayBaseUrl(" http://127.0.0.1:4000/ ")).toBe(
      "http://127.0.0.1:4000",
    );
    expect(isValidPlaygroundGatewayBaseUrl("http://127.0.0.1:4000")).toBe(true);
    expect(isValidPlaygroundGatewayBaseUrl("/v1/chat/completions")).toBe(false);
    expect(isValidPlaygroundGatewayBaseUrl("")).toBe(false);

    expect(
      buildPlaygroundChatRequest({
        maxTokens: 1024,
        model: "playground-live",
        prompt: "hello from playground",
        stream: true,
        systemPrompt: "be concise",
        temperature: 0.7,
        topP: 0.9,
      }),
    ).toEqual({
      max_tokens: 1024,
      messages: [
        { content: "be concise", role: "system" },
        { content: "hello from playground", role: "user" },
      ],
      model: "playground-live",
      stream: true,
      temperature: 0.7,
      top_p: 0.9,
    });

    expect(
      buildPlaygroundResponsesRequest({
        maxTokens: 512,
        model: "gpt55",
        prompt: "hello from responses",
        systemPrompt: "answer in Chinese",
        temperature: 0.2,
        topP: 1,
      }),
    ).toEqual({
      input: "hello from responses",
      instructions: "answer in Chinese",
      max_output_tokens: 512,
      model: "gpt55",
      store: false,
      stream: false,
      temperature: 0.2,
      top_p: 1,
    });

    expect(
      buildPlaygroundMessagesRequest({
        maxTokens: 256,
        model: "opus48",
        prompt: "hello from messages",
        systemPrompt: "use bullets",
        temperature: 1,
        topP: 0.8,
      }),
    ).toEqual({
      max_tokens: 256,
      messages: [{ content: "hello from messages", role: "user" }],
      model: "opus48",
      stream: false,
      system: "use bullets",
      temperature: 1,
      top_p: 0.8,
    });
  });

  it("allows local Console origins by default and remote origins only when configured", () => {
    expect(isAllowedGatewayCorsOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isAllowedGatewayCorsOrigin("http://localhost:3001")).toBe(true);
    expect(isAllowedGatewayCorsOrigin("https://console.example")).toBe(false);
    expect(isAllowedGatewayCorsOrigin("https://console.example", "https://console.example")).toBe(
      true,
    );
  });

  it("formats Gateway network failures without leaking unhandled fetch errors", () => {
    expect(
      formatPlaygroundFetchError("loading allowed models", new TypeError("Failed to fetch")),
    ).toBe(
      "Could not reach Gateway while loading allowed models. Check the Gateway base URL and that Gateway is running.",
    );
  });

  it("reads text from streamed Playground SSE responses", () => {
    expect(
      readPlaygroundStreamResponseText(
        [
          'data: {"choices":[{"delta":{"content":"Hello"}}]}',
          'data: {"choices":[{"delta":{"content":" world"}}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      ),
    ).toBe("Hello world");

    expect(
      readPlaygroundStreamResponseText(
        [
          'data: {"choices":[{"delta":{"reasoning_content":"Thinking"}}]}',
          'data: {"choices":[{"delta":{"content":" answer"}}]}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      ),
    ).toBe("Thinking answer");

    expect(
      readPlaygroundStreamResponseText(
        [
          'data: {"type":"response.output_text.delta","delta":"Response"}',
          'data: {"type":"response.output_text.delta","delta":" from LLMIngress"}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      ),
    ).toBe("Response from LLMIngress");

    expect(
      readPlaygroundStreamResponseText(
        [
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Claude"}}',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" stream"}}',
          "data: [DONE]",
          "",
        ].join("\n\n"),
      ),
    ).toBe("Claude stream");
  });
});
