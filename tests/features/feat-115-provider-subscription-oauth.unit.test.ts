import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";
import {
  createClaudeCodeProviderAdapter,
  createCodexSubscriptionAdapter,
} from "../../packages/provider/src/adapters/subscription";
import { checkProviderConnectivity } from "../../packages/provider/src/connectivity";
import {
  buildProviderModelListRequest,
  parseProviderModelList,
} from "../../packages/provider/src/model-list";
import {
  buildProviderOAuthAuthorizeUrl,
  exchangeProviderOAuthCode,
  parseProviderOAuthCallbackInput,
  refreshProviderOAuthToken,
  revokeProviderOAuthToken,
} from "../../packages/provider/src/oauth";

const root = resolve(import.meta.dirname, "../..");

describe("feat-115 provider subscription OAuth", () => {
  it("declares provider_oauth schema and subscription provider type", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0045" && candidate.name === "provider_subscription_oauth",
    );
    const sql = migration?.sql ?? "";

    expect(sql).toContain("provider_type in ('api_key', 'local', 'subscription')");
    expect(sql).toContain("create table if not exists provider_oauth");
    expect(sql).toContain("provider_id uuid not null references providers(id) on delete cascade");
    expect(sql).toContain("check (label is null or char_length(label) <= 100)");
    expect(sql).toContain("check (priority >= 0 and priority <= 100)");
    expect(sql).toContain("last_test_status text not null default 'unknown'");
    expect(sql).toContain("provider_oauth_provider_enabled_priority_idx");
    expect(sql).not.toMatch(/^\s*oauth_provider\s+text\b/m);
  });

  it("allows subscription provider templates in the provider whitelist constraint", () => {
    const migration = loadSqlMigrations().find(
      (candidate) =>
        candidate.id === "0046" && candidate.name === "allow_subscription_provider_templates",
    );
    const sql = migration?.sql ?? "";

    expect(sql).toContain("providers_template_id_whitelisted");
    expect(sql).toContain("'openai_codex'");
    expect(sql).toContain("'claude_code'");
  });

  it("adds provider_oauth to scheduled backup coverage", () => {
    const backupSource = readFileSync(resolve(root, "apps/worker/src/backup.ts"), "utf8");

    expect(backupSource).toContain('"provider_oauth"');
  });

  it("builds PKCE authorize URLs and parses manual callback input", () => {
    const openaiUrl = buildProviderOAuthAuthorizeUrl({
      codeChallenge: "challenge",
      providerKey: "openai_codex",
      state: "state-1",
    });
    expect(openaiUrl).toContain("https://auth.openai.com/oauth/authorize?");
    expect(openaiUrl).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    expect(openaiUrl).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
    expect(openaiUrl).toContain("code_challenge=challenge");

    const claudeUrl = buildProviderOAuthAuthorizeUrl({
      codeChallenge: "challenge",
      providerKey: "claude_code",
      state: "state-2",
    });
    expect(claudeUrl).toContain("https://claude.ai/oauth/authorize?");
    expect(claudeUrl).toContain("client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(claudeUrl).toContain(
      "redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback",
    );

    expect(
      parseProviderOAuthCallbackInput("http://localhost:1455/auth/callback?code=abc&state=state-1"),
    ).toEqual({ code: "abc", state: "state-1" });
    expect(parseProviderOAuthCallbackInput("claude-code#state-2")).toEqual({
      code: "claude-code",
      state: "state-2",
    });
  });

  it("keeps subscription OAuth authorization and callback entry inside the Console dialog", () => {
    const sectionsSource = readFileSync(
      resolve(root, "apps/console/src/app/_modules/sections.tsx"),
      "utf8",
    );
    const routeSource = readFileSync(
      resolve(root, "apps/console/src/app/api/provider-oauth/route.ts"),
      "utf8",
    );
    const oauthServerSource = readFileSync(
      resolve(root, "apps/console/src/server/provider-oauth.ts"),
      "utf8",
    );
    const dbProviderSource = readFileSync(resolve(root, "packages/db/src/providers.ts"), "utf8");

    expect(sectionsSource).toContain("providerAuthorizeUrl");
    expect(sectionsSource).toContain("providerOAuthLabelValue");
    expect(sectionsSource).toContain("provider-oauth-complete-label");
    expect(sectionsSource).toContain("provider-oauth-complete-priority");
    expect(sectionsSource).toContain("Authorization URL");
    expect(sectionsSource).toContain("Callback URL or authorization code");
    expect(sectionsSource).toContain("provider-oauth-add-form");
    expect(sectionsSource).not.toContain("Start OAuth");
    expect(routeSource).toContain("providerAuthorizeUrl");
    expect(routeSource).toContain("providerOAuthLabelValue");
    expect(routeSource).toContain('readNullableText(form, "label")');
    expect(routeSource).not.toContain("renderProviderOAuthAuthorizePage");
    expect(oauthServerSource).toContain('provider.providerKey === "claude_code"');
    expect(oauthServerSource).toContain("pkce.codeVerifier : pkce.state");
    expect(dbProviderSource).toContain(
      "from provider_oauth\n        where completed_at is not null\n          and encrypted_token is not null",
    );
    expect(dbProviderSource).toContain("label = case when");
    expect(dbProviderSource).toContain("priority = case when");
  });

  it("exchanges and refreshes OAuth token blobs", async () => {
    const requests: Array<{
      body: Record<string, string>;
      bodyType: "form" | "json";
      url: string;
    }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      requests.push({
        body:
          body instanceof URLSearchParams
            ? Object.fromEntries(body.entries())
            : JSON.parse(String(body)),
        bodyType: body instanceof URLSearchParams ? "form" : "json",
        url: String(url),
      });
      return jsonResponse(200, {
        access_token: "access-token",
        expires_in: 3600,
        refresh_token: "refresh-token",
        scope: "openid profile",
      });
    };

    const exchanged = await exchangeProviderOAuthCode({
      code: "code-1",
      codeVerifier: "verifier",
      fetch,
      nowMs: () => 1_000,
      providerKey: "openai_codex",
    });
    const claudeExchanged = await exchangeProviderOAuthCode({
      code: "claude-code",
      codeVerifier: "claude-state",
      fetch,
      nowMs: () => 1_500,
      providerKey: "claude_code",
    });
    const refreshed = await refreshProviderOAuthToken({
      fetch,
      nowMs: () => 2_000,
      providerKey: "claude_code",
      refreshToken: "refresh-token",
    });

    expect(exchanged).toMatchObject({
      accessToken: "access-token",
      expiresAt: 3_601_000,
      refreshToken: "refresh-token",
      scopes: ["openid", "profile"],
    });
    expect(claudeExchanged).toMatchObject({ accessToken: "access-token", expiresAt: 3_601_500 });
    expect(refreshed).toMatchObject({ accessToken: "access-token", expiresAt: 3_602_000 });
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/oauth/token",
      "https://api.anthropic.com/v1/oauth/token",
      "https://api.anthropic.com/v1/oauth/token",
    ]);
    expect(requests.map((request) => request.bodyType)).toEqual(["form", "json", "json"]);
    expect(requests[0]?.body).toMatchObject({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: "code-1",
      code_verifier: "verifier",
      grant_type: "authorization_code",
    });
    expect(requests[1]?.body).toMatchObject({
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      code: "claude-code",
      code_verifier: "claude-state",
      grant_type: "authorization_code",
      state: "claude-state",
    });
    expect(requests[2]?.body).toMatchObject({
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      grant_type: "refresh_token",
      refresh_token: "refresh-token",
    });
  });

  it("revokes OpenAI OAuth tokens and treats Claude Code revoke as local-only", async () => {
    const requests: Array<{
      body: Record<string, string>;
      headers: HeadersInit | undefined;
      url: string;
    }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body;
      requests.push({
        body: body instanceof URLSearchParams ? Object.fromEntries(body.entries()) : {},
        headers: init?.headers,
        url: String(url),
      });
      return jsonResponse(200, {});
    };

    await revokeProviderOAuthToken({
      accessToken: "openai-access",
      fetch,
      providerKey: "openai_codex",
    });
    await revokeProviderOAuthToken({
      accessToken: "claude-access",
      fetch,
      providerKey: "claude_code",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      body: {
        client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
        token: "openai-access",
      },
      headers: {
        accept: "application/json",
      },
      url: "https://auth.openai.com/oauth/revoke",
    });
  });

  it("builds subscription model list requests and parses Codex models", () => {
    expect(
      buildProviderModelListRequest({
        apiKey: "oauth-token",
        baseUrl: "https://chatgpt.com/backend-api",
        providerKey: "openai_codex",
      }),
    ).toEqual({
      init: {
        headers: {
          authorization: "Bearer oauth-token",
          "content-type": "application/json",
          originator: "codex_cli_rs",
          "user-agent": "codex_cli_rs/0.0.0 (Unknown 0; unknown) unknown",
        },
        method: "GET",
      },
      url: "https://chatgpt.com/backend-api/codex/models?client_version=0.128.0",
    });
    expect(
      buildProviderModelListRequest({
        apiKey: "oauth-token",
        baseUrl: "https://api.anthropic.com",
        providerKey: "claude_code",
      }).url,
    ).toBe("https://api.anthropic.com/v1/models?limit=100");

    expect(
      parseProviderModelList({
        models: [
          { display_name: "GPT Codex", slug: "gpt-codex", visibility: "list" },
          { display_name: "Hidden", slug: "hidden", visibility: "hidden" },
        ],
      }),
    ).toEqual([
      {
        capabilityMetadata: { code: true },
        contextWindow: 200000,
        displayName: "GPT Codex",
        modelId: "gpt-codex",
        supportsStreaming: true,
        supportsTools: true,
      },
    ]);
  });

  it("checks OpenAI Codex and Claude Code connectivity with subscription protocols", async () => {
    const requests: Array<{ body: unknown; headers: HeadersInit | undefined; url: string }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        body: JSON.parse(String(init?.body)),
        headers: init?.headers,
        url: String(url),
      });
      return jsonResponse(200, { id: "ok", output: [] });
    };

    await checkProviderConnectivity({
      apiKey: "oauth-token",
      fetch,
      nowMs: sequenceNow(100, 110),
      provider: {
        baseUrl: "https://chatgpt.com/backend-api",
        displayName: "OpenAI Codex",
        id: "provider-codex",
        modelId: "gpt-codex",
        providerKey: "openai_codex",
      },
    });
    await checkProviderConnectivity({
      apiKey: "oauth-token",
      fetch,
      nowMs: sequenceNow(200, 220),
      provider: {
        baseUrl: "https://api.anthropic.com",
        displayName: "Claude Code",
        id: "provider-claude-code",
        modelId: "claude-sonnet",
        providerKey: "claude_code",
      },
    });

    expect(requests[0]).toMatchObject({
      body: {
        input: [{ content: [{ text: "ping", type: "input_text" }], role: "user" }],
        instructions: "You are a helpful assistant.",
        model: "gpt-codex",
        store: false,
        stream: true,
      },
      url: "https://chatgpt.com/backend-api/codex/responses",
    });
    expect(requests[0]?.headers).toMatchObject({
      authorization: "Bearer oauth-token",
      originator: "codex_cli_rs",
    });
    expect(requests[1]).toMatchObject({
      body: {
        max_tokens: 1,
        messages: [{ content: "ping", role: "user" }],
        model: "claude-sonnet",
        stream: false,
      },
      url: "https://api.anthropic.com/v1/messages",
    });
    expect(requests[1]?.headers).toMatchObject({
      authorization: "Bearer oauth-token",
      "anthropic-version": "2023-06-01",
      "x-app": "cli",
    });
  });

  it("strips Codex-unsupported Responses parameters before forwarding", async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    const adapter = createCodexSubscriptionAdapter({
      fetch: async (url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          url: String(url),
        });
        return jsonResponse(200, { id: "resp_1", output: [] });
      },
    });

    const result = await adapter.response?.({
      request: {
        input: "hello",
        instructions: undefined,
        maxOutputTokens: 2048,
        stream: false,
        temperature: 0.7,
      },
      target: {
        apiKey: "oauth-token",
        baseUrl: "https://chatgpt.com/backend-api",
        modelId: "gpt-5.4",
      },
    });

    expect(result?.ok).toBe(true);
    expect(requests[0]?.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(requests[0]?.body).toEqual({
      input: [{ content: [{ text: "hello", type: "input_text" }], role: "user" }],
      instructions: "You are a helpful assistant.",
      model: "gpt-5.4",
      store: false,
      stream: true,
    });
    expect(requests[0]?.body).not.toHaveProperty("temperature");
    expect(requests[0]?.body).not.toHaveProperty("max_output_tokens");
  });

  it("strips Claude Code unsupported sampling parameters before forwarding", async () => {
    const requests: Array<{ body: Record<string, unknown>; url: string }> = [];
    const adapter = createClaudeCodeProviderAdapter({
      fetch: async (url, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          url: String(url),
        });
        return jsonResponse(200, { content: [], id: "msg_1", type: "message" });
      },
    });

    const result = await adapter.messages({
      request: {
        maxOutputTokens: 2048,
        messages: [{ content: "hello", role: "user" }],
        stream: false,
        temperature: 0.7,
        topK: 40,
        topP: 0.9,
      },
      target: {
        apiKey: "oauth-token",
        baseUrl: "https://api.anthropic.com",
        modelId: "claude-opus-4-7",
      },
    });

    expect(result.ok).toBe(true);
    expect(requests[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(requests[0]?.body).toMatchObject({
      max_tokens: 2048,
      messages: [{ content: "hello", role: "user" }],
      model: "claude-opus-4-7",
      stream: false,
    });
    expect(requests[0]?.body).not.toHaveProperty("temperature");
    expect(requests[0]?.body).not.toHaveProperty("top_k");
    expect(requests[0]?.body).not.toHaveProperty("top_p");
  });

  it("normalizes Codex SSE responses into response output text", async () => {
    const adapter = createCodexSubscriptionAdapter({
      fetch: async () =>
        textResponse(
          200,
          [
            'data: {"type":"response.output_text.delta","delta":"hello"}',
            'data: {"type":"response.output_text.delta","delta":" world"}',
            "data: [DONE]",
            "",
          ].join("\n\n"),
        ),
    });

    const result = await adapter.response?.({
      request: {
        input: "hello",
      },
      target: {
        apiKey: "oauth-token",
        baseUrl: "https://chatgpt.com/backend-api",
        modelId: "gpt-5.4",
      },
    });

    expect(result?.ok).toBe(true);
    expect(result?.body).toMatchObject({
      output: [
        {
          content: [{ text: "hello world", type: "output_text" }],
          role: "assistant",
          type: "message",
        },
      ],
    });
  });

  it("injects the Claude Code system identifier on the OAuth messages path", async () => {
    const calls: Array<{ body: { system?: unknown }; headers: Headers; url: string }> = [];
    const adapter = createClaudeCodeProviderAdapter({
      fetch: async (url, init) => {
        calls.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
          url: String(url),
        });
        return jsonResponse(200, {
          content: [{ text: "pong", type: "text" }],
          id: "msg_feat_115",
          role: "assistant",
          type: "message",
        });
      },
    });

    const result = await adapter.messages({
      request: {
        maxOutputTokens: 16,
        messages: [{ content: "ping", role: "user" }],
        system: "You are a helpful assistant.",
      },
      target: {
        apiKey: "oauth-token",
        baseUrl: "https://api.anthropic.com",
        modelId: "claude-sonnet-4-5",
      },
    });

    expect(result.ok).toBe(true);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.body.system).toEqual([
      { text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.", type: "text" },
      { text: "You are a helpful assistant.", type: "text" },
    ]);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer oauth-token");
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
    status,
  });
}

function sequenceNow(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
