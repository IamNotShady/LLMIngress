import {
  listProviderTemplateEntries,
  type ProviderEndpoint,
  type ProviderRegistryEntry,
} from "@llmingress/config/provider-registry";
import { omitUndefined } from "@llmingress/util";
import { consoleValidationError } from "./console-operation-error.ts";
import { normalizeProviderBaseUrl } from "./console-provider-base-url.ts";
import type { ProviderType } from "./console-providers.ts";

export type OpenAICompatibleProviderTemplateId =
  | "deepseek"
  | "glm_coding"
  | "minimax"
  | "moonshot"
  | "qwen"
  | "qwen_token_plan"
  | "xai"
  | "zai";
// Anthropic messages protocol + x-api-key, non-official base (W1). Reserved for
// extension with future Anthropic-protocol token sources.
export type AnthropicCompatibleProviderTemplateId = "kimi_coding";
export type OpenRouterProviderTemplateId = "openrouter";
export type GoogleProviderTemplateId = "google";
export type OllamaProviderTemplateId = "ollama";
export type LocalProviderTemplateId = OllamaProviderTemplateId | "lmstudio" | "llama_cpp";
export type SubscriptionProviderTemplateId = "claude_code" | "openai_codex";
export type ProviderTemplateId =
  | OpenAICompatibleProviderTemplateId
  | AnthropicCompatibleProviderTemplateId
  | OpenRouterProviderTemplateId
  | GoogleProviderTemplateId
  | SubscriptionProviderTemplateId
  | LocalProviderTemplateId;
export type ProviderTemplateSelectorGroupId = "local" | "remote_api_key" | "subscription";
export type ProviderEndpointProtocol = "chat_completions" | "messages" | "models" | "responses";
export type { ProviderEndpoint };
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
export type AnthropicCompatibleProviderTemplate = ProviderTemplate & {
  auth: ProviderTemplateAuthBehavior;
  baseUrl: string;
  id: AnthropicCompatibleProviderTemplateId;
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
  displayName?: string | null;
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

// Provider templates are derived from the single-source provider registry. The
// registry keeps the routable endpoints separate from the model catalog; here
// they are recombined into the historical four-key `endpoints` shape (with the
// `models` catalog folded back in) that the Console selector consumes.
function toProviderInfo(entry: ProviderRegistryEntry): ProviderInfo {
  const endpoints: ProviderEndpoints = { ...entry.endpoints };
  if (entry.modelListEndpoint) {
    endpoints.models = entry.modelListEndpoint;
  }
  const creation = entry.creation;
  return {
    auth: creation.mode === "template" ? creation.auth : undefined,
    baseUrl: creation.mode === "template" ? creation.baseUrl : undefined,
    baseUrlPlaceholder: creation.mode === "template" ? creation.baseUrlPlaceholder : undefined,
    displayName: entry.displayName,
    endpoints,
    providerKey: entry.providerKey,
    providerType: entry.providerType,
  };
}

const providerTemplates = Object.fromEntries(
  listProviderTemplateEntries().map((entry) => [entry.providerKey, toProviderInfo(entry)]),
) as Record<ProviderTemplateId, ProviderInfo>;

const openAICompatibleProviderTemplateIds = [
  "deepseek",
  "xai",
  "qwen",
  "qwen_token_plan",
  "moonshot",
  "minimax",
  "zai",
  "glm_coding",
] as const satisfies readonly OpenAICompatibleProviderTemplateId[];

const anthropicCompatibleProviderTemplateIds = [
  "kimi_coding",
] as const satisfies readonly AnthropicCompatibleProviderTemplateId[];

const providerTemplateGroupOrder = [
  "subscription",
  "remote_api_key",
  "local",
] as const satisfies readonly ProviderTemplateSelectorGroupId[];

const providerTemplateGroupLabels: Record<ProviderTemplateSelectorGroupId, string> = {
  local: "Local",
  remote_api_key: "API Keys",
  subscription: "Subscription",
};

const providerTemplateSelectorGroups = providerTemplateGroupOrder.map((id) => ({
  id,
  label: providerTemplateGroupLabels[id],
  templateIds: listProviderTemplateEntries()
    .filter((entry) => entry.creation.mode === "template" && entry.creation.selectorGroup === id)
    .map((entry) => entry.providerKey as ProviderTemplateId),
}));

export function listOpenAICompatibleProviderTemplates(): OpenAICompatibleProviderTemplate[] {
  return openAICompatibleProviderTemplateIds.map(
    (id) => readProviderTemplate(id) as OpenAICompatibleProviderTemplate,
  );
}

export function listAnthropicCompatibleProviderTemplates(): AnthropicCompatibleProviderTemplate[] {
  return anthropicCompatibleProviderTemplateIds.map(
    (id) => readProviderTemplate(id) as AnthropicCompatibleProviderTemplate,
  );
}

export function getAnthropicCompatibleProviderTemplate(
  templateId: string | null | undefined,
): AnthropicCompatibleProviderTemplate {
  if (!isAnthropicCompatibleProviderTemplateId(templateId)) {
    throw providerTemplateValidation("Provider must use a whitelisted provider template.");
  }

  return readProviderTemplate(templateId) as AnthropicCompatibleProviderTemplate;
}

export function isAnthropicCompatibleProviderTemplateId(
  value: string | null | undefined,
): value is AnthropicCompatibleProviderTemplateId {
  return isOneOf(anthropicCompatibleProviderTemplateIds, value);
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
  const displayName = input.displayName?.trim();
  if (!displayName) {
    throw consoleValidationError(
      "Provider display name is required.",
      "provider_display_name_required",
      { field: "displayName" },
    );
  }
  return {
    ...toCreateInput(template, baseUrl),
    displayName,
    providerTemplateId: template.id,
  };
}

export function isKnownProviderTemplateKey(providerKey: string): boolean {
  return isProviderTemplateId(providerKey);
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
