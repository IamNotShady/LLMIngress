import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";
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
    expect(refreshed).toMatchObject({ accessToken: "access-token", expiresAt: 3_602_000 });
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/oauth/token",
      "https://api.anthropic.com/v1/oauth/token",
    ]);
    expect(requests.map((request) => request.bodyType)).toEqual(["form", "json"]);
    expect(requests[0]?.body).toMatchObject({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code: "code-1",
      code_verifier: "verifier",
      grant_type: "authorization_code",
    });
    expect(requests[1]?.body).toMatchObject({
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      grant_type: "refresh_token",
      refresh_token: "refresh-token",
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
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

function sequenceNow(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
