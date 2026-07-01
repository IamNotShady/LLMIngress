import { describe, expect, it } from "vitest";
import {
  createGatewayAnthropicMessagesErrorBody,
  normalizeAnthropicMessagesRequest,
} from "../../packages/db/src/gateway-messages";

describe("feat-038 Anthropic messages endpoint", () => {
  it("normalizes Anthropic messages payloads for provider adapters", () => {
    expect(
      normalizeAnthropicMessagesRequest(
        {
          max_tokens: 512,
          messages: [{ content: "Say hi.", role: "user" }],
          model: "messages-coding",
          stream: false,
          system: "You are concise.",
          temperature: 0.2,
        },
        "req_messages_unit",
      ),
    ).toEqual({
      ok: true,
      request: {
        maxOutputTokens: 512,
        messages: [{ content: "Say hi.", role: "user" }],
        stream: false,
        system: "You are concise.",
        temperature: 0.2,
      },
    });
  });

  it("accepts an array system prompt and passes it through", () => {
    const system = [
      { text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", type: "text" },
      { text: "You are concise.", type: "text" },
    ];
    expect(
      normalizeAnthropicMessagesRequest(
        {
          max_tokens: 512,
          messages: [{ content: "Say hi.", role: "user" }],
          model: "messages-coding",
          system,
        },
        "req_array_system_unit",
      ),
    ).toEqual({
      ok: true,
      request: {
        maxOutputTokens: 512,
        messages: [{ content: "Say hi.", role: "user" }],
        system,
      },
    });
  });

  it("returns stable 400 errors for invalid Anthropic messages payloads", () => {
    expect(
      normalizeAnthropicMessagesRequest(
        {
          max_tokens: 512,
          messages: [],
          model: "messages-coding",
        },
        "req_invalid_messages_unit",
      ),
    ).toEqual({
      body: createGatewayAnthropicMessagesErrorBody(
        "invalid_messages_request",
        "req_invalid_messages_unit",
      ),
      ok: false,
      statusCode: 400,
    });
  });

  it("caps oversized max_tokens from Anthropic-compatible clients", () => {
    expect(
      normalizeAnthropicMessagesRequest(
        {
          max_tokens: 128_000,
          messages: [{ content: "Say hi.", role: "user" }],
          model: "messages-coding",
        },
        "req_oversized_messages_tokens",
      ),
    ).toMatchObject({
      ok: true,
      request: {
        maxOutputTokens: 16_384,
      },
    });
  });
});
