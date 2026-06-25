import { describe, expect, it } from "vitest";
import { normalizeAnthropicMessagesRequest } from "../../apps/gateway/src/messages";
import { createAnthropicProviderAdapter } from "../../packages/provider/src/adapters/anthropic";

const claudeCodeMessages = [
  {
    content: [
      { text: "Inspect the current repository and summarize the entrypoints.", type: "text" },
    ],
    role: "user",
  },
  {
    content: [
      { text: "I will inspect the working directory.", type: "text" },
      {
        id: "toolu_feat_052",
        input: { command: "pwd" },
        name: "Bash",
        type: "tool_use",
      },
    ],
    role: "assistant",
  },
  {
    content: [
      {
        content: "/workspace/llmingress",
        tool_use_id: "toolu_feat_052",
        type: "tool_result",
      },
    ],
    role: "user",
  },
] as const;

const claudeCodeTools = [
  {
    description: "Run a shell command.",
    input_schema: {
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
      type: "object",
    },
    name: "Bash",
  },
] as const;

describe("feat-052 Claude Code messages request shape", () => {
  it("normalizes and forwards Claude Code content blocks and tools", async () => {
    const normalized = normalizeAnthropicMessagesRequest(
      {
        max_tokens: 1024,
        messages: claudeCodeMessages,
        model: "claude-code",
        system: "You are Claude Code running inside a repository.",
        tool_choice: { type: "auto" },
        tools: claudeCodeTools,
      },
      "req_claude_code_unit_052",
    );

    expect(normalized).toMatchObject({
      ok: true,
      request: {
        messages: claudeCodeMessages,
        system: "You are Claude Code running inside a repository.",
        toolChoice: { type: "auto" },
        tools: claudeCodeTools,
      },
    });
    if (!normalized.ok) {
      throw new Error("Claude Code messages request should normalize.");
    }

    const providerCalls: Array<{ body: unknown; headers: Headers; url: string }> = [];
    const adapter = createAnthropicProviderAdapter({
      fetch: async (url, init) => {
        providerCalls.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return new Response(
          JSON.stringify({
            content: [{ text: "ok", type: "text" }],
            id: "msg_feat_052",
            role: "assistant",
            type: "message",
          }),
          { status: 200 },
        );
      },
    });

    const result = await adapter.messages({
      request: normalized.request,
      target: {
        apiKey: "sk-anthropic-feat-052",
        baseUrl: "https://anthropic.example/v1",
        modelId: "claude-sonnet-4-5",
      },
    });

    expect(result.ok).toBe(true);
    expect(providerCalls).toEqual([
      {
        body: {
          max_tokens: 1024,
          messages: claudeCodeMessages,
          model: "claude-sonnet-4-5",
          system: "You are Claude Code running inside a repository.",
          tool_choice: { type: "auto" },
          tools: claudeCodeTools,
        },
        headers: expect.any(Headers),
        url: "https://anthropic.example/v1/messages",
      },
    ]);
    expect(providerCalls[0]?.headers.get("x-api-key")).toBe("sk-anthropic-feat-052");
  });
});
