import { describe, expect, it } from "vitest";
import { buildAnthropicMessagesPayload } from "../../packages/provider/src/adapters/anthropic";
import {
  checkProviderConnectivity,
  selectProviderProbeModel,
} from "../../packages/provider/src/connectivity";
import {
  joinProviderStreamingUrl,
  resolveProviderStreamingDialect,
} from "../../packages/provider/src/dialect";

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

    expect(dialect.supportsPathSuffix("messages")).toBe(true);
    expect(dialect.supportsPathSuffix("responses")).toBe(false);
    expect(dialect.buildUrl("https://provider.test", "messages")).toBe(
      "https://provider.test/v1/messages",
    );
    expect(dialect.buildHeaders("claude-token", protocolHeaders)).toMatchObject({
      authorization: "Bearer claude-token",
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-app": "cli",
    });
    expect(dialect.transformBody({ system: "Use terse replies." }, "messages")).toEqual({
      system: "Use terse replies.",
    });
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
