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
        maxOutputTokens: 128,
        stream: false,
        temperature: 0.1,
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
});
