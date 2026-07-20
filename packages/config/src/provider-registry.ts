// Single source of truth for static provider metadata. This module holds data
// and pure query functions only — form validation, OAuth flows, adapter request
// construction, and the price-sync engine live in their own packages and derive
// their facts from here.

/** Outward, routable protocol face. Canonical definition for the whole repo. */
export const routeEndpointProtocols = ["chat_completions", "responses", "messages"] as const;
export type RouteEndpointProtocol = (typeof routeEndpointProtocols)[number];

export type ProviderEndpoint = { method: "GET" | "POST"; path: string };
export type ProviderType = "api_key" | "local" | "subscription";
export type ProviderAuthBehavior = { header: string; scheme: string };

export type ProviderOAuthConfig = {
  authorizeUrl: string;
  clientId: string;
  defaultParams?: Record<string, string>;
  redirectUri: string;
  revokeUrl?: string;
  scope: string;
  tokenEncoding: "form" | "json";
  tokenHeaders?: Record<string, string>;
  tokenUrl: string;
};

export type ProviderModelListStyle =
  | "anthropic"
  | "claude_code"
  | "codex"
  | "lmstudio"
  | "openrouter";
export type ProviderConnectivityProbeStyle = "anthropic" | "claude_code" | "codex";
export type ProviderSubscriptionAdapter = "claude_code" | "codex";

/**
 * Whether Worker should schedule an upstream quota probe for this provider.
 * Carries no endpoint, field mapping, or shape tag — those live entirely in
 * `packages/provider/src/quota-probe.ts`. Absent means not supported.
 */
export type ProviderQuotaSource =
  | { supported: true }
  | { reason: "not_supported" | "requires_separate_credential"; supported: false };

/** Runtime behavior flags. Formerly `ProviderDescriptor` in @llmingress/provider. */
export type ProviderBehavior = {
  connectivityProbeStyle?: ProviderConnectivityProbeStyle;
  fixedApiKeyBaseUrl?: string;
  local?: boolean;
  metadataKey?: string;
  modelListStyle?: ProviderModelListStyle;
  oauthStateFromCodeVerifier?: boolean;
  openRouterAttribution?: boolean;
  priceSyncSupported?: boolean;
  quotaSource?: ProviderQuotaSource;
  reasoningAwareProbe?: boolean;
  subscription?: boolean;
  subscriptionAdapter?: ProviderSubscriptionAdapter;
};

export type KnownProviderKey =
  | "anthropic"
  | "claude_code"
  | "deepseek"
  | "google"
  | "llama_cpp"
  | "lmstudio"
  | "minimax"
  | "moonshot"
  | "ollama"
  | "openai"
  | "openai_codex"
  | "openrouter"
  | "qwen"
  | "xai"
  | "zai";

/**
 * Providers whose upstream credential comes from an OAuth subscription flow.
 * The array is the runtime carrier for the type; a unit test pins it to the
 * entries' `behavior.subscription` flags so the type and the registry data
 * cannot drift apart.
 */
export const subscriptionProviderKeys = ["claude_code", "openai_codex"] as const;
export type SubscriptionProviderKey = (typeof subscriptionProviderKeys)[number];

export type ProviderRegistryEntry = {
  behavior: ProviderBehavior;
  creation:
    | {
        mode: "template";
        selectorGroup: "subscription" | "remote_api_key" | "local";
        auth?: ProviderAuthBehavior;
        baseUrl?: string;
        baseUrlPlaceholder?: string;
      }
    | { mode: "direct"; selectorGroup: "remote_api_key"; fixedBaseUrl: string };
  displayName: string;
  /** Outward routing protocols only; never carries the models catalog. */
  endpoints: Partial<Record<RouteEndpointProtocol, ProviderEndpoint>>;
  /** Inward model catalog endpoint ("models" / "v1/models" / "codex/models"). */
  modelListEndpoint?: ProviderEndpoint;
  /** Present only for the OAuth subscription providers. */
  oauth?: ProviderOAuthConfig;
  providerKey: KnownProviderKey;
  providerType: ProviderType;
};

const chatCompletionsEndpoint: ProviderEndpoint = { method: "POST", path: "chat/completions" };
const messagesEndpoint: ProviderEndpoint = { method: "POST", path: "messages" };
const responsesEndpoint: ProviderEndpoint = { method: "POST", path: "responses" };
const modelsEndpoint: ProviderEndpoint = { method: "GET", path: "models" };
const remoteTemplateAuth: ProviderAuthBehavior = { header: "Authorization", scheme: "Bearer" };

export const providerRegistry: Record<KnownProviderKey, ProviderRegistryEntry> = {
  anthropic: {
    behavior: {
      connectivityProbeStyle: "anthropic",
      fixedApiKeyBaseUrl: "https://api.anthropic.com/v1",
      modelListStyle: "anthropic",
      priceSyncSupported: true,
      quotaSource: { reason: "requires_separate_credential", supported: false },
    },
    creation: {
      mode: "direct",
      selectorGroup: "remote_api_key",
      fixedBaseUrl: "https://api.anthropic.com/v1",
    },
    displayName: "Anthropic",
    endpoints: { messages: messagesEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "anthropic",
    providerType: "api_key",
  },
  claude_code: {
    behavior: {
      connectivityProbeStyle: "claude_code",
      metadataKey: "anthropic",
      modelListStyle: "claude_code",
      oauthStateFromCodeVerifier: true,
      quotaSource: { supported: true },
      subscription: true,
      subscriptionAdapter: "claude_code",
    },
    creation: {
      mode: "template",
      selectorGroup: "subscription",
      baseUrl: "https://api.anthropic.com",
    },
    displayName: "Claude Code",
    endpoints: { messages: { method: "POST", path: "v1/messages" } },
    modelListEndpoint: { method: "GET", path: "v1/models" },
    oauth: {
      authorizeUrl: "https://claude.ai/oauth/authorize",
      clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
      defaultParams: { code: "true", prompt: "login" },
      redirectUri: "https://console.anthropic.com/oauth/code/callback",
      scope: "org:create_api_key user:profile user:inference",
      tokenEncoding: "json",
      tokenHeaders: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": "anthropic",
      },
      tokenUrl: "https://api.anthropic.com/v1/oauth/token",
    },
    providerKey: "claude_code",
    providerType: "subscription",
  },
  deepseek: {
    behavior: { priceSyncSupported: true, quotaSource: { supported: true } },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.deepseek.com",
    },
    displayName: "DeepSeek",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "deepseek",
    providerType: "api_key",
  },
  google: {
    behavior: {
      priceSyncSupported: true,
      quotaSource: { reason: "not_supported", supported: false },
    },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    },
    displayName: "Google Gemini",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "google",
    providerType: "api_key",
  },
  llama_cpp: {
    behavior: { local: true, priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "local",
      baseUrlPlaceholder: "http://127.0.0.1:8080/v1",
    },
    displayName: "llama.cpp",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      messages: messagesEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "llama_cpp",
    providerType: "local",
  },
  lmstudio: {
    behavior: { local: true, modelListStyle: "lmstudio", priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "local",
      baseUrlPlaceholder: "http://127.0.0.1:1234/v1",
    },
    displayName: "LM Studio",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      messages: messagesEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "lmstudio",
    providerType: "local",
  },
  minimax: {
    behavior: { priceSyncSupported: true, quotaSource: { supported: true } },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.minimax.io/v1",
    },
    displayName: "MiniMax",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "minimax",
    providerType: "api_key",
  },
  moonshot: {
    behavior: { priceSyncSupported: true, quotaSource: { supported: true } },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.moonshot.ai/v1",
    },
    displayName: "Moonshot/Kimi",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "moonshot",
    providerType: "api_key",
  },
  ollama: {
    behavior: { local: true, priceSyncSupported: true },
    creation: {
      mode: "template",
      selectorGroup: "local",
      baseUrlPlaceholder: "http://127.0.0.1:11434/v1",
    },
    displayName: "Ollama",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      messages: messagesEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "ollama",
    providerType: "local",
  },
  openai: {
    behavior: {
      fixedApiKeyBaseUrl: "https://api.openai.com/v1",
      priceSyncSupported: true,
      quotaSource: { supported: true },
      reasoningAwareProbe: true,
    },
    creation: {
      mode: "direct",
      selectorGroup: "remote_api_key",
      fixedBaseUrl: "https://api.openai.com/v1",
    },
    displayName: "OpenAI",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "openai",
    providerType: "api_key",
  },
  openai_codex: {
    behavior: {
      connectivityProbeStyle: "codex",
      metadataKey: "openai",
      modelListStyle: "codex",
      quotaSource: { supported: true },
      subscription: true,
      subscriptionAdapter: "codex",
    },
    creation: {
      mode: "template",
      selectorGroup: "subscription",
      baseUrl: "https://chatgpt.com/backend-api",
    },
    displayName: "OpenAI Codex",
    endpoints: { responses: { method: "POST", path: "codex/responses" } },
    modelListEndpoint: { method: "GET", path: "codex/models" },
    oauth: {
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
      defaultParams: {
        codex_cli_simplified_flow: "true",
        id_token_add_organizations: "true",
        originator: "codex_cli_rs",
        prompt: "login",
      },
      redirectUri: "http://localhost:1455/auth/callback",
      scope: "openid profile email offline_access",
      revokeUrl: "https://auth.openai.com/oauth/revoke",
      tokenEncoding: "form",
      tokenHeaders: { accept: "application/json" },
      tokenUrl: "https://auth.openai.com/oauth/token",
    },
    providerKey: "openai_codex",
    providerType: "subscription",
  },
  openrouter: {
    behavior: {
      fixedApiKeyBaseUrl: "https://openrouter.ai/api/v1",
      modelListStyle: "openrouter",
      openRouterAttribution: true,
      priceSyncSupported: true,
      quotaSource: { supported: true },
    },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://openrouter.ai/api/v1",
    },
    displayName: "OpenRouter",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      messages: messagesEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "openrouter",
    providerType: "api_key",
  },
  qwen: {
    behavior: {
      priceSyncSupported: true,
      quotaSource: { reason: "not_supported", supported: false },
    },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    },
    displayName: "Qwen",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "qwen",
    providerType: "api_key",
  },
  xai: {
    behavior: {
      priceSyncSupported: true,
      quotaSource: { reason: "requires_separate_credential", supported: false },
    },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.x.ai/v1",
    },
    displayName: "xAI",
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      responses: responsesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "xai",
    providerType: "api_key",
  },
  zai: {
    behavior: { priceSyncSupported: true, quotaSource: { supported: true } },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.z.ai/api/paas/v4",
    },
    displayName: "Z.ai",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "zai",
    providerType: "api_key",
  },
};

export const defaultEndpointPathByProtocol: Record<RouteEndpointProtocol, string> = {
  chat_completions: "chat/completions",
  messages: "messages",
  responses: "responses",
};
export const defaultModelListPath = "models";

// Registry key order. Query functions iterate this so their output order is
// stable regardless of object literal order.
const knownProviderKeys: KnownProviderKey[] = [
  "anthropic",
  "claude_code",
  "deepseek",
  "google",
  "llama_cpp",
  "lmstudio",
  "minimax",
  "moonshot",
  "ollama",
  "openai",
  "openai_codex",
  "openrouter",
  "qwen",
  "xai",
  "zai",
];

// Console "Add Provider" selector order: subscription, then remote API keys,
// then local (matching the donor providerTemplateSelectorGroups).
const providerTemplateSelectorOrder: KnownProviderKey[] = [
  "openai_codex",
  "claude_code",
  "google",
  "openrouter",
  "deepseek",
  "xai",
  "qwen",
  "moonshot",
  "minimax",
  "zai",
  "ollama",
  "lmstudio",
  "llama_cpp",
];

// Console direct-create order (donor directProviderCreateChoices).
const directCreateOrder: KnownProviderKey[] = ["openai", "anthropic"];

export function resolveProviderRegistryEntry(
  providerKey: string | null | undefined,
): ProviderRegistryEntry | null {
  const normalized = providerKey?.trim().toLowerCase() ?? "";
  return Object.hasOwn(providerRegistry, normalized)
    ? providerRegistry[normalized as KnownProviderKey]
    : null;
}

/** Unknown keys stay permissive: all three routable protocols are allowed. */
export function listProviderRouteEndpointProtocols(
  providerKey: string | null | undefined,
): RouteEndpointProtocol[] {
  const entry = resolveProviderRegistryEntry(providerKey);
  return entry
    ? (Object.keys(entry.endpoints) as RouteEndpointProtocol[])
    : [...routeEndpointProtocols];
}

/** Unknown keys stay permissive: every protocol reports as supported. */
export function providerSupportsRouteEndpointProtocol(
  providerKey: string | null | undefined,
  protocol: RouteEndpointProtocol,
): boolean {
  const entry = resolveProviderRegistryEntry(providerKey);
  return entry ? Object.hasOwn(entry.endpoints, protocol) : true;
}

export function listSubscriptionProviderKeys(): KnownProviderKey[] {
  return knownProviderKeys.filter((key) => providerRegistry[key].behavior.subscription === true);
}

export function listPriceSyncSupportedProviderKeys(): KnownProviderKey[] {
  return knownProviderKeys.filter(
    (key) => providerRegistry[key].behavior.priceSyncSupported === true,
  );
}

export function listProviderTemplateEntries(): ProviderRegistryEntry[] {
  return providerTemplateSelectorOrder.map((key) => providerRegistry[key]);
}

export function listDirectCreateEntries(): ProviderRegistryEntry[] {
  return directCreateOrder.map((key) => providerRegistry[key]);
}
