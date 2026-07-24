import { describe, expect, it } from "vitest";
import {
  listProviderRouteEndpointProtocols,
  providerRegistry,
} from "../../packages/config/src/provider-registry";
import {
  getOpenAICompatibleProviderTemplate,
  listOpenAICompatibleProviderTemplates,
  listProviderTemplateSelectorGroups,
} from "../../packages/db/src/console-provider-templates";
import { chatCompletionsSupportsSubscriptionProvider } from "../../packages/gateway-runtime/src/gateway-chat-completions";
import { responsesSupportsSubscriptionProvider } from "../../packages/gateway-runtime/src/gateway-responses";
import { createGrokSubscriptionAdapter } from "../../packages/provider/src/adapters/subscription";
import { buildProviderConnectivityRequest } from "../../packages/provider/src/connectivity";
import { resolveProviderDescriptor } from "../../packages/provider/src/descriptor";
import { resolveProviderStreamingDialect } from "../../packages/provider/src/dialect";
import { buildProviderModelListRequest } from "../../packages/provider/src/model-list";
import {
  parseGrokCreditsQuota,
  parseGrokMonthlyQuota,
  quotaProbes,
  resolveQuotaProbe,
} from "../../packages/provider/src/quota-probe";
import {
  buildGrokSubscriptionHeaders,
  grokClientVersion,
} from "../../packages/provider/src/subscription";

// Batch 8 adds Grok as the fourth subscription provider and the first to route
// the chat_completions face. Field literals are transcribed from the local Batch
// 8 Grok plan so this test is an independent witness, not a mirror of the
// implementation.
const chatCompletionsEndpoint = { method: "POST", path: "chat/completions" };
const responsesEndpoint = { method: "POST", path: "responses" };
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
  it("registers grok as a subscription provider with the popup OAuth config and dual faces", () => {
    expect(providerRegistry.grok).toEqual({
      behavior: {
        connectivityProbeStyle: "grok",
        metadataKey: "xai",
        modelListStyle: "grok",
        // Feature B flips quotaSource to supported alongside quotaProbes.grok.
        quotaSource: { supported: true },
        subscription: true,
        subscriptionAdapter: "grok",
      },
      creation: {
        mode: "template",
        selectorGroup: "subscription",
        baseUrl: grokBase,
      },
      displayName: "Grok",
      // Feature B adds the responses face (the upstream's multi-agent variants
      // are responses-only) from the same proxy base.
      endpoints: { chat_completions: chatCompletionsEndpoint, responses: responsesEndpoint },
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
    // OpenAI-protocol faces only; never an Anthropic messages face.
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
    // The responses face is added by Feature B; the same grok header dialect
    // serves it. Never an Anthropic messages face.
    expect(dialect.supportsPathSuffix("responses")).toBe(true);
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

  it("places grok in the Console Subscription group with the chat and responses chips", () => {
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
    // Chat Completions + Responses chips (+ the models catalog), in endpoint-key
    // order.
    expect(Object.keys(grokTemplate?.endpoints ?? {})).toEqual([
      "chat_completions",
      "responses",
      "models",
    ]);

    // grok is a subscription template, never an OpenAI-compatible paste-key one.
    expect(listOpenAICompatibleProviderTemplates().map((template) => template.id)).not.toContain(
      "grok",
    );
    expect(() => getOpenAICompatibleProviderTemplate("grok")).toThrow(
      /whitelisted provider template/,
    );
  });
});

// Two proto3 traps the probe must tolerate (see §7 of the local Batch 8 Grok
// plan): a zero-value Cent serializes as an empty object, and a new period omits
// creditUsagePercent — both default to 0, never a parse failure.
const grokCreditsFixture = {
  config: {
    billingPeriodEnd: "2026-08-01T00:00:00Z",
    creditUsagePercent: 42.5,
    currentPeriod: { end: "2026-08-01T00:00:00Z", type: "weekly" },
  },
};
const grokMonthlyFixture = {
  config: {
    billingPeriodEnd: "2026-08-01T00:00:00Z",
    monthlyLimit: { val: 2000 },
    used: { val: 500 },
  },
};

function grokProbe() {
  const probe = resolveQuotaProbe("grok");
  if (!probe) {
    throw new Error("No quota probe registered for grok.");
  }
  return probe;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

// Routes the two grok billing requests by URL: ?format=credits vs the bare path.
function grokBillingFetch(
  handlers: {
    credits?: () => Response;
    legacy?: () => Response;
  },
  recorded?: Array<{ headers: Headers; url: string }>,
): typeof globalThis.fetch {
  return (async (url, init) => {
    const href = String(url);
    recorded?.push({ headers: new Headers(init?.headers), url: href });
    if (href.includes("format=credits")) {
      return handlers.credits?.() ?? jsonResponse({});
    }
    return handlers.legacy?.() ?? jsonResponse({});
  }) as typeof globalThis.fetch;
}

describe("Batch 8 Grok — Feature B (responses face + quota probe)", () => {
  it("adds the responses face and flips quotaSource to supported with a registered probe", () => {
    expect(providerRegistry.grok.endpoints.responses).toEqual(responsesEndpoint);
    expect(providerRegistry.grok.behavior.quotaSource).toEqual({ supported: true });
    expect(listProviderRouteEndpointProtocols("grok")).toEqual(["chat_completions", "responses"]);
    expect(typeof quotaProbes.grok).toBe("function");
  });

  it("extends the responses allowlist to codex-or-grok while keeping the others rejected", () => {
    // Guard: only codex and grok subscription adapters route responses; the
    // other subscription providers stay rejected.
    expect(responsesSupportsSubscriptionProvider("grok")).toBe(true);
    expect(responsesSupportsSubscriptionProvider("openai_codex")).toBe(true);
    expect(responsesSupportsSubscriptionProvider("openai")).toBe(true);
    for (const rejected of ["claude_code", "minimax_coding"]) {
      expect(responsesSupportsSubscriptionProvider(rejected), rejected).toBe(false);
    }
  });

  it("routes the grok responses adapter to base + /responses with the client headers", async () => {
    let capturedUrl = "";
    let capturedHeaders = new Headers();
    let capturedBody: Record<string, unknown> = {};
    const adapter = createGrokSubscriptionAdapter({
      fetch: async (url, init) => {
        capturedUrl = String(url);
        capturedHeaders = new Headers(init?.headers);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: "resp_grok", object: "response" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        });
      },
      timeoutMs: 200,
    });

    const result = await adapter.response?.({
      headers: { "content-type": "application/json" },
      request: {
        input: [{ content: [{ text: "hi", type: "input_text" }], role: "user" }],
        payload: {
          input: [{ content: [{ text: "hi", type: "input_text" }], role: "user" }],
          stream: false,
        },
      },
      target: { apiKey: "grok-oauth-token", baseUrl: grokBase, modelId: "grok-multi-agent" },
    });

    expect(result?.ok).toBe(true);
    expect(capturedUrl).toBe("https://cli-chat-proxy.grok.com/v1/responses");
    expect(capturedHeaders.get("authorization")).toBe("Bearer grok-oauth-token");
    expect(capturedHeaders.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(capturedHeaders.get("user-agent")).toBe(`grok-shell/${grokClientVersion}`);
    expect(capturedBody.model).toBe("grok-multi-agent");
  });

  it("probes both billing endpoints with the minimal three headers and maps the two windows", async () => {
    const recorded: Array<{ headers: Headers; url: string }> = [];
    const result = await grokProbe()({
      baseUrl: grokBase,
      credential: "grok-token",
      fetch: grokBillingFetch(
        {
          credits: () => jsonResponse(grokCreditsFixture),
          legacy: () => jsonResponse(grokMonthlyFixture),
        },
        recorded,
      ),
    });

    // Two requests: ?format=credits then the bare billing path.
    expect(recorded).toHaveLength(2);
    expect(recorded[0]?.url).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
    expect(recorded[1]?.url).toBe("https://cli-chat-proxy.grok.com/v1/billing");
    // Minimal three headers, no x-userid.
    for (const request of recorded) {
      expect(request.headers.get("authorization")).toBe("Bearer grok-token");
      expect(request.headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
      expect(request.headers.get("accept")).toBe("application/json");
      expect(request.headers.get("x-userid")).toBeNull();
    }

    expect(result.ok).toBe(true);
    const entries = result.ok ? result.entries : [];
    expect(entries).toEqual([
      {
        resetsAt: "2026-08-01T00:00:00.000Z",
        utilization: 0.425,
        window: "weekly",
      },
      {
        resetsAt: "2026-08-01T00:00:00.000Z",
        utilization: 0.25,
        window: "monthly",
      },
    ]);
  });

  it("tolerates the proto3 zero-value traps, skips a non-positive monthly limit, and degrades weekly", () => {
    // Trap 1: a new period omits creditUsagePercent -> utilization 0, still a window.
    expect(parseGrokCreditsQuota({ config: { currentPeriod: { type: "weekly" } } })).toEqual([
      { utilization: 0, window: "weekly" },
    ]);
    // Trap 2: a zero-value Cent serializes as {} -> used 0, not a parse failure.
    expect(parseGrokMonthlyQuota({ config: { monthlyLimit: { val: 1000 }, used: {} } })).toEqual([
      { utilization: 0, window: "monthly" },
    ]);
    // A non-positive (or absent) monthly limit produces no window.
    expect(
      parseGrokMonthlyQuota({ config: { monthlyLimit: { val: 0 }, used: { val: 5 } } }),
    ).toEqual([]);
    expect(parseGrokMonthlyQuota({ config: { used: { val: 5 } } })).toEqual([]);

    // Weekly (credits) failure degrades to the monthly window alone, never aborts.
    return grokProbe()({
      baseUrl: grokBase,
      credential: "grok-token",
      fetch: grokBillingFetch({
        credits: () => jsonResponse({ error: "boom" }, 500),
        legacy: () => jsonResponse(grokMonthlyFixture),
      }),
    }).then((result) => {
      expect(result.ok).toBe(true);
      expect(result.ok ? result.entries : []).toEqual([
        { resetsAt: "2026-08-01T00:00:00.000Z", utilization: 0.25, window: "monthly" },
      ]);
    });
  });

  it("maps 401 to unauthorized and other non-2xx (incl. 402 exhaustion) to probe_failed", async () => {
    const unauthorized = await grokProbe()({
      baseUrl: grokBase,
      credential: "grok-token",
      fetch: grokBillingFetch({ credits: () => jsonResponse({ error: "denied" }, 401) }),
    });
    expect(unauthorized.ok).toBe(false);
    expect(unauthorized.ok ? null : unauthorized.errorCode).toBe("unauthorized");

    // 402 is upstream exhaustion at the inference endpoint, never a probe-level
    // quota signal: the probe reports probe_failed, not unauthorized.
    const exhausted = await grokProbe()({
      baseUrl: grokBase,
      credential: "grok-token",
      fetch: grokBillingFetch({
        credits: () => jsonResponse({ error: "payment required" }, 402),
        legacy: () => jsonResponse({ error: "payment required" }, 402),
      }),
    });
    expect(exhausted.ok ? null : exhausted.errorCode).toBe("probe_failed");

    // Both requests failing (5xx) is a probe failure.
    const serverError = await grokProbe()({
      baseUrl: grokBase,
      credential: "grok-token",
      fetch: grokBillingFetch({
        credits: () => jsonResponse({ error: "boom" }, 500),
        legacy: () => jsonResponse({ error: "boom" }, 500),
      }),
    });
    expect(serverError.ok ? null : serverError.errorCode).toBe("probe_failed");
  });
});
