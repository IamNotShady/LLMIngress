import { describe, expect, it } from "vitest";
import {
  buildAnthropicMessagesPayload,
  createAnthropicProviderAdapter,
} from "../../packages/provider/src/adapters/anthropic";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";
import { createClaudeCodeProviderAdapter } from "../../packages/provider/src/adapters/subscription";
import {
  checkProviderConnectivity,
  selectProviderProbeModel,
} from "../../packages/provider/src/connectivity";
import {
  joinProviderStreamingUrl,
  resolveProviderStreamingDialect,
} from "../../packages/provider/src/dialect";
import { claudeCodeBetaFlags } from "../../packages/provider/src/subscription";

const protocolHeaders = (apiKey: string) => ({
  authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
});

describe("provider streaming dialects", () => {
  it("uses default URL and protocol headers for ordinary providers", () => {
    const dialect = resolveProviderStreamingDialect("unknown_provider");

    expect(joinProviderStreamingUrl("https://provider.test/v1", "chat/completions")).toBe(
      "https://provider.test/v1/chat/completions",
    );
    expect(dialect.buildUrl("https://provider.test/v1", "chat/completions")).toBe(
      "https://provider.test/v1/chat/completions",
    );
    expect(dialect.buildHeaders("key-default", protocolHeaders)).toEqual({
      authorization: "Bearer key-default",
      "content-type": "application/json",
    });
    expect(dialect.supportsPathSuffix("responses")).toBe(true);
    expect(dialect.transformBody({ stream: true }, "chat/completions")).toEqual({
      stream: true,
    });
  });

  it("adds OpenRouter attribution headers", () => {
    const dialect = resolveProviderStreamingDialect("openrouter");

    expect(dialect.buildHeaders("key-openrouter", protocolHeaders)).toMatchObject({
      authorization: "Bearer key-openrouter",
      "content-type": "application/json",
      "HTTP-Referer": "https://llmingress.local",
      "X-OpenRouter-Title": "LLMIngress",
    });
  });

  it("does not define usage-request body mutations for OpenAI-compatible dialects", () => {
    for (const providerKey of ["google", "lmstudio", "openai"]) {
      const dialect = resolveProviderStreamingDialect(providerKey);

      expect(dialect.transformBody({ stream: true }, "chat/completions")).toEqual({
        stream: true,
      });
    }
  });

  it("maps Codex subscriptions to the responses dialect", () => {
    const dialect = resolveProviderStreamingDialect("openai_codex");

    expect(dialect.supportsPathSuffix("responses")).toBe(true);
    expect(dialect.supportsPathSuffix("chat/completions")).toBe(false);
    expect(dialect.buildUrl("https://provider.test/v1", "responses")).toBe(
      "https://provider.test/v1/codex/responses",
    );
    expect(dialect.buildHeaders("codex-token", protocolHeaders)).toMatchObject({
      authorization: "Bearer codex-token",
      "content-type": "application/json",
      originator: "codex_cli_rs",
    });
    expect(
      dialect.transformBody(
        {
          input: "hello",
          stream: true,
          temperature: 0.2,
        },
        "responses",
      ),
    ).toMatchObject({
      input: "hello",
      stream: true,
      temperature: 0.2,
    });
  });

  it("maps Claude Code subscriptions to the messages dialect", () => {
    const dialect = resolveProviderStreamingDialect("claude_code");
    const headers = dialect.buildHeaders("claude-token", (apiKey) => ({
      ...protocolHeaders(apiKey),
      "anthropic-beta": "context-1m-2025-08-07,claude-code-20250219",
      "anthropic-version": "2024-01-01",
    }));

    expect(dialect.supportsPathSuffix("messages")).toBe(true);
    expect(dialect.supportsPathSuffix("responses")).toBe(false);
    expect(dialect.buildUrl("https://provider.test", "messages")).toBe(
      "https://provider.test/v1/messages",
    );
    expect(headers).toMatchObject({
      authorization: "Bearer claude-token",
      "anthropic-version": "2024-01-01",
      "content-type": "application/json",
      "x-app": "cli",
    });
    const betas = readCommaList(headers["anthropic-beta"]);
    expect(betas).toContain("context-1m-2025-08-07");
    for (const requiredBeta of readCommaList(claudeCodeBetaFlags)) {
      expect(betas).toContain(requiredBeta);
    }
    expect(new Set(betas).size).toBe(betas.length);
    expect(dialect.transformBody({ system: "Use terse replies." }, "messages")).toEqual({
      system: "Use terse replies.",
    });
  });
});

describe("provider adapter headers", () => {
  it("forwards OpenAI protocol headers, keeps provider auth, and returns provider headers", async () => {
    let upstreamHeaders = new Headers();
    const adapter = createOpenAIProviderAdapter({
      fetch: async (_url, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: "chatcmpl_123", object: "chat.completion" }), {
          headers: {
            "content-length": "999",
            "content-type": "application/json",
            "x-ratelimit-remaining-requests": "42",
            "x-request-id": "provider-openai-request",
          },
          status: 200,
        });
      },
      timeoutMs: 200,
    });

    const result = await adapter.chatCompletion({
      headers: {
        authorization: "Bearer agent-key",
        "openai-beta": "responses=v1",
        "openai-organization": "org_123",
        "openai-project": "proj_123",
        "x-client-request-id": "client-req-1",
      },
      request: {
        messages: [{ content: "hi", role: "user" }],
        payload: { messages: [{ content: "hi", role: "user" }] },
      },
      target: { apiKey: "provider-key", baseUrl: "https://provider.test/v1", modelId: "model-1" },
    });

    expect(upstreamHeaders.get("authorization")).toBe("Bearer provider-key");
    expect(upstreamHeaders.get("openai-organization")).toBe("org_123");
    expect(upstreamHeaders.get("openai-project")).toBe("proj_123");
    expect(upstreamHeaders.get("openai-beta")).toBe("responses=v1");
    expect(upstreamHeaders.get("x-client-request-id")).toBe("client-req-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers).toEqual({
        "content-type": "application/json",
        "x-ratelimit-remaining-requests": "42",
        "x-request-id": "provider-openai-request",
      });
    }
  });

  it("forwards Anthropic beta/version headers, keeps provider auth, and returns provider headers", async () => {
    let upstreamHeaders = new Headers();
    const adapter = createAnthropicProviderAdapter({
      fetch: async (_url, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: "msg_123", type: "message" }), {
          headers: {
            "content-encoding": "gzip",
            "content-type": "application/json",
            "request-id": "provider-anthropic-request",
            "retry-after": "2",
          },
          status: 200,
        });
      },
      timeoutMs: 200,
    });

    const result = await adapter.messages({
      headers: {
        "anthropic-beta": "context-1m-2025-08-07",
        "anthropic-version": "2024-01-01",
        "x-api-key": "agent-key",
      },
      request: {
        maxOutputTokens: 128,
        messages: [{ content: "hi", role: "user" }],
        payload: { max_tokens: 128, messages: [{ content: "hi", role: "user" }] },
      },
      target: { apiKey: "provider-key", baseUrl: "https://provider.test/v1", modelId: "model-1" },
    });

    expect(upstreamHeaders.get("anthropic-beta")).toBe("context-1m-2025-08-07");
    expect(upstreamHeaders.get("anthropic-version")).toBe("2024-01-01");
    expect(upstreamHeaders.get("x-api-key")).toBe("provider-key");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.headers).toEqual({
        "content-type": "application/json",
        "request-id": "provider-anthropic-request",
        "retry-after": "2",
      });
    }
  });

  it("merges Claude Code Agent beta headers with required subscription beta flags", async () => {
    let upstreamHeaders = new Headers();
    const adapter = createClaudeCodeProviderAdapter({
      fetch: async (_url, init) => {
        upstreamHeaders = new Headers(init?.headers);
        return new Response(JSON.stringify({ id: "msg_123", type: "message" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
      timeoutMs: 200,
    });

    const result = await adapter.messages({
      headers: {
        "anthropic-beta": "context-1m-2025-08-07, claude-code-20250219",
        "anthropic-version": "2024-01-01",
      },
      request: {
        maxOutputTokens: 128,
        messages: [{ content: "hi", role: "user" }],
        payload: { max_tokens: 128, messages: [{ content: "hi", role: "user" }] },
      },
      target: {
        apiKey: "subscription-token",
        baseUrl: "https://provider.test",
        modelId: "model-1",
      },
    });

    expect(result.ok).toBe(true);
    expect(upstreamHeaders.get("authorization")).toBe("Bearer subscription-token");
    expect(upstreamHeaders.get("anthropic-version")).toBe("2024-01-01");
    const betas = readCommaList(upstreamHeaders.get("anthropic-beta"));
    expect(betas).toContain("context-1m-2025-08-07");
    for (const requiredBeta of readCommaList(claudeCodeBetaFlags)) {
      expect(betas).toContain(requiredBeta);
    }
    expect(new Set(betas).size).toBe(betas.length);
  });
});

describe("Anthropic provider payloads", () => {
  it("forwards Anthropic message payloads unchanged except for the selected model", () => {
    const payload = buildAnthropicMessagesPayload(
      {
        maxOutputTokens: 64,
        messages: [{ content: "ping", role: "user" }],
        payload: {
          max_tokens: 64,
          messages: [{ content: "ping", role: "user" }],
          temperature: 0.7,
          top_k: 40,
          top_p: 0.9,
        },
        temperature: 0.7,
        topK: 40,
        topP: 0.9,
      },
      {
        apiKey: "sk-test",
        baseUrl: "https://api.anthropic.com/v1",
        modelId: "claude-sonnet-5",
      },
    );

    expect(payload).toMatchObject({
      max_tokens: 64,
      model: "claude-sonnet-5",
      temperature: 0.7,
      top_k: 40,
      top_p: 0.9,
    });
  });
});

function readCommaList(value: string | null | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

describe("provider connectivity probe model selection", () => {
  it("skips OpenAI instruct models when choosing a chat-completions probe", () => {
    expect(
      selectProviderProbeModel([
        {
          contextWindow: 4096,
          inputUsdPerMillionTokens: 1.5,
          modelId: "gpt-3.5-turbo",
          outputUsdPerMillionTokens: 2,
        },
        {
          contextWindow: 4096,
          inputUsdPerMillionTokens: 0.5,
          modelId: "gpt-3.5-turbo-instruct",
          outputUsdPerMillionTokens: 1.5,
        },
      ]),
    ).toBe("gpt-3.5-turbo");
  });

  it("uses max_completion_tokens for OpenAI GPT-5 probes", async () => {
    let requestBody: unknown;
    const result = await checkProviderConnectivity({
      apiKey: "sk-test",
      fetch: async (_url, init) => {
        requestBody = JSON.parse(String(init?.body));
        return new Response("{}", { status: 200 });
      },
      nowMs: () => Date.parse("2026-07-05T00:00:00.000Z"),
      provider: {
        baseUrl: "https://api.openai.com/v1",
        displayName: "OpenAI",
        id: "provider-openai",
        modelId: "gpt-5-nano-2025-08-07",
        providerKey: "openai",
      },
    });

    expect(result.ok).toBe(true);
    expect(requestBody).toMatchObject({ max_completion_tokens: 16 });
    expect(requestBody).not.toHaveProperty("max_tokens");
  });
});
