import type { ProviderType } from "./providers";

export type OpenAICompatibleProviderTemplateId = "deepseek";

export type OpenAICompatibleProviderTemplate = {
  baseUrl: string;
  capabilities: {
    chatCompletions: boolean;
    streaming: boolean;
    tools: boolean;
  };
  displayName: string;
  id: OpenAICompatibleProviderTemplateId;
  providerKey: string;
  providerType: ProviderType;
};

export type ProviderTemplateFormInput = {
  baseUrl?: string | null;
  templateId?: string | null;
};

const templates: Record<OpenAICompatibleProviderTemplateId, OpenAICompatibleProviderTemplate> = {
  deepseek: {
    baseUrl: "https://api.deepseek.com/v1",
    capabilities: {
      chatCompletions: true,
      streaming: true,
      tools: true,
    },
    displayName: "DeepSeek",
    id: "deepseek",
    providerKey: "deepseek",
    providerType: "api_key",
  },
};

export function listOpenAICompatibleProviderTemplates(): OpenAICompatibleProviderTemplate[] {
  return Object.values(templates).map(copyTemplate);
}

export function getOpenAICompatibleProviderTemplate(
  templateId: string | null | undefined,
): OpenAICompatibleProviderTemplate {
  if (!isOpenAICompatibleProviderTemplateId(templateId)) {
    throw new Error("Provider must use a whitelisted provider template.");
  }

  return copyTemplate(templates[templateId]);
}

export function normalizeProviderTemplateFormInput(
  input: ProviderTemplateFormInput,
): OpenAICompatibleProviderTemplate {
  if (input.baseUrl?.trim()) {
    throw new Error("Custom OpenAI-compatible endpoints are not allowed.");
  }

  return getOpenAICompatibleProviderTemplate(input.templateId);
}

function isOpenAICompatibleProviderTemplateId(
  value: string | null | undefined,
): value is OpenAICompatibleProviderTemplateId {
  return value === "deepseek";
}

function copyTemplate(
  template: OpenAICompatibleProviderTemplate,
): OpenAICompatibleProviderTemplate {
  return {
    ...template,
    capabilities: { ...template.capabilities },
  };
}
