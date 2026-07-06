import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePostgresPools } from "../../packages/db/src/client";
import { readGatewayRequestId } from "../../packages/db/src/gateway-auth";
import { normalizeOpenAIChatCompletionRequest } from "../../packages/db/src/gateway-chat-completions";
import type { GatewayRouteCandidateSnapshot } from "../../packages/db/src/gateway-config-reload";
import { normalizeOpenAIEmbeddingsRequest } from "../../packages/db/src/gateway-embeddings";
import { normalizeAnthropicMessagesRequest } from "../../packages/db/src/gateway-messages";
import {
  attachGatewayProviderCredentials,
  refreshProviderOAuthTokenWithLock,
} from "../../packages/db/src/gateway-provider-credentials";
import { estimateTextTokens } from "../../packages/db/src/gateway-request-metadata";
import { normalizeOpenAIResponsesRequest } from "../../packages/db/src/gateway-responses";
import { selectGatewayBaselineCandidate } from "../../packages/db/src/gateway-runtime-helpers";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createSecretEncryption } from "../../packages/security/src/secret-encryption";

describe("gateway request hygiene", () => {
  afterAll(async () => {
    await closePostgresPools();
  });

  it("accepts only safe client request ids", () => {
    expect(readGatewayRequestId({ "x-request-id": "abc-123._:id" })).toBe("abc-123._:id");
    expect(readGatewayRequestId({ "x-request-id": "bad id\n" })).toMatch(/^gw_/);
    expect(readGatewayRequestId({ "x-request-id": "x".repeat(200) })).toMatch(/^gw_/);
  });

  it("estimates CJK text as one token per character", () => {
    expect(estimateTextTokens(["你好世界"])).toBe(4);
    expect(estimateTextTokens(["abcdefgh"])).toBe(2);
    expect(estimateTextTokens(["你好ab"])).toBe(3);
  });

  it("selects the baseline candidate without mutating the route snapshot", () => {
    const second = candidateSnapshot({ candidateOrder: 2 });
    const first = candidateSnapshot({ candidateOrder: 1 });
    const routePolicy = {
      candidates: [second, first],
      id: "route-1",
      strategy: "fixed",
      virtualModelId: "vm-1",
      virtualModelName: "vm",
    };

    expect(selectGatewayBaselineCandidate(routePolicy)).toBe(first);
    expect(routePolicy.candidates).toEqual([second, first]);
  });

  it("normalizes whitelisted OpenAI passthrough parameters and max_completion_tokens", () => {
    const normalized = normalizeOpenAIChatCompletionRequest(
      {
        max_completion_tokens: 2048,
        max_tokens: 12,
        messages: [{ content: "hi", role: "user" }],
        seed: 7,
        stop: ["END"],
        top_p: 0.9,
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.maxOutputTokens).toBe(2048);
      expect(normalized.request.passthrough).toEqual({
        max_completion_tokens: 2048,
        seed: 7,
        stop: ["END"],
        top_p: 0.9,
      });
    }
  });

  it("preserves official OpenAI chat fields and message content parts", () => {
    const messages = [
      { content: [{ text: "Follow policy.", type: "text" }], name: "policy", role: "developer" },
      {
        content: [
          { text: "Inspect these inputs.", type: "text" },
          { image_url: { detail: "high", url: "data:image/png;base64,AAA=" }, type: "image_url" },
          { input_audio: { data: "AAAA", format: "wav" }, type: "input_audio" },
          { file: { file_id: "file_123" }, type: "file" },
        ],
        role: "user",
      },
      {
        audio: { id: "audio_123" },
        content: null,
        role: "assistant",
        tool_calls: [
          {
            function: { arguments: "{}", name: "run" },
            id: "call_123",
            type: "function",
          },
        ],
      },
      { content: [{ text: "ok", type: "text" }], role: "tool", tool_call_id: "call_123" },
      { content: "legacy ok", name: "legacy_fn", role: "function" },
    ];
    const normalized = normalizeOpenAIChatCompletionRequest(
      {
        audio: { format: "wav", voice: "alloy" },
        max_completion_tokens: 64,
        messages,
        metadata: { trace: "chat" },
        modalities: ["text", "audio"],
        prediction: { content: "expected", type: "content" },
        service_tier: "priority",
        store: true,
        stream_options: { include_usage: true },
        web_search_options: { search_context_size: "low" },
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.messages).toEqual(messages);
      expect(normalized.request.passthrough).toMatchObject({
        audio: { format: "wav", voice: "alloy" },
        max_completion_tokens: 64,
        metadata: { trace: "chat" },
        modalities: ["text", "audio"],
        prediction: { content: "expected", type: "content" },
        service_tier: "priority",
        store: true,
        stream_options: { include_usage: true },
        web_search_options: { search_context_size: "low" },
      });
    }
  });

  it("normalizes Responses tools, tool_choice, and parallel_tool_calls", () => {
    const tool = {
      description: "Run a terminal command",
      name: "terminal",
      parameters: { properties: { command: { type: "string" } }, type: "object" },
      type: "function",
    };
    const normalized = normalizeOpenAIResponsesRequest(
      {
        input: "pwd",
        parallel_tool_calls: false,
        tool_choice: "required",
        tools: [tool],
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.tools).toEqual([tool]);
      expect(normalized.request.toolChoice).toBe("required");
      expect(normalized.request.parallelToolCalls).toBe(false);
    }
  });

  it("normalizes raw Responses input items without rewriting tool outputs", () => {
    const toolOutput = {
      call_id: "call_terminal",
      output: '{"stdout":"ok"}',
      type: "function_call_output",
    };
    const normalized = normalizeOpenAIResponsesRequest(
      {
        input: [{ content: "run pwd", role: "user" }, toolOutput],
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.input).toEqual([{ content: "run pwd", role: "user" }, toolOutput]);
    }
  });

  it("normalizes Responses image content parts without rewriting them", () => {
    const imagePart = {
      image_url: "data:image/png;base64,iVBORw0KGgo=",
      type: "input_image",
    };
    const normalized = normalizeOpenAIResponsesRequest(
      {
        input: [
          {
            content: [{ text: "describe this image", type: "input_text" }, imagePart],
            role: "user",
          },
        ],
        stream: true,
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.input).toEqual([
        {
          content: [{ text: "describe this image", type: "input_text" }, imagePart],
          role: "user",
        },
      ]);
    }
  });

  it("preserves official Responses state and top-level fields", () => {
    const inputMessage = {
      content: [
        { text: "summarize", type: "input_text" },
        { file_id: "file_123", type: "input_file" },
      ],
      phase: "request",
      role: "user",
      status: "completed",
      type: "message",
    };
    const itemReference = { id: "item_123", type: "item_reference" };
    const normalized = normalizeOpenAIResponsesRequest(
      {
        background: true,
        conversation: "conv_123",
        include: ["file_search_call.results"],
        input: [inputMessage, itemReference],
        max_tool_calls: 3,
        metadata: { trace: "responses" },
        previous_response_id: "resp_123",
        prompt: { id: "pmpt_123", variables: { topic: "gateway" } },
        reasoning: { effort: "medium" },
        store: true,
        text: { format: { type: "text" } },
        top_p: 0.8,
        truncation: "auto",
        user: "end-user-123",
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.input).toEqual([inputMessage, itemReference]);
      expect(normalized.request.passthrough).toMatchObject({
        background: true,
        conversation: "conv_123",
        include: ["file_search_call.results"],
        max_tool_calls: 3,
        metadata: { trace: "responses" },
        previous_response_id: "resp_123",
        prompt: { id: "pmpt_123", variables: { topic: "gateway" } },
        reasoning: { effort: "medium" },
        store: true,
        text: { format: { type: "text" } },
        top_p: 0.8,
        truncation: "auto",
        user: "end-user-123",
      });
    }
  });

  it("normalizes Embeddings token inputs and passthrough fields", () => {
    const normalized = normalizeOpenAIEmbeddingsRequest(
      {
        encoding_format: "base64",
        input: [
          [1, 2, 3],
          [4, 5],
        ],
        user: "end-user-123",
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.input).toEqual([
        [1, 2, 3],
        [4, 5],
      ]);
      expect(normalized.request.passthrough).toEqual({
        encoding_format: "base64",
        user: "end-user-123",
      });
    }
  });

  it("preserves Anthropic Messages top-level provider fields", () => {
    const normalized = normalizeAnthropicMessagesRequest(
      {
        betas: ["mcp-client-2025-04-04"],
        container: { type: "auto" },
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        max_tokens: 128,
        mcp_servers: [{ name: "tools", type: "url", url: "https://mcp.example.test" }],
        messages: [
          {
            content: [
              { text: "Use the uploaded file.", type: "text" },
              { file_id: "file_123", type: "container_upload" },
            ],
            role: "user",
          },
        ],
        service_tier: "auto",
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.passthrough).toMatchObject({
        betas: ["mcp-client-2025-04-04"],
        container: { type: "auto" },
        context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
        mcp_servers: [{ name: "tools", type: "url", url: "https://mcp.example.test" }],
      });
    }
  });

  it("rejects malformed Responses tool fields", () => {
    expect(normalizeOpenAIResponsesRequest({ input: "hi", tools: ["bad"] }, "req-1").ok).toBe(
      false,
    );
    expect(
      normalizeOpenAIResponsesRequest({ input: "hi", tool_choice: "invalid" }, "req-1").ok,
    ).toBe(false);
    expect(
      normalizeOpenAIResponsesRequest({ input: "hi", parallel_tool_calls: "yes" }, "req-1").ok,
    ).toBe(false);
  });

  it("refreshes an expired OAuth token once under concurrent row-lock contention", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_oauth_single_flight_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const encryption = createSecretEncryption({ kind: "inline", value: "test-master-key" });
      const providerId = randomUUID();
      const providerOAuthId = randomUUID();
      const expired = {
        accessToken: "expired-token",
        expiresAt: Date.now() - 60_000,
        refreshToken: "refresh-token",
        scopes: [],
        tokenType: "Bearer",
      };
      const refreshed = {
        accessToken: "fresh-token",
        expiresAt: Date.now() + 600_000,
        refreshToken: "refresh-token",
        scopes: ["chat"],
        tokenType: "Bearer" as const,
      };
      let refreshCalls = 0;

      await fixture.query(
        `
          insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
          values ($1, 'subscription', 'openai_codex', 'OpenAI Codex', 'http://provider.test/v1', true)
        `,
        [providerId],
      );
      await fixture.query(
        `
          insert into provider_oauth (
            id,
            provider_id,
            encrypted_token,
            token_expires_at,
            completed_at
          )
          values ($1, $2, $3, $4, now())
        `,
        [
          providerOAuthId,
          providerId,
          JSON.stringify(encryption.encrypt(JSON.stringify(expired))),
          new Date(expired.expiresAt),
        ],
      );

      const refresh = async () => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return refreshed;
      };

      const [first, second] = await Promise.all([
        refreshProviderOAuthTokenWithLock({
          databaseUrl: fixture.databaseUrl,
          encryption,
          providerKey: "openai_codex",
          providerOAuthId,
          refresh,
        }),
        refreshProviderOAuthTokenWithLock({
          databaseUrl: fixture.databaseUrl,
          encryption,
          providerKey: "openai_codex",
          providerOAuthId,
          refresh,
        }),
      ]);

      expect(refreshCalls).toBe(1);
      expect(first.accessToken).toBe("fresh-token");
      expect(second.accessToken).toBe("fresh-token");
    } finally {
      await fixture.dispose();
    }
  });

  it("does not hold the outer credential pool client while refreshing OAuth tokens", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_oauth_pool_release_${randomUUID().replaceAll("-", "_")}`,
    });
    const originalPoolMax = process.env.LLMINGRESS_DB_POOL_MAX;
    await closePostgresPools();
    process.env.LLMINGRESS_DB_POOL_MAX = "1";
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const encryption = createSecretEncryption({ kind: "inline", value: "test-master-key" });
      const providerId = randomUUID();
      const providerOAuthId = randomUUID();
      const expired = {
        accessToken: "expired-token",
        expiresAt: Date.now() - 60_000,
        refreshToken: "refresh-token",
        scopes: [],
        tokenType: "Bearer",
      };
      const refreshed = {
        accessToken: "fresh-token",
        expiresAt: Date.now() + 600_000,
        refreshToken: "refresh-token",
        scopes: ["chat"],
        tokenType: "Bearer",
      };
      let refreshCalls = 0;

      await fixture.query(
        `
          insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
          values ($1, 'subscription', 'openai_codex', 'OpenAI Codex', 'http://provider.test/v1', true)
        `,
        [providerId],
      );
      await fixture.query(
        `
          insert into provider_oauth (
            id,
            provider_id,
            encrypted_token,
            token_expires_at,
            completed_at
          )
          values ($1, $2, $3, $4, now())
        `,
        [
          providerOAuthId,
          providerId,
          JSON.stringify(encryption.encrypt(JSON.stringify(expired))),
          new Date(expired.expiresAt),
        ],
      );

      const attached = await attachGatewayProviderCredentials({
        candidates: [candidateSnapshot({ providerId, providerKey: "openai_codex" })],
        databaseUrl: fixture.databaseUrl,
        masterKeySource: { kind: "inline", value: "test-master-key" },
        refreshProviderOAuthToken: async () => {
          refreshCalls += 1;
          return refreshed;
        },
      });

      expect(refreshCalls).toBe(1);
      expect(attached[0]?.apiKey).toBe("fresh-token");
      expect(attached[0]?.providerApiKeys[0]?.providerOAuthId).toBe(providerOAuthId);
    } finally {
      if (originalPoolMax === undefined) {
        delete process.env.LLMINGRESS_DB_POOL_MAX;
      } else {
        process.env.LLMINGRESS_DB_POOL_MAX = originalPoolMax;
      }
      await closePostgresPools();
      await fixture.dispose();
    }
  });
});

function candidateSnapshot(
  overrides: Partial<GatewayRouteCandidateSnapshot> = {},
): GatewayRouteCandidateSnapshot {
  return {
    candidateOrder: 1,
    displayName: "Fake Model",
    healthStatus: "healthy",
    modelId: "fake-model",
    price: {
      modelId: "fake-model",
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId: randomUUID(),
    providerKey: "openai",
    providerModelId: randomUUID(),
    ...overrides,
  };
}
