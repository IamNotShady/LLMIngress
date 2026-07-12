import { consoleValidationError } from "./console-operation-error.ts";
import { normalizeProviderBaseUrl } from "./console-provider-base-url.ts";
import type { ProviderType } from "./console-providers.ts";

export type OpenAICompatibleProviderTemplateId =
  | "deepseek"
  | "minimax"
  | "moonshot"
  | "qwen"
  | "xai"
  | "zai";
export type OpenRouterProviderTemplateId = "openrouter";
export type GoogleProviderTemplateId = "google";
export type OllamaProviderTemplateId = "ollama";
export type LocalProviderTemplateId = OllamaProviderTemplateId | "lmstudio" | "llama_cpp";
export type SubscriptionProviderTemplateId = "claude_code" | "openai_codex";
export type ProviderTemplateId =
  | OpenAICompatibleProviderTemplateId
  | OpenRouterProviderTemplateId
  | GoogleProviderTemplateId
  | SubscriptionProviderTemplateId
  | LocalProviderTemplateId;
export type ProviderTemplateSelectorGroupId = "local" | "remote_api_key" | "subscription";
export type ProviderEndpointProtocol =
  | "chat_completions"
  | "embeddings"
  | "messages"
  | "models"
  | "responses";
export type ProviderEndpoint = {
  method: "GET" | "POST";
  path: string;
};
export type ProviderEndpoints = Partial<Record<ProviderEndpointProtocol, ProviderEndpoint>>;
export type ProviderTemplateAuthBehavior = {
  header: string;
  scheme: string;
};

export type ProviderInfo = {
  auth?: ProviderTemplateAuthBehavior;
  baseUrl?: string;
  baseUrlPlaceholder?: string;
  displayName: string;
  endpoints: ProviderEndpoints;
  providerKey: string;
  providerType: ProviderType;
};

export type ProviderTemplate = ProviderInfo & {
  id: ProviderTemplateId;
};
export type OpenAICompatibleProviderTemplate = ProviderTemplate & {
  auth: ProviderTemplateAuthBehavior;
  baseUrl: string;
  id: OpenAICompatibleProviderTemplateId;
  providerType: "api_key";
};
export type OpenRouterProviderTemplate = ProviderTemplate & {
  auth: ProviderTemplateAuthBehavior;
  baseUrl: string;
  id: OpenRouterProviderTemplateId;
  providerType: "api_key";
};
export type GoogleProviderTemplate = ProviderTemplate & {
  auth: ProviderTemplateAuthBehavior;
  baseUrl: string;
  id: GoogleProviderTemplateId;
  providerType: "api_key";
};
export type LocalProviderTemplate = ProviderTemplate & {
  baseUrlPlaceholder: string;
  id: LocalProviderTemplateId;
  providerType: "local";
};
export type OllamaProviderTemplate = LocalProviderTemplate & {
  id: OllamaProviderTemplateId;
};
export type SubscriptionProviderTemplate = ProviderTemplate & {
  baseUrl: string;
  id: SubscriptionProviderTemplateId;
  providerType: "subscription";
};

export type ProviderTemplateCreateInput = {
  baseUrl: string;
  displayName: string;
  id: string;
  providerKey: string;
  providerTemplateId?: string;
  providerType: ProviderType;
};

export type ProviderTemplateFormInput = {
  baseUrl?: string | null;
  templateId?: string | null;
};

export type ProviderTemplateSelectorItem = {
  auth?: ProviderTemplateAuthBehavior;
  baseUrlMode: "user_local_private" | "user_remote";
  baseUrlPlaceholder?: string;
  displayName: string;
  endpoints: ProviderEndpoints;
  fixedBaseUrl?: string;
  id: ProviderTemplateId;
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

const chatCompletionsEndpoint: ProviderEndpoint = {
  method: "POST",
  path: "chat/completions",
};
const embeddingsEndpoint: ProviderEndpoint = {
  method: "POST",
  path: "embeddings",
};
const messagesEndpoint: ProviderEndpoint = {
  method: "POST",
  path: "messages",
};
const modelsEndpoint: ProviderEndpoint = {
  method: "GET",
  path: "models",
};
const responsesEndpoint: ProviderEndpoint = {
  method: "POST",
  path: "responses",
};

const openAICompatibleEndpoints: ProviderEndpoints = {
  chat_completions: chatCompletionsEndpoint,
  models: modelsEndpoint,
};
const openAICompatibleWithEmbeddingsEndpoints: ProviderEndpoints = {
  ...openAICompatibleEndpoints,
  embeddings: embeddingsEndpoint,
};
const openAICompatibleWithResponsesEndpoints: ProviderEndpoints = {
  ...openAICompatibleEndpoints,
  responses: responsesEndpoint,
};
const fullTextProviderEndpoints: ProviderEndpoints = {
  ...openAICompatibleEndpoints,
  embeddings: embeddingsEndpoint,
  messages: messagesEndpoint,
  responses: responsesEndpoint,
};

const providerTemplates: Record<ProviderTemplateId, ProviderInfo> = {
  openai_codex: {
    baseUrl: "https://chatgpt.com/backend-api",
    displayName: "OpenAI Codex",
    endpoints: {
      models: { method: "GET", path: "codex/models" },
      responses: { ...responsesEndpoint, path: "codex/responses" },
    },
    providerKey: "openai_codex",
    providerType: "subscription",
  },
  claude_code: {
    baseUrl: "https://api.anthropic.com",
    displayName: "Claude Code",
    endpoints: {
      messages: { ...messagesEndpoint, path: "v1/messages" },
      models: { ...modelsEndpoint, path: "v1/models" },
    },
    providerKey: "claude_code",
    providerType: "subscription",
  },
  google: {
    auth: remoteTemplateAuth,
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    displayName: "Google Gemini",
    endpoints: openAICompatibleWithEmbeddingsEndpoints,
    providerKey: "google",
    providerType: "api_key",
  },
  openrouter: {
    auth: remoteTemplateAuth,
    baseUrl: "https://openrouter.ai/api/v1",
    displayName: "OpenRouter",
    endpoints: fullTextProviderEndpoints,
    providerKey: "openrouter",
    providerType: "api_key",
  },
  deepseek: {
    auth: remoteTemplateAuth,
    baseUrl: "https://api.deepseek.com",
    displayName: "DeepSeek",
    endpoints: openAICompatibleEndpoints,
    providerKey: "deepseek",
    providerType: "api_key",
  },
  xai: {
    auth: remoteTemplateAuth,
    baseUrl: "https://api.x.ai/v1",
    displayName: "xAI",
    endpoints: openAICompatibleWithResponsesEndpoints,
    providerKey: "xai",
    providerType: "api_key",
  },
  qwen: {
    auth: remoteTemplateAuth,
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    displayName: "Qwen",
    endpoints: openAICompatibleWithResponsesEndpoints,
    providerKey: "qwen",
    providerType: "api_key",
  },
  moonshot: {
    auth: remoteTemplateAuth,
    baseUrl: "https://api.moonshot.ai/v1",
    displayName: "Moonshot/Kimi",
    endpoints: openAICompatibleEndpoints,
    providerKey: "moonshot",
    providerType: "api_key",
  },
  minimax: {
    auth: remoteTemplateAuth,
    baseUrl: "https://api.minimax.io/v1",
    displayName: "MiniMax",
    endpoints: openAICompatibleWithResponsesEndpoints,
    providerKey: "minimax",
    providerType: "api_key",
  },
  zai: {
    auth: remoteTemplateAuth,
    baseUrl: "https://api.z.ai/api/paas/v4",
    displayName: "Z.ai",
    endpoints: openAICompatibleEndpoints,
    providerKey: "zai",
    providerType: "api_key",
  },
  ollama: {
    baseUrlPlaceholder: "http://127.0.0.1:11434/v1",
    displayName: "Ollama",
    endpoints: fullTextProviderEndpoints,
    providerKey: "ollama",
    providerType: "local",
  },
  lmstudio: {
    baseUrlPlaceholder: "http://127.0.0.1:1234/v1",
    displayName: "LM Studio",
    endpoints: fullTextProviderEndpoints,
    providerKey: "lmstudio",
    providerType: "local",
  },
  llama_cpp: {
    baseUrlPlaceholder: "http://127.0.0.1:8080/v1",
    displayName: "llama.cpp",
    endpoints: fullTextProviderEndpoints,
    providerKey: "llama_cpp",
    providerType: "local",
  },
};

const openAICompatibleProviderTemplateIds = [
  "deepseek",
  "xai",
  "qwen",
  "moonshot",
  "minimax",
  "zai",
] as const satisfies readonly OpenAICompatibleProviderTemplateId[];

const localProviderTemplateIds = [
  "ollama",
  "lmstudio",
  "llama_cpp",
] as const satisfies readonly LocalProviderTemplateId[];

const subscriptionProviderTemplateIds = [
  "openai_codex",
  "claude_code",
] as const satisfies readonly SubscriptionProviderTemplateId[];

const providerTemplateSelectorGroups = [
  {
    id: "subscription",
    label: "Subscription",
    templateIds: subscriptionProviderTemplateIds,
  },
  {
    id: "remote_api_key",
    label: "API Keys",
    templateIds: ["google", "openrouter", ...openAICompatibleProviderTemplateIds],
  },
  {
    id: "local",
    label: "Local",
    templateIds: localProviderTemplateIds,
  },
] as const satisfies readonly {
  id: ProviderTemplateSelectorGroupId;
  label: string;
  templateIds: readonly ProviderTemplateId[];
}[];

export function listOpenAICompatibleProviderTemplates(): OpenAICompatibleProviderTemplate[] {
  return openAICompatibleProviderTemplateIds.map(
    (id) => readProviderTemplate(id) as OpenAICompatibleProviderTemplate,
  );
}

export function listOllamaProviderTemplates(): OllamaProviderTemplate[] {
  return [readProviderTemplate("ollama") as OllamaProviderTemplate];
}

export function listLocalProviderTemplates(): LocalProviderTemplate[] {
  return localProviderTemplateIds.map((id) => readProviderTemplate(id) as LocalProviderTemplate);
}

export function listSubscriptionProviderTemplates(): SubscriptionProviderTemplate[] {
  return subscriptionProviderTemplateIds.map(
    (id) => readProviderTemplate(id) as SubscriptionProviderTemplate,
  );
}

export function listProviderTemplateSelectorGroups(): ProviderTemplateSelectorGroup[] {
  return providerTemplateSelectorGroups.map((group) => ({
    id: group.id,
    label: group.label,
    templates: group.templateIds.map((id) => toSelectorItem(readProviderTemplate(id))),
  }));
}

export function getOpenAICompatibleProviderTemplate(
  templateId: string | null | undefined,
): OpenAICompatibleProviderTemplate {
  if (!isOpenAICompatibleProviderTemplateId(templateId)) {
    throw providerTemplateValidation("Provider must use a whitelisted provider template.");
  }

  return readProviderTemplate(templateId) as OpenAICompatibleProviderTemplate;
}

export function getOllamaProviderTemplate(
  templateId: string | null | undefined,
): OllamaProviderTemplate {
  if (templateId !== "ollama") {
    throw providerTemplateValidation("Provider must use a whitelisted provider template.");
  }

  return readProviderTemplate(templateId) as OllamaProviderTemplate;
}

export function getOpenRouterProviderTemplate(
  templateId: string | null | undefined,
): OpenRouterProviderTemplate {
  if (templateId !== "openrouter") {
    throw providerTemplateValidation("Provider must use a whitelisted provider template.");
  }

  return readProviderTemplate(templateId) as OpenRouterProviderTemplate;
}

export function getGoogleProviderTemplate(
  templateId: string | null | undefined,
): GoogleProviderTemplate {
  if (templateId !== "google") {
    throw providerTemplateValidation("Provider must use a whitelisted provider template.");
  }

  return readProviderTemplate(templateId) as GoogleProviderTemplate;
}

export function getLocalProviderTemplate(
  templateId: string | null | undefined,
): LocalProviderTemplate {
  if (!isLocalProviderTemplateId(templateId)) {
    throw providerTemplateValidation("Provider must use a whitelisted provider template.");
  }

  return readProviderTemplate(templateId) as LocalProviderTemplate;
}

export function getSubscriptionProviderTemplate(
  templateId: string | null | undefined,
): SubscriptionProviderTemplate {
  if (!isSubscriptionProviderTemplateId(templateId)) {
    throw providerTemplateValidation("Provider must use a whitelisted provider template.");
  }

  return readProviderTemplate(templateId) as SubscriptionProviderTemplate;
}

export function normalizeProviderTemplateFormInput(
  input: ProviderTemplateFormInput,
): ProviderTemplateCreateInput {
  if (!isProviderTemplateId(input.templateId)) {
    throw providerTemplateValidation("Provider must use a whitelisted provider template.");
  }

  const template = readProviderTemplate(input.templateId);
  const baseUrl = normalizeProviderBaseUrl({
    providerType: template.providerType,
    value: input.baseUrl ?? template.baseUrl,
  });
  return {
    ...toCreateInput(template, baseUrl),
    providerTemplateId: template.id,
  };
}

export function isKnownProviderTemplateKey(providerKey: string): boolean {
  return isProviderTemplateId(providerKey);
}

export function listProviderTemplateEndpointProtocols(
  templateId: string | null | undefined,
): ProviderEndpointProtocol[] {
  if (!isProviderTemplateId(templateId)) {
    return [];
  }
  return Object.keys(readProviderTemplate(templateId).endpoints) as ProviderEndpointProtocol[];
}

function readProviderTemplate(id: ProviderTemplateId): ProviderTemplate {
  const template = providerTemplates[id];
  return {
    ...template,
    auth: template.auth ? { ...template.auth } : undefined,
    endpoints: copyEndpoints(template.endpoints),
    id,
  };
}

function toSelectorItem(template: ProviderTemplate): ProviderTemplateSelectorItem {
  return omitUndefined({
    auth: template.auth ? { ...template.auth } : undefined,
    baseUrlMode: template.providerType === "local" ? "user_local_private" : "user_remote",
    baseUrlPlaceholder: template.baseUrlPlaceholder,
    displayName: template.displayName,
    endpoints: copyEndpoints(template.endpoints),
    fixedBaseUrl: template.baseUrl,
    id: template.id,
    providerKey: template.providerKey,
    providerType: template.providerType,
  });
}

function toCreateInput(template: ProviderTemplate, baseUrl: string): ProviderTemplateCreateInput {
  return {
    baseUrl,
    displayName: template.displayName,
    id: template.id,
    providerKey: template.providerKey,
    providerType: template.providerType,
  };
}

function isProviderTemplateId(value: string | null | undefined): value is ProviderTemplateId {
  return typeof value === "string" && Object.hasOwn(providerTemplates, value);
}

function isOpenAICompatibleProviderTemplateId(
  value: string | null | undefined,
): value is OpenAICompatibleProviderTemplateId {
  return isOneOf(openAICompatibleProviderTemplateIds, value);
}

function isLocalProviderTemplateId(
  value: string | null | undefined,
): value is LocalProviderTemplateId {
  return isOneOf(localProviderTemplateIds, value);
}

function isSubscriptionProviderTemplateId(
  value: string | null | undefined,
): value is SubscriptionProviderTemplateId {
  return isOneOf(subscriptionProviderTemplateIds, value);
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && values.some((entry) => entry === value);
}

function copyEndpoints(endpoints: ProviderEndpoints): ProviderEndpoints {
  return Object.fromEntries(
    Object.entries(endpoints).map(([protocol, endpoint]) => [
      protocol,
      endpoint ? { ...endpoint } : endpoint,
    ]),
  ) as ProviderEndpoints;
}

function providerTemplateValidation(message: string) {
  return consoleValidationError(message, "provider_template_invalid");
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}
