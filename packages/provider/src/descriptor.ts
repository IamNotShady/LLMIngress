export type ProviderModelListStyle =
  | "anthropic"
  | "claude_code"
  | "codex"
  | "lmstudio"
  | "openrouter";
export type ProviderConnectivityProbeStyle = "anthropic" | "claude_code" | "codex";
export type ProviderSubscriptionAdapter = "claude_code" | "codex";

export type ProviderDescriptor = {
  connectivityProbeStyle?: ProviderConnectivityProbeStyle;
  fixedApiKeyBaseUrl?: string;
  local?: boolean;
  metadataKey?: string;
  modelListStyle?: ProviderModelListStyle;
  oauthStateFromCodeVerifier?: boolean;
  openRouterAttribution?: boolean;
  priceSyncSupported?: boolean;
  reasoningAwareProbe?: boolean;
  subscription?: boolean;
  subscriptionAdapter?: ProviderSubscriptionAdapter;
};

const descriptors: Record<string, ProviderDescriptor> = {
  anthropic: {
    connectivityProbeStyle: "anthropic",
    fixedApiKeyBaseUrl: "https://api.anthropic.com/v1",
    modelListStyle: "anthropic",
    priceSyncSupported: true,
  },
  claude_code: {
    connectivityProbeStyle: "claude_code",
    metadataKey: "anthropic",
    modelListStyle: "claude_code",
    oauthStateFromCodeVerifier: true,
    subscription: true,
    subscriptionAdapter: "claude_code",
  },
  deepseek: { priceSyncSupported: true },
  google: { priceSyncSupported: true },
  llama_cpp: { local: true, priceSyncSupported: true },
  lmstudio: { local: true, modelListStyle: "lmstudio", priceSyncSupported: true },
  minimax: { priceSyncSupported: true },
  moonshot: { priceSyncSupported: true },
  ollama: { local: true, priceSyncSupported: true },
  openai: {
    fixedApiKeyBaseUrl: "https://api.openai.com/v1",
    priceSyncSupported: true,
    reasoningAwareProbe: true,
  },
  openai_codex: {
    connectivityProbeStyle: "codex",
    metadataKey: "openai",
    modelListStyle: "codex",
    subscription: true,
    subscriptionAdapter: "codex",
  },
  openrouter: {
    fixedApiKeyBaseUrl: "https://openrouter.ai/api/v1",
    modelListStyle: "openrouter",
    openRouterAttribution: true,
    priceSyncSupported: true,
  },
  qwen: { priceSyncSupported: true },
  xai: { priceSyncSupported: true },
  zai: { priceSyncSupported: true },
};

export function resolveProviderDescriptor(
  providerKey: string | null | undefined,
): ProviderDescriptor {
  return descriptors[providerKey?.trim().toLowerCase() ?? ""] ?? {};
}

export function listPriceSyncSupportedProviderKeys(): string[] {
  return Object.entries(descriptors)
    .filter(([, descriptor]) => descriptor.priceSyncSupported === true)
    .map(([providerKey]) => providerKey);
}
