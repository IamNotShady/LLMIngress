import { describe, expect, it } from "vitest";
import {
  createGatewayChatCompletionErrorBody,
  normalizeOpenAIChatCompletionRequest,
  readGatewayMasterKeySource,
} from "../../apps/gateway/src/chat-completions";

describe("feat-036 OpenAI chat completions endpoint", () => {
  it("normalizes OpenAI chat completion payloads for provider adapters", () => {
    expect(
      normalizeOpenAIChatCompletionRequest(
        {
          max_tokens: 256,
          messages: [
            { content: "You are concise.", role: "system" },
            { content: "Say hi.", role: "user" },
          ],
          model: "coding-fast",
          stream: false,
          temperature: 0.2,
        },
        "req_chat_unit",
      ),
    ).toEqual({
      ok: true,
      request: {
        maxOutputTokens: 256,
        messages: [
          { content: "You are concise.", role: "system" },
          { content: "Say hi.", role: "user" },
        ],
        stream: false,
        temperature: 0.2,
      },
    });
  });

  it("returns stable 400 errors for invalid chat completion payloads", () => {
    expect(normalizeOpenAIChatCompletionRequest({ messages: [] }, "req_invalid_unit")).toEqual({
      body: createGatewayChatCompletionErrorBody("invalid_chat_request", "req_invalid_unit"),
      ok: false,
      statusCode: 400,
    });
  });

  it("caps oversized max_tokens from OpenAI-compatible clients", () => {
    expect(
      normalizeOpenAIChatCompletionRequest(
        {
          max_tokens: 65_536,
          messages: [{ content: "hello", role: "user" }],
          model: "mix",
        },
        "req_oversized_tokens",
      ),
    ).toMatchObject({
      ok: true,
      request: {
        maxOutputTokens: 16_384,
      },
    });
  });

  it("reads the Gateway master key source from process-style env", () => {
    expect(readGatewayMasterKeySource({ MASTER_KEY: "inline-master-key" })).toEqual({
      kind: "inline",
      value: "inline-master-key",
    });
    expect(readGatewayMasterKeySource({ MASTER_KEY_FILE: "/tmp/master-key" })).toEqual({
      kind: "file",
      path: "/tmp/master-key",
    });
  });
});
