import { describe, expect, it } from "vitest";
import {
  buildPlaygroundChatRequest,
  buildPlaygroundMessagesRequest,
  buildPlaygroundResponsesRequest,
  formatPlaygroundFetchError,
  isValidPlaygroundGatewayBaseUrl,
  normalizePlaygroundGatewayBaseUrl,
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
        model: "playground-live",
        prompt: "hello from playground",
      }),
    ).toEqual({
      max_tokens: 100,
      messages: [{ content: "hello from playground", role: "user" }],
      model: "playground-live",
      stream: false,
    });

    expect(
      buildPlaygroundResponsesRequest({
        model: "gpt55",
        prompt: "hello from responses",
      }),
    ).toEqual({
      input: "hello from responses",
      max_output_tokens: 100,
      model: "gpt55",
      store: false,
      stream: false,
    });

    expect(
      buildPlaygroundMessagesRequest({
        model: "opus48",
        prompt: "hello from messages",
      }),
    ).toEqual({
      max_tokens: 100,
      messages: [{ content: "hello from messages", role: "user" }],
      model: "opus48",
      stream: false,
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
});
