import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { gatewayCorsHeaders, mergeAccessControlExposeHeaders } from "../../apps/gateway/src/cors";
import { closePostgresPools } from "../../packages/db/src/client";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { readGatewayRequestId } from "../../packages/gateway-runtime/src/gateway-auth";
import { normalizeOpenAIChatCompletionRequest } from "../../packages/gateway-runtime/src/gateway-chat-completions";
import type { GatewayRouteCandidateSnapshot } from "../../packages/gateway-runtime/src/gateway-config-reload";
import {
  gatewayRouteTagHeader,
  readGatewayProviderRequestHeaders,
  readGatewayRequestedRouteTag,
} from "../../packages/gateway-runtime/src/gateway-header-passthrough";
import { normalizeAnthropicMessagesRequest } from "../../packages/gateway-runtime/src/gateway-messages";
import {
  attachGatewayProviderCredentials,
  refreshProviderOAuthTokenWithLock,
} from "../../packages/gateway-runtime/src/gateway-provider-credentials";
import { estimateTextTokens } from "../../packages/gateway-runtime/src/gateway-request-metadata";
import { normalizeOpenAIResponsesRequest } from "../../packages/gateway-runtime/src/gateway-responses";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "../../packages/security/src/secret-encryption";

describe("gateway request hygiene", () => {
  afterAll(async () => {
    await closePostgresPools();
  });

  it("accepts only safe client request ids", () => {
    expect(readGatewayRequestId({ "x-request-id": "abc-123._:id" })).toBe("abc-123._:id");
    expect(readGatewayRequestId({ "x-request-id": "bad id\n" })).toMatch(/^gw_/);
    expect(readGatewayRequestId({ "x-request-id": "x".repeat(200) })).toMatch(/^gw_/);
  });

  it("filters only transport-owned request headers before provider forwarding", () => {
    expect(
      readGatewayProviderRequestHeaders({
        authorization: "Bearer api-key-key",
        "content-length": "999",
        "content-type": "text/plain",
        cookie: "session=secret",
        host: "gateway.local",
        "openai-beta": "responses=v1",
        "openai-organization": "org_123",
        "openai-project": "proj_123",
        origin: "http://console.local",
        "proxy-authorization": "Basic secret",
        referer: "http://console.local/playground",
        "sec-ch-ua": '"Chromium";v="126"',
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "transfer-encoding": "chunked",
        "user-agent": "browser-user-agent",
        "x-api-key": "api-key-x-key",
        "x-client-request-id": "client-req-1",
        "x-llmingress-route-tag": "fast",
        "x-provider-feature": ["one", "two"],
      }),
    ).toEqual({
      "openai-beta": "responses=v1",
      "openai-organization": "org_123",
      "openai-project": "proj_123",
      "x-client-request-id": "client-req-1",
      "x-provider-feature": "one, two",
    });
  });

  it("reads the requested route tag as a normalized single value", () => {
    expect(gatewayRouteTagHeader).toBe("x-llmingress-route-tag");
    expect(readGatewayRequestedRouteTag({ "x-llmingress-route-tag": "  Fast  " })).toBe("fast");
    expect(
      readGatewayRequestedRouteTag({ "x-llmingress-route-tag": ["long-context", "fast"] }),
    ).toBe("long-context");
    // An unusable tag is not a refusal: it simply matches nothing and the route
    // falls back to the default candidate.
    expect(readGatewayRequestedRouteTag({ "x-llmingress-route-tag": "not a tag!" })).toBe(
      "not a tag!",
    );
    expect(readGatewayRequestedRouteTag({ "x-llmingress-route-tag": "   " })).toBeUndefined();
    expect(readGatewayRequestedRouteTag({})).toBeUndefined();
  });

  it("allows and exposes provider protocol headers for browser clients", () => {
    const headers = gatewayCorsHeaders("http://localhost:3000");

    expect(headers["access-control-allow-headers"]).toContain("x-llmingress-route-tag");
    expect(headers["access-control-allow-headers"]).toContain("openai-organization");
    expect(headers["access-control-allow-headers"]).toContain("openai-project");
    expect(headers["access-control-allow-headers"]).toContain("openai-beta");
    expect(headers["access-control-allow-headers"]).toContain("anthropic-version");
    expect(headers["access-control-allow-headers"]).toContain("anthropic-beta");
    expect(headers["access-control-expose-headers"]).toContain("x-llmingress-request-id");
    expect(headers["access-control-expose-headers"]).toContain("x-ratelimit-remaining-requests");
    expect(headers["access-control-expose-headers"]).toContain("request-id");
    expect(headers["access-control-expose-headers"]).toContain(
      "anthropic-ratelimit-requests-remaining",
    );
  });

  it("appends gateway exposed headers without replacing the provider value", () => {
    const providerValue = "x-provider-trace, X-Request-ID";
    const gatewayValue =
      gatewayCorsHeaders("http://localhost:3000")["access-control-expose-headers"];

    const merged = mergeAccessControlExposeHeaders(providerValue, gatewayValue);

    expect(merged).toMatch(/^x-provider-trace, X-Request-ID,/);
    expect(merged).toContain("x-llmingress-request-id");
    expect(merged?.match(/x-request-id/gi)).toHaveLength(1);
    expect(mergeAccessControlExposeHeaders(providerValue, undefined)).toBe(providerValue);
  });

  it("estimates CJK text as one token per character", () => {
    expect(estimateTextTokens(["你好世界"])).toBe(4);
    expect(estimateTextTokens(["abcdefgh"])).toBe(2);
    expect(estimateTextTokens(["你好ab"])).toBe(3);
  });

  it("normalizes whitelisted OpenAI passthrough parameters and max_completion_tokens", () => {
    const requestBody = {
      max_completion_tokens: 2048,
      max_tokens: 12,
      messages: [{ content: "hi", role: "user" }],
      seed: 7,
      stop: ["END"],
      top_p: 0.9,
    };
    const normalized = normalizeOpenAIChatCompletionRequest(requestBody, "req-1");

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.maxOutputTokens).toBe(2048);
      expect(normalized.request.payload).toEqual(requestBody);
      expect(normalized.request.passthrough).toEqual({
        max_completion_tokens: 2048,
        max_tokens: 12,
        seed: 7,
        stop: ["END"],
        top_p: 0.9,
      });
    }
  });

  it("rejects malformed Responses input while leaving other protocol boundaries unchanged", () => {
    const chatBody = {
      max_completion_tokens: "provider-owned",
      messages: "provider-owned",
      stream: "provider-owned",
      tool_choice: "provider-owned",
      tools: ["provider-owned"],
    };
    const responsesBody = {
      input: { provider: "owned" },
      parallel_tool_calls: "provider-owned",
      tool_choice: "provider-owned",
      tools: ["provider-owned"],
    };
    const messagesBody = {
      max_tokens: "provider-owned",
      messages: "provider-owned",
      stream: "provider-owned",
      system: { provider: "owned" },
      tool_choice: "provider-owned",
    };

    const chat = normalizeOpenAIChatCompletionRequest(chatBody, "req-1");
    const responses = normalizeOpenAIResponsesRequest(responsesBody, "req-1");
    const messages = normalizeAnthropicMessagesRequest(messagesBody, "req-1");

    expect(chat.ok).toBe(true);
    expect(responses.ok).toBe(false);
    expect(messages.ok).toBe(true);
    if (chat.ok) {
      expect(chat.request.payload).toEqual(chatBody);
    }
    if (messages.ok) {
      expect(messages.request.payload).toEqual(messagesBody);
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
        input: [{ content: [{ text: "pwd", type: "input_text" }], role: "user" }],
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
        input: [{ content: [{ text: "run pwd", type: "input_text" }], role: "user" }, toolOutput],
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.input).toEqual([
        { content: [{ text: "run pwd", type: "input_text" }], role: "user" },
        toolOutput,
      ]);
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

  it("rejects Responses string input and shorthand string message content", () => {
    const reasoningItem = {
      encrypted_content: "encrypted-reasoning",
      summary: [],
      type: "reasoning",
    };
    const assistantPlaceholder = {
      content: "",
      role: "assistant",
    };
    expect(normalizeOpenAIResponsesRequest({ input: "hi" }, "req-1")).toMatchObject({
      ok: false,
      statusCode: 400,
    });
    expect(
      normalizeOpenAIResponsesRequest(
        { input: [reasoningItem, assistantPlaceholder], store: false },
        "req-1",
      ),
    ).toMatchObject({ ok: false, statusCode: 400 });
  });

  it("keeps provider-owned Responses fields in the raw provider payload", () => {
    const requestBody = {
      input: [{ content: [{ text: "hi", type: "input_text" }], role: "user" }],
      parallel_tool_calls: "provider-owned",
      tool_choice: "provider-owned",
      tools: ["provider-owned"],
    };
    const normalized = normalizeOpenAIResponsesRequest(requestBody, "req-1");

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.payload).toEqual(requestBody);
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
        encryptionKeySource: { kind: "inline", value: "test-master-key" },
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

  it("anchors a subscription candidate to the provider base so a bare connection never inherits a sibling's resource_url", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_oauth_base_anchor_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const encryption = createSecretEncryption({ kind: "inline", value: "test-master-key" });
      const providerId = randomUUID();
      const providerBase = "https://provider-base.test/anthropic/v1";
      const withResourceOAuthId = randomUUID();
      const bareOAuthId = randomUUID();
      const resourceUrl = "https://token-a.test/anthropic/v1";

      await fixture.query(
        `
          insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
          values ($1, 'subscription', 'minimax_coding', 'MiniMax', $2, true)
        `,
        [providerId, providerBase],
      );
      // Primary connection (priority 0) carries a per-token resource_url.
      await fixture.query(
        `
          insert into provider_oauth (
            id, provider_id, priority, enabled, encrypted_token, token_expires_at, completed_at
          )
          values ($1, $2, 0, true, $3, null, now())
        `,
        [
          withResourceOAuthId,
          providerId,
          JSON.stringify(
            encryption.encrypt(
              JSON.stringify({
                accessToken: "token-a",
                expiresAt: null,
                refreshToken: null,
                resourceUrl,
                scopes: [],
                tokenType: "Bearer",
              }),
            ),
          ),
        ],
      );
      // Second connection (priority 1) has no resource_url.
      await fixture.query(
        `
          insert into provider_oauth (
            id, provider_id, priority, enabled, encrypted_token, token_expires_at, completed_at
          )
          values ($1, $2, 1, true, $3, null, now())
        `,
        [
          bareOAuthId,
          providerId,
          JSON.stringify(
            encryption.encrypt(
              JSON.stringify({
                accessToken: "token-b",
                expiresAt: null,
                refreshToken: null,
                scopes: [],
                tokenType: "Bearer",
              }),
            ),
          ),
        ],
      );

      const [candidate] = await attachGatewayProviderCredentials({
        candidates: [candidateSnapshot({ providerId, providerKey: "minimax_coding" })],
        databaseUrl: fixture.databaseUrl,
        encryptionKeySource: { kind: "inline", value: "test-master-key" },
      });

      // candidate.baseUrl is the provider base anchor, never the primary token's
      // resource_url — otherwise the bare rotated key would egress to the first
      // connection's base.
      expect(candidate?.baseUrl).toBe(providerBase);

      const keyA = candidate?.providerApiKeys?.find(
        (key) => key.providerOAuthId === withResourceOAuthId,
      );
      const keyB = candidate?.providerApiKeys?.find((key) => key.providerOAuthId === bareOAuthId);
      expect(keyA?.baseUrl).toBe(resourceUrl);
      expect(keyB?.baseUrl).toBeUndefined();
      // Per-token override resolves at each call site: the resource_url key uses
      // its own base; the bare key falls back to the provider base, not keyA's.
      expect(keyA?.baseUrl ?? candidate?.baseUrl).toBe(resourceUrl);
      expect(keyB?.baseUrl ?? candidate?.baseUrl).toBe(providerBase);
    } finally {
      await fixture.dispose();
    }
  });

  it("preserves a prior resource_url when an OAuth refresh response omits one", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_oauth_refresh_resource_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const encryption = createSecretEncryption({ kind: "inline", value: "test-master-key" });
      const providerId = randomUUID();
      const providerOAuthId = randomUUID();
      const resourceUrl = "https://api.minimax.io/anthropic/v1";
      const expired = {
        accessToken: "expired-token",
        expiresAt: Date.now() - 60_000,
        refreshToken: "refresh-token",
        resourceUrl,
        scopes: [],
        tokenType: "Bearer",
      };

      await fixture.query(
        `
          insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
          values ($1, 'subscription', 'minimax_coding', 'MiniMax', $2, true)
        `,
        [providerId, resourceUrl],
      );
      await fixture.query(
        `
          insert into provider_oauth (
            id, provider_id, encrypted_token, token_expires_at, completed_at
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

      const refreshed = await refreshProviderOAuthTokenWithLock({
        databaseUrl: fixture.databaseUrl,
        encryption,
        providerKey: "minimax_coding",
        providerOAuthId,
        // MiniMax's refresh response frequently omits resource_url.
        refresh: async () => ({
          accessToken: "fresh-token",
          expiresAt: Date.now() + 600_000,
          refreshToken: "refresh-token-2",
          scopes: [],
          tokenType: "Bearer",
        }),
      });

      // The returned blob keeps the prior resource_url so egress still targets
      // the per-token base after a refresh...
      expect(refreshed.resourceUrl).toBe(resourceUrl);
      // ...and the persisted ciphertext carries it too.
      const stored = await fixture.query<{ encrypted_token: EncryptedSecret }>(
        "select encrypted_token from provider_oauth where id = $1",
        [providerOAuthId],
      );
      const storedBlob = JSON.parse(
        encryption.decrypt(stored.rows[0]?.encrypted_token as EncryptedSecret),
      );
      expect(storedBlob.resourceUrl).toBe(resourceUrl);
      expect(storedBlob.accessToken).toBe("fresh-token");
    } finally {
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
    weight: null,
    ...overrides,
  };
}
