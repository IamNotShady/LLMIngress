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

type ProviderOAuthConfigShared = {
  clientId: string;
  // When set, a non-blank value of this environment variable overrides clientId
  // at request time; otherwise clientId is used. Lets an operator supply their
  // own registered client without editing the registry.
  clientIdEnvVar?: string;
  defaultParams?: Record<string, string>;
  revokeUrl?: string;
  scope: string;
  tokenEncoding: "form" | "json";
  tokenHeaders?: Record<string, string>;
  tokenUrl: string;
};

/** Standard authorization-code + PKCE flow (redirect, paste back the code). */
export type AuthorizationCodeProviderOAuthConfig = ProviderOAuthConfigShared & {
  authorizeUrl: string;
  redirectUri: string;
  deviceCodeUrl?: never;
  defaultPollIntervalSeconds?: never;
};

/** User-code + PKCE + polling flow (no redirect URI, no browser callback). */
export type DeviceCodeProviderOAuthConfig = ProviderOAuthConfigShared & {
  authorizeUrl?: never;
  redirectUri?: never;
  deviceCodeUrl: string;
  defaultPollIntervalSeconds?: number;
};

// Discriminated by field presence (`"authorizeUrl" in config` /
// `"deviceCodeUrl" in config`), so authorization-code entries carry no `kind`
// tag and their registry snapshots stay byte-identical.
export type ProviderOAuthConfig =
  | AuthorizationCodeProviderOAuthConfig
  | DeviceCodeProviderOAuthConfig;

export type ProviderModelListStyle =
  | "anthropic"
  | "claude_code"
  | "codex"
  | "lmstudio"
  | "openrouter";
export type ProviderConnectivityProbeStyle = "anthropic" | "claude_code" | "codex";
export type ProviderSubscriptionAdapter = "claude_code" | "codex" | "minimax_anthropic";

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
  | "byteplus_coding"
  | "claude_code"
  | "cline_pass"
  | "command_code"
  | "deepseek"
  | "glm_coding"
  | "google"
  | "kimi_coding"
  | "llama_cpp"
  | "lmstudio"
  | "minimax"
  | "minimax_coding"
  | "moonshot"
  | "nous"
  | "ollama"
  | "openai"
  | "openai_codex"
  | "openrouter"
  | "qwen"
  | "qwen_token_plan"
  | "xai"
  | "zai";

/**
 * Providers whose upstream credential comes from an OAuth subscription flow.
 * The array is the runtime carrier for the type; a unit test pins it to the
 * entries' `behavior.subscription` flags so the type and the registry data
 * cannot drift apart.
 */
export const subscriptionProviderKeys = ["claude_code", "minimax_coding", "openai_codex"] as const;
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
// Anthropic-protocol templates authenticate with a bare x-api-key (no scheme);
// egress hardcodes this, but the field keeps the template data type-complete.
const anthropicTemplateAuth: ProviderAuthBehavior = { header: "x-api-key", scheme: "" };

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
  byteplus_coding: {
    behavior: { quotaSource: { reason: "not_supported", supported: false } },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
    },
    displayName: "BytePlus ModelArk",
    // Chat-only: the upstream Anthropic-protocol endpoint lives under a
    // different base path segment (…/api/coding/v1/messages) that one base URL
    // cannot express, so no messages face is added here.
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "byteplus_coding",
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
  cline_pass: {
    behavior: { quotaSource: { reason: "not_supported", supported: false } },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.cline.bot/api/v1",
    },
    displayName: "ClinePass",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "cline_pass",
    providerType: "api_key",
  },
  command_code: {
    behavior: { quotaSource: { reason: "not_supported", supported: false } },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.commandcode.ai/provider/v1",
    },
    displayName: "Command Code",
    // Dual routable faces from one base: chat_completions egress carries the
    // Bearer credential, while the messages egress authenticates with a bare
    // x-api-key (hardcoded by the anthropic adapter, like kimi_coding).
    endpoints: {
      chat_completions: chatCompletionsEndpoint,
      messages: messagesEndpoint,
    },
    modelListEndpoint: modelsEndpoint,
    providerKey: "command_code",
    providerType: "api_key",
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
  glm_coding: {
    behavior: {
      metadataKey: "zai",
      quotaSource: { supported: true },
    },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://api.z.ai/api/coding/paas/v4",
    },
    displayName: "GLM Coding Plan",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "glm_coding",
    providerType: "api_key",
  },
  kimi_coding: {
    behavior: {
      connectivityProbeStyle: "anthropic",
      metadataKey: "moonshot",
      modelListStyle: "anthropic",
      quotaSource: { supported: true },
    },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: anthropicTemplateAuth,
      baseUrl: "https://api.kimi.com/coding/v1",
    },
    displayName: "Kimi Coding Plan",
    endpoints: { messages: messagesEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "kimi_coding",
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
  minimax_coding: {
    behavior: {
      connectivityProbeStyle: "anthropic",
      // Model metadata (context, prices, capabilities) resolves through the
      // shared minimax catalog entry, like kimi_coding -> moonshot.
      metadataKey: "minimax",
      // Feature B ships the MiniMax Coding Plan quota probe
      // (quotaProbes.minimax_coding → coding_plan/remains); supported is flipped
      // true in the same commit that adds the probe.
      quotaSource: { supported: true },
      subscription: true,
      subscriptionAdapter: "minimax_anthropic",
    },
    creation: {
      mode: "template",
      selectorGroup: "subscription",
      baseUrl: "https://api.minimax.io/anthropic/v1",
    },
    displayName: "MiniMax Coding Plan",
    endpoints: { messages: messagesEndpoint },
    modelListEndpoint: modelsEndpoint,
    oauth: {
      clientId: "78257093-7e40-4613-99e0-527b14b39113",
      clientIdEnvVar: "MINIMAX_OAUTH_CLIENT_ID",
      deviceCodeUrl: "https://api.minimax.io/oauth/code",
      defaultPollIntervalSeconds: 2,
      scope: "group_id profile model.completion",
      tokenEncoding: "form",
      tokenUrl: "https://api.minimax.io/oauth/token",
    },
    providerKey: "minimax_coding",
    providerType: "subscription",
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
  nous: {
    behavior: { quotaSource: { reason: "not_supported", supported: false } },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://inference-api.nousresearch.com/v1",
    },
    displayName: "NousResearch",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "nous",
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
  qwen_token_plan: {
    behavior: {
      metadataKey: "qwen",
      quotaSource: { reason: "not_supported", supported: false },
    },
    creation: {
      mode: "template",
      selectorGroup: "remote_api_key",
      auth: remoteTemplateAuth,
      baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    },
    displayName: "Qwen Token Plan",
    endpoints: { chat_completions: chatCompletionsEndpoint },
    modelListEndpoint: modelsEndpoint,
    providerKey: "qwen_token_plan",
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
  "byteplus_coding",
  "claude_code",
  "cline_pass",
  "command_code",
  "deepseek",
  "glm_coding",
  "google",
  "kimi_coding",
  "llama_cpp",
  "lmstudio",
  "minimax",
  "minimax_coding",
  "moonshot",
  "nous",
  "ollama",
  "openai",
  "openai_codex",
  "openrouter",
  "qwen",
  "qwen_token_plan",
  "xai",
  "zai",
];

// Console "Add Provider" selector order: subscription, then remote API keys,
// then local (matching the donor providerTemplateSelectorGroups).
const providerTemplateSelectorOrder: KnownProviderKey[] = [
  "openai_codex",
  "claude_code",
  "minimax_coding",
  "google",
  "openrouter",
  "deepseek",
  "xai",
  "qwen",
  "qwen_token_plan",
  "moonshot",
  "kimi_coding",
  "minimax",
  "zai",
  "glm_coding",
  "command_code",
  "cline_pass",
  "byteplus_coding",
  "nous",
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

/** True when the provider's OAuth config is the device/user-code + polling flow. */
export function providerUsesDeviceCodeOAuth(providerKey: string | null | undefined): boolean {
  const oauth = resolveProviderRegistryEntry(providerKey)?.oauth;
  return Boolean(oauth && "deviceCodeUrl" in oauth && oauth.deviceCodeUrl);
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
