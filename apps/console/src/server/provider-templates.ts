import type { ProviderType } from "./providers";

export type OpenAICompatibleProviderTemplateId =
  | "deepseek"
  | "fireworks"
  | "groq"
  | "minimax"
  | "mistral"
  | "moonshot"
  | "qwen"
  | "xai"
  | "zai";
export type OllamaProviderTemplateId = "ollama";
export type LocalProviderTemplateId = OllamaProviderTemplateId | "lmstudio" | "llama_cpp";
export type ProviderTemplateSelectorGroupId = "remote_api_key" | "local";
export type ProviderTemplateSelectorCapability = "chat_completions" | "streaming" | "tools";
export type ProviderTemplateAuthBehavior = {
  header: "Authorization";
  scheme: "Bearer";
};

export type ProviderTemplateCreateInput = {
  baseUrl: string;
  displayName: string;
  id: string;
  providerKey: string;
  providerTemplateId?: string;
  providerType: ProviderType;
};

export type OpenAICompatibleProviderTemplate = ProviderTemplateCreateInput & {
  auth: ProviderTemplateAuthBehavior;
  capabilities: {
    chatCompletions: boolean;
    streaming: boolean;
    tools: boolean;
  };
  id: OpenAICompatibleProviderTemplateId;
};

export type LocalProviderTemplate = {
  baseUrlPlaceholder: string;
  capabilities: ProviderTemplateSelectorCapability[];
  chatPath: string;
  displayName: string;
  id: LocalProviderTemplateId;
  modelListPath: string;
  providerKey: string;
  providerType: ProviderType;
};
export type OllamaProviderTemplate = LocalProviderTemplate & {
  id: OllamaProviderTemplateId;
};

export type ProviderTemplateFormInput = {
  baseUrl?: string | null;
  publicNetworkRiskAccepted?: boolean | string | null;
  templateId?: string | null;
};

export type ProviderTemplateSelectorItem = {
  auth?: ProviderTemplateAuthBehavior;
  baseUrlMode: "fixed_remote" | "user_local_private";
  baseUrlPlaceholder?: string;
  capabilities: ProviderTemplateSelectorCapability[];
  chatPath?: string;
  displayName: string;
  fixedBaseUrl?: string;
  id: OpenAICompatibleProviderTemplateId | LocalProviderTemplateId;
  modelListPath?: string;
  providerKey: string;
  providerType: ProviderType;
};

export type ProviderTemplateSelectorGroup = {
  id: ProviderTemplateSelectorGroupId;
  label: string;
  templates: ProviderTemplateSelectorItem[];
};

const remoteTemplateAuth: ProviderTemplateAuthBehavior = {
  header: "Authorization",
  scheme: "Bearer",
};

const defaultOpenAICompatibleCapabilities = {
  chatCompletions: true,
  streaming: true,
  tools: true,
};

const templates: Record<OpenAICompatibleProviderTemplateId, OpenAICompatibleProviderTemplate> = {
  deepseek: createOpenAICompatibleProviderTemplate({
    baseUrl: "https://api.deepseek.com",
    displayName: "DeepSeek",
    id: "deepseek",
  }),
  xai: createOpenAICompatibleProviderTemplate({
    baseUrl: "https://api.x.ai/v1",
    displayName: "xAI",
    id: "xai",
  }),
  mistral: createOpenAICompatibleProviderTemplate({
    baseUrl: "https://api.mistral.ai/v1",
    displayName: "Mistral",
    id: "mistral",
  }),
  qwen: createOpenAICompatibleProviderTemplate({
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    displayName: "Qwen",
    id: "qwen",
  }),
  moonshot: createOpenAICompatibleProviderTemplate({
    baseUrl: "https://api.moonshot.ai/v1",
    displayName: "Moonshot/Kimi",
    id: "moonshot",
  }),
  minimax: createOpenAICompatibleProviderTemplate({
    baseUrl: "https://api.minimax.io/v1",
    displayName: "MiniMax",
    id: "minimax",
  }),
  groq: createOpenAICompatibleProviderTemplate({
    baseUrl: "https://api.groq.com/openai/v1",
    displayName: "Groq",
    id: "groq",
  }),
  fireworks: createOpenAICompatibleProviderTemplate({
    baseUrl: "https://api.fireworks.ai/inference/v1",
    displayName: "Fireworks AI",
    id: "fireworks",
  }),
  zai: createOpenAICompatibleProviderTemplate({
    baseUrl: "https://api.z.ai/api/paas/v4",
    displayName: "Z.ai",
    id: "zai",
  }),
};

const localTemplates: Record<LocalProviderTemplateId, LocalProviderTemplate> = {
  ollama: {
    baseUrlPlaceholder: "http://127.0.0.1:11434",
    capabilities: ["chat_completions"],
    chatPath: "/api/chat",
    displayName: "Ollama",
    id: "ollama",
    modelListPath: "/api/tags",
    providerKey: "ollama",
    providerType: "local",
  },
  lmstudio: {
    baseUrlPlaceholder: "http://127.0.0.1:1234/v1",
    capabilities: ["chat_completions", "streaming", "tools"],
    chatPath: "/chat/completions",
    displayName: "LM Studio",
    id: "lmstudio",
    modelListPath: "/models",
    providerKey: "lmstudio",
    providerType: "local",
  },
  llama_cpp: {
    baseUrlPlaceholder: "http://127.0.0.1:8080/v1",
    capabilities: ["chat_completions", "streaming", "tools"],
    chatPath: "/chat/completions",
    displayName: "llama.cpp",
    id: "llama_cpp",
    modelListPath: "/models",
    providerKey: "llama_cpp",
    providerType: "local",
  },
};

export function listOpenAICompatibleProviderTemplates(): OpenAICompatibleProviderTemplate[] {
  return Object.values(templates).map(copyTemplate);
}

export function listOllamaProviderTemplates(): OllamaProviderTemplate[] {
  return [copyOllamaTemplate(localTemplates.ollama as OllamaProviderTemplate)];
}

export function listLocalProviderTemplates(): LocalProviderTemplate[] {
  return Object.values(localTemplates).map(copyLocalTemplate);
}

export function listProviderTemplateSelectorGroups(): ProviderTemplateSelectorGroup[] {
  return [
    {
      id: "remote_api_key",
      label: "Remote API-key templates",
      templates: listOpenAICompatibleProviderTemplates().map((template) => ({
        auth: { ...template.auth },
        baseUrlMode: "fixed_remote",
        capabilities: readOpenAICompatibleCapabilities(template),
        displayName: template.displayName,
        fixedBaseUrl: template.baseUrl,
        id: template.id,
        providerKey: template.providerKey,
        providerType: template.providerType,
      })),
    },
    {
      id: "local",
      label: "Local templates",
      templates: listLocalProviderTemplates().map((template) => ({
        baseUrlMode: "user_local_private",
        baseUrlPlaceholder: template.baseUrlPlaceholder,
        capabilities: [...template.capabilities],
        chatPath: template.chatPath,
        displayName: template.displayName,
        id: template.id,
        modelListPath: template.modelListPath,
        providerKey: template.providerKey,
        providerType: template.providerType,
      })),
    },
  ];
}

export function getOpenAICompatibleProviderTemplate(
  templateId: string | null | undefined,
): OpenAICompatibleProviderTemplate {
  if (!isOpenAICompatibleProviderTemplateId(templateId)) {
    throw new Error("Provider must use a whitelisted provider template.");
  }

  return copyTemplate(templates[templateId]);
}

export function getOllamaProviderTemplate(
  templateId: string | null | undefined,
): OllamaProviderTemplate {
  if (templateId !== "ollama") {
    throw new Error("Provider must use a whitelisted provider template.");
  }

  return copyOllamaTemplate(localTemplates.ollama as OllamaProviderTemplate);
}

export function getLocalProviderTemplate(
  templateId: string | null | undefined,
): LocalProviderTemplate {
  if (!isLocalProviderTemplateId(templateId)) {
    throw new Error("Provider must use a whitelisted provider template.");
  }

  return copyLocalTemplate(localTemplates[templateId]);
}

export function normalizeProviderTemplateFormInput(
  input: ProviderTemplateFormInput,
): ProviderTemplateCreateInput {
  if (isLocalProviderTemplateId(input.templateId)) {
    return normalizeLocalTemplateFormInput(input);
  }

  if (input.baseUrl?.trim()) {
    throw new Error("Custom OpenAI-compatible endpoints are not allowed.");
  }

  return getOpenAICompatibleProviderTemplate(input.templateId);
}

export function isKnownProviderTemplateKey(providerKey: string): boolean {
  return (
    isOpenAICompatibleProviderTemplateId(providerKey) || isLocalProviderTemplateId(providerKey)
  );
}

function normalizeLocalTemplateFormInput(
  input: ProviderTemplateFormInput,
): ProviderTemplateCreateInput {
  const template = getLocalProviderTemplate(input.templateId);
  const baseUrl = input.baseUrl?.trim();

  if (!baseUrl) {
    throw new Error(`${template.displayName} base URL is required.`);
  }

  const url = readHttpUrl(baseUrl);
  if (requiresPublicNetworkRiskConfirmation(url) && !readRiskAccepted(input)) {
    throw new Error(
      `${template.displayName} public network URL requires explicit risk confirmation.`,
    );
  }

  return {
    baseUrl: normalizeUrl(baseUrl),
    displayName: template.displayName,
    id: template.id,
    providerKey: template.providerKey,
    providerTemplateId: template.id,
    providerType: template.providerType,
  };
}

function isOpenAICompatibleProviderTemplateId(
  value: string | null | undefined,
): value is OpenAICompatibleProviderTemplateId {
  return typeof value === "string" && Object.hasOwn(templates, value);
}

function isLocalProviderTemplateId(
  value: string | null | undefined,
): value is LocalProviderTemplateId {
  return typeof value === "string" && Object.hasOwn(localTemplates, value);
}

function copyTemplate(
  template: OpenAICompatibleProviderTemplate,
): OpenAICompatibleProviderTemplate {
  return {
    ...template,
    auth: { ...template.auth },
    capabilities: { ...template.capabilities },
  };
}

function copyOllamaTemplate(template: OllamaProviderTemplate): OllamaProviderTemplate {
  return {
    ...template,
    capabilities: [...template.capabilities],
  };
}

function copyLocalTemplate(template: LocalProviderTemplate): LocalProviderTemplate {
  return {
    ...template,
    capabilities: [...template.capabilities],
  };
}

function readOpenAICompatibleCapabilities(
  template: OpenAICompatibleProviderTemplate,
): ProviderTemplateSelectorCapability[] {
  const capabilities: ProviderTemplateSelectorCapability[] = [];

  if (template.capabilities.chatCompletions) {
    capabilities.push("chat_completions");
  }

  if (template.capabilities.streaming) {
    capabilities.push("streaming");
  }

  if (template.capabilities.tools) {
    capabilities.push("tools");
  }

  return capabilities;
}

function createOpenAICompatibleProviderTemplate(input: {
  baseUrl: string;
  displayName: string;
  id: OpenAICompatibleProviderTemplateId;
}): OpenAICompatibleProviderTemplate {
  return {
    auth: { ...remoteTemplateAuth },
    baseUrl: input.baseUrl,
    capabilities: { ...defaultOpenAICompatibleCapabilities },
    displayName: input.displayName,
    id: input.id,
    providerKey: input.id,
    providerType: "api_key",
  };
}

function readHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provider base URL must be a valid URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Provider base URL must use http or https.");
  }

  return url;
}

function requiresPublicNetworkRiskConfirmation(url: URL): boolean {
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");

  if (hostname === "localhost" || isPrivateIpv4(hostname) || isPrivateIpv6(hostname)) {
    return false;
  }

  return true;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) {
    return false;
  }

  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [first = -1, second = -1] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 169 && second === 254) ||
    (first === 192 && second === 168)
  );
}

function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) {
    return false;
  }

  return (
    hostname === "::1" ||
    hostname.startsWith("fc") ||
    hostname.startsWith("fd") ||
    hostname.startsWith("fe80:")
  );
}

function readRiskAccepted(input: ProviderTemplateFormInput): boolean {
  return input.publicNetworkRiskAccepted === true || input.publicNetworkRiskAccepted === "true";
}

function normalizeUrl(value: string): string {
  const url = new URL(value);
  const pathname =
    url.pathname === "/"
      ? ""
      : url.pathname.length > 1 && url.pathname.endsWith("/")
        ? url.pathname.slice(0, -1)
        : url.pathname;
  return `${url.origin}${pathname}${url.search}`;
}
