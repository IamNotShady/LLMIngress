import { describe, expect, it } from "vitest";
import { providerRegistry } from "../../packages/config/src/provider-registry";
import {
  getOpenAICompatibleProviderTemplate,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
} from "../../packages/db/src/console-provider-templates";
import { chatCompletionsSupportsSubscriptionProvider } from "../../packages/gateway-runtime/src/gateway-chat-completions";
import { createGrokSubscriptionAdapter } from "../../packages/provider/src/adapters/subscription";
import { buildProviderConnectivityRequest } from "../../packages/provider/src/connectivity";
import { resolveProviderDescriptor } from "../../packages/provider/src/descriptor";
import { resolveProviderStreamingDialect } from "../../packages/provider/src/dialect";
import { buildProviderModelListRequest } from "../../packages/provider/src/model-list";
import {
  buildGrokSubscriptionHeaders,
  grokClientVersion,
} from "../../packages/provider/src/subscription";

// Batch 8 adds Grok as the fourth subscription provider and the first to route
// the chat_completions face. Field literals are transcribed from the local Batch
// 8 Grok plan so this test is an independent witness, not a mirror of the
// implementation.
const chatCompletionsEndpoint = { method: "POST", path: "chat/completions" };
const modelsEndpoint = { method: "GET", path: "models" };
const grokBase = "https://cli-chat-proxy.grok.com/v1";

// The six headers the proxy inference endpoints require (the User-Agent version
// gate returns HTTP 426 without them). No content-type here — the POST callers
// add it; this builder owns only the client-identity headers.
function grokHeaders(token: string): Record<string, string> {
  return {
    accept: "application/json",
    authorization: `Bearer ${token}`,
    "user-agent": `grok-shell/${grokClientVersion}`,
    "x-grok-client-mode": "headless",
    "x-grok-client-version": grokClientVersion,
    "x-xai-token-auth": "xai-grok-cli",
  };
}

describe("Batch 8 Grok — Feature A (OAuth + chat face)", () => {
  it("registers grok as a subscription provider with the popup OAuth config and chat face", () => {
    expect(providerRegistry.grok).toEqual({
      behavior: {
        connectivityProbeStyle: "grok",
        metadataKey: "xai",
        modelListStyle: "grok",
        quotaSource: { reason: "not_supported", supported: false },
        subscription: true,
        subscriptionAdapter: "grok",
      },
      creation: {
        mode: "template",
        selectorGroup: "subscription",
        baseUrl: grokBase,
      },
      displayName: "Grok",
      endpoints: { chat_completions: chatCompletionsEndpoint },
      modelListEndpoint: modelsEndpoint,
      oauth: {
        authorizeUrl: "https://auth.x.ai/oauth2/authorize",
        clientId: "b1a00492-073a-47ea-816f-4c329264a828",
        clientIdEnvVar: "GROK_OAUTH_CLIENT_ID",
        redirectUri: "http://127.0.0.1:56121/callback",
        revokeUrl: "https://auth.x.ai/oauth2/revoke",
        scope: "openid profile email offline_access grok-cli:access api:access",
        tokenEncoding: "form",
        tokenHeaders: { accept: "application/json" },
        tokenUrl: "https://auth.x.ai/oauth2/token",
      },
      providerKey: "grok",
      providerType: "subscription",
    });
    // Feature A ships the chat face only; the responses face and quota probe are
    // the follow-up feature.
    expect(providerRegistry.grok.endpoints.responses).toBeUndefined();
    expect(providerRegistry.grok.endpoints.messages).toBeUndefined();
    // Popup authorization-code OAuth: an authorizeUrl and redirectUri, never a
    // deviceCodeUrl.
    const oauth = providerRegistry.grok.oauth;
    expect(oauth && "authorizeUrl" in oauth).toBe(true);
    expect(oauth && "deviceCodeUrl" in oauth).toBe(false);
  });

  it("builds the six upstream client headers with the pinned grok-shell version", () => {
    expect(buildGrokSubscriptionHeaders("grok-token")).toEqual(grokHeaders("grok-token"));
    // The version constant threads through both the User-Agent and the client
    // version header (the 426 gate).
    expect(buildGrokSubscriptionHeaders("grok-token")["user-agent"]).toBe(
      `grok-shell/${grokClientVersion}`,
    );
    // Forwarded request headers are preserved, but the grok identity headers win.
    const merged = buildGrokSubscriptionHeaders("grok-token", {
      authorization: "Bearer stale-key",
      "x-custom": "keep",
    });
    expect(merged.authorization).toBe("Bearer grok-token");
    expect(merged["x-custom"]).toBe("keep");
    expect(merged["x-xai-token-auth"]).toBe("xai-grok-cli");
  });

  it("admits grok on the chat_completions face while still rejecting the older subscription providers", () => {
    // D3 guard: the chat filter becomes an adapter allowlist. grok and every
    // non-subscription provider pass; the three pre-existing subscription
    // providers must stay rejected so the allowlist is not accidentally widened.
    expect(chatCompletionsSupportsSubscriptionProvider("grok")).toBe(true);
    expect(chatCompletionsSupportsSubscriptionProvider("openai")).toBe(true);
    expect(chatCompletionsSupportsSubscriptionProvider("deepseek")).toBe(true);
    for (const rejected of ["claude_code", "openai_codex", "minimax_coding"]) {
      expect(chatCompletionsSupportsSubscriptionProvider(rejected), rejected).toBe(false);
    }
  });

  it("routes the grok chat adapter to base + /chat/completions with the client headers", async () => {
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> = {};
    const adapter = createGrokSubscriptionAdapter({
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "ok", role: "assistant" } }],
            id: "chatcmpl_grok",
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        );
      },
      timeoutMs: 200,
    });

    const result = await adapter.chatCompletion({
      headers: { "content-type": "application/json" },
      request: {
        messages: [{ content: "hi", role: "user" }],
        payload: { messages: [{ content: "hi", role: "user" }], stream: false },
      },
      target: { apiKey: "grok-oauth-token", baseUrl: grokBase, modelId: "grok-code" },
    });

    expect(result.ok).toBe(true);
    expect(capturedUrl).toBe("https://cli-chat-proxy.grok.com/v1/chat/completions");
    expect(capturedHeaders.get("authorization")).toBe("Bearer grok-oauth-token");
    expect(capturedHeaders.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(capturedHeaders.get("user-agent")).toBe(`grok-shell/${grokClientVersion}`);
    expect(capturedHeaders.get("x-grok-client-version")).toBe(grokClientVersion);
    expect(capturedHeaders.get("x-grok-client-mode")).toBe("headless");
    expect(capturedHeaders.get("content-type")).toBe("application/json");
    expect(capturedBody.model).toBe("grok-code");
  });

  it("carries the grok client headers on model discovery, connectivity, and the streaming dialect", () => {
    const descriptor = resolveProviderDescriptor("grok");
    expect(descriptor.modelListStyle).toBe("grok");
    expect(descriptor.connectivityProbeStyle).toBe("grok");

    // Model list: default /models URL, grok client headers.
    const modelListRequest = buildProviderModelListRequest({
      apiKey: "grok-oauth-token",
      baseUrl: grokBase,
      providerKey: "grok",
    });
    expect(modelListRequest.url).toBe("https://cli-chat-proxy.grok.com/v1/models");
    expect(modelListRequest.init.headers).toMatchObject(grokHeaders("grok-oauth-token"));

    // Connectivity: chat/completions probe with the grok client headers.
    const connectivityRequest = buildProviderConnectivityRequest({
      apiKey: "grok-oauth-token",
      provider: {
        baseUrl: grokBase,
        displayName: "Grok",
        id: "provider-grok",
        modelId: "grok-code",
        providerKey: "grok",
      },
    });
    expect(connectivityRequest.url).toBe("https://cli-chat-proxy.grok.com/v1/chat/completions");
    expect(connectivityRequest.init.method).toBe("POST");
    const connectivityHeaders = connectivityRequest.init.headers as Record<string, string>;
    expect(connectivityHeaders).toMatchObject(grokHeaders("grok-oauth-token"));
    expect(connectivityHeaders["content-type"]).toBe("application/json");

    // Streaming dialect: chat/completions supported, grok headers layered on the
    // protocol Bearer headers.
    const dialect = resolveProviderStreamingDialect("grok");
    expect(dialect.supportsPathSuffix("chat/completions")).toBe(true);
    expect(dialect.supportsPathSuffix("responses")).toBe(false);
    expect(dialect.supportsPathSuffix("messages")).toBe(false);
    const dialectHeaders = dialect.buildHeaders("grok-oauth-token", (apiKey) => ({
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    }));
    expect(dialectHeaders).toMatchObject(grokHeaders("grok-oauth-token"));
    expect(dialectHeaders["content-type"]).toBe("application/json");
    // The streaming URL and body are the OpenAI defaults (no transform).
    expect(dialect.buildUrl(grokBase, "chat/completions")).toBe(
      "https://cli-chat-proxy.grok.com/v1/chat/completions",
    );
    expect(dialect.transformBody({ stream: true }, "chat/completions")).toEqual({ stream: true });
  });

  it("places grok in the Console Subscription group with a single Chat Completions chip", () => {
    const subscriptionGroup = listProviderTemplateSelectorGroups().find(
      (group) => group.id === "subscription",
    );
    expect(subscriptionGroup?.label).toBe("Subscription");
    const subscriptionIds = subscriptionGroup?.templates.map((template) => template.id) ?? [];
    expect(subscriptionIds).toEqual(["openai_codex", "claude_code", "minimax_coding", "grok"]);

    const grokTemplate = subscriptionGroup?.templates.find((entry) => entry.id === "grok");
    expect(grokTemplate).toMatchObject({
      baseUrlMode: "user_remote",
      fixedBaseUrl: grokBase,
      providerKey: "grok",
      providerType: "subscription",
    });
    // Chat Completions chip (+ the models catalog), never a responses face yet.
    expect(Object.keys(grokTemplate?.endpoints ?? {})).toEqual(["chat_completions", "models"]);

    // grok is a subscription template, never an OpenAI-compatible paste-key one.
    expect(listOpenAICompatibleProviderTemplates().map((template) => template.id)).not.toContain(
      "grok",
    );
    expect(() => getOpenAICompatibleProviderTemplate("grok")).toThrow(
      /whitelisted provider template/,
    );
  });
});
