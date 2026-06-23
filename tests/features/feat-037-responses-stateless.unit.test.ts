import { describe, expect, it } from "vitest";
import {
  createGatewayResponsesErrorBody,
  normalizeOpenAIResponsesRequest,
} from "../../apps/gateway/src/responses";

describe("feat-037 OpenAI responses stateless endpoint", () => {
  it("normalizes stateless Responses API payloads for provider adapters", () => {
    expect(
      normalizeOpenAIResponsesRequest(
        {
          instructions: "Answer as a concise coding agent.",
          input: "Explain the change.",
          max_output_tokens: 128,
          model: "responses-coding",
          store: false,
          stream: false,
          temperature: 0.1,
        },
        "req_responses_unit",
      ),
    ).toEqual({
      ok: true,
      request: {
        input: "Explain the change.",
        instructions: "Answer as a concise coding agent.",
        maxOutputTokens: 128,
        stream: false,
        temperature: 0.1,
      },
    });
  });

  it("normalizes Responses message content parts from OpenAI-compatible agents", () => {
    expect(
      normalizeOpenAIResponsesRequest(
        {
          input: [
            {
              content: [{ text: "Follow repository conventions.", type: "input_text" }],
              role: "developer",
            },
            {
              content: [
                { text: "Inspect this error.", type: "input_text" },
                { text: "Keep the fix small.", type: "input_text" },
              ],
              role: "user",
            },
            {
              content: [{ text: "Previous answer.", type: "output_text" }],
              role: "assistant",
            },
          ],
          model: "responses-coding",
          stream: true,
        },
        "req_responses_parts_unit",
      ),
    ).toEqual({
      ok: true,
      request: {
        input: [
          { content: "Follow repository conventions.", role: "developer" },
          { content: "Inspect this error.\nKeep the fix small.", role: "user" },
          { content: "Previous answer.", role: "assistant" },
        ],
        stream: true,
      },
    });
  });

  it("rejects stateful Responses API fields with a stable unsupported error", () => {
    expect(
      normalizeOpenAIResponsesRequest(
        {
          input: "Continue.",
          model: "responses-coding",
          previous_response_id: "resp_previous",
        },
        "req_previous_unit",
      ),
    ).toEqual({
      body: createGatewayResponsesErrorBody("unsupported_stateful_responses", "req_previous_unit"),
      ok: false,
      statusCode: 400,
    });

    expect(
      normalizeOpenAIResponsesRequest(
        {
          input: "Store this.",
          model: "responses-coding",
          store: true,
        },
        "req_store_unit",
      ),
    ).toEqual({
      body: createGatewayResponsesErrorBody("unsupported_stateful_responses", "req_store_unit"),
      ok: false,
      statusCode: 400,
    });
  });

  it("keeps detailed runtime failure reasons in Responses error bodies", () => {
    expect(
      createGatewayResponsesErrorBody(
        "provider_protocol_unsupported",
        "req_protocol_unit",
        "Responses API cannot use provider claude_code.",
      ),
    ).toEqual({
      error: {
        code: "provider_protocol_unsupported",
        message: "Responses API cannot use provider claude_code.",
      },
      requestId: "req_protocol_unit",
    });
  });
});
