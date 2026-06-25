import { describe, expect, it } from "vitest";
import { normalizeAnthropicMessagesRequest } from "../../apps/gateway/src/messages";
import { createAnthropicProviderAdapter } from "../../packages/provider/src/adapters/anthropic";

describe("feat-068 Anthropic messages parameter passthrough", () => {
  it("normalizes common sampling stop metadata and safe Anthropic parameters", () => {
    const normalized = normalizeAnthropicMessagesRequest(
      {
        max_tokens: 2048,
        messages: [{ content: "Use the requested decoding options.", role: "user" }],
        metadata: { user_id: "agent-params-068" },
        model: "messages-params",
        service_tier: "auto",
        stop_sequences: ["</final>", "STOP_HERE"],
        temperature: 0.3,
        thinking: { budget_tokens: 1024, type: "enabled" },
        top_k: 40,
        top_p: 0.8,
      },
      "req_messages_params_unit",
    );

    expect(normalized).toEqual({
      ok: true,
      request: {
        maxOutputTokens: 2048,
        messages: [{ content: "Use the requested decoding options.", role: "user" }],
        metadata: { user_id: "agent-params-068" },
        serviceTier: "auto",
        stopSequences: ["</final>", "STOP_HERE"],
        temperature: 0.3,
        thinking: { budget_tokens: 1024, type: "enabled" },
        topK: 40,
        topP: 0.8,
      },
    });
  });

  it("rejects invalid passthrough parameter shapes", () => {
    expect(
      normalizeAnthropicMessagesRequest(
        {
          max_tokens: 2048,
          messages: [{ content: "bad stop sequence", role: "user" }],
          model: "messages-params",
          stop_sequences: ["ok", ""],
        },
        "req_bad_stop_sequences",
      ),
    ).toMatchObject({
      ok: false,
      statusCode: 400,
    });

    expect(
      normalizeAnthropicMessagesRequest(
        {
          max_tokens: 2048,
          messages: [{ content: "bad top k", role: "user" }],
          model: "messages-params",
          top_k: 4.5,
        },
        "req_bad_top_k",
      ),
    ).toMatchObject({
      ok: false,
      statusCode: 400,
    });
  });

  it("forwards only whitelisted Anthropic parameters to the provider payload", async () => {
    const normalized = normalizeAnthropicMessagesRequest(
      {
        anthropic_beta: "unsafe-header-style-param",
        extra_headers: { "x-api-key": "do-not-forward" },
        max_tokens: 2048,
        messages: [{ content: "Forward only safe params.", role: "user" }],
        metadata: { user_id: "agent-params-068" },
        model: "messages-params",
        service_tier: "auto",
        stop_sequences: ["</final>"],
        temperature: 0.3,
        thinking: { budget_tokens: 1024, type: "enabled" },
        top_k: 40,
        top_p: 0.8,
      },
      "req_messages_params_unit",
    );

    if (!normalized.ok) {
      throw new Error("Messages params request should normalize.");
    }

    const calls: Array<{ body: Record<string, unknown>; headers: Headers; url: string }> = [];
    const adapter = createAnthropicProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return new Response(
          JSON.stringify({
            content: [{ text: "ok", type: "text" }],
            id: "msg_params_068",
            role: "assistant",
            type: "message",
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        );
      },
    });

    const result = await adapter.messages({
      request: normalized.request,
      target: {
        apiKey: "sk-ant-params-unit",
        baseUrl: "https://anthropic.example/v1",
        modelId: "claude-sonnet-4-5",
      },
    });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toMatchObject({
      max_tokens: 2048,
      messages: [{ content: "Forward only safe params.", role: "user" }],
      metadata: { user_id: "agent-params-068" },
      model: "claude-sonnet-4-5",
      service_tier: "auto",
      stop_sequences: ["</final>"],
      temperature: 0.3,
      thinking: { budget_tokens: 1024, type: "enabled" },
      top_k: 40,
      top_p: 0.8,
    });
    expect(calls[0]?.body).not.toHaveProperty("anthropic_beta");
    expect(calls[0]?.body).not.toHaveProperty("extra_headers");
    expect(calls[0]?.headers.get("x-api-key")).toBe("sk-ant-params-unit");
  });
});
