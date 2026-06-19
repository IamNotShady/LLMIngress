import type { AgentVirtualModelAccess } from "./agents";

export type AgentIntegrationTemplateId = "codex" | "claude-code" | "cursor" | "openclaw";

export type AgentIntegrationTemplate = {
  displayName: string;
  id: AgentIntegrationTemplateId;
  snippet: string;
};

type AgentIntegrationTemplateDefinition = {
  displayName: string;
  id: AgentIntegrationTemplateId;
};

const modelPlaceholder = "<Virtual Model Name>";

const agentIntegrationTemplateDefinitions: AgentIntegrationTemplateDefinition[] = [
  { displayName: "Codex", id: "codex" },
  { displayName: "Claude Code", id: "claude-code" },
  { displayName: "Cursor", id: "cursor" },
  { displayName: "OpenClaw", id: "openclaw" },
];

export function buildAgentIntegrationTemplates(input: {
  apiKey: string;
  gatewayBaseUrl: string;
  model: string;
}): AgentIntegrationTemplate[] {
  const gatewayBaseUrl = normalizeGatewayBaseUrl(input.gatewayBaseUrl);
  const apiKey = normalizeSnippetField(input.apiKey, "API key");
  const model = normalizeSnippetField(input.model, "model");

  return agentIntegrationTemplateDefinitions.map((template) => ({
    ...template,
    snippet: [
      `${template.displayName} setup`,
      `Gateway URL: ${gatewayBaseUrl}`,
      `API key: ${apiKey}`,
      `Model: ${model}`,
    ].join("\n"),
  }));
}

export function resolveAgentIntegrationModelName(access: AgentVirtualModelAccess): string {
  return (
    access.defaultVirtualModel?.name ?? access.allowedVirtualModels[0]?.name ?? modelPlaceholder
  );
}

export function formatDashboardAgentApiKeySnippetValue(keyPrefix: string): string {
  const normalizedPrefix = normalizeSnippetField(keyPrefix, "Agent API key prefix");
  return `paste one-time Agent API key for prefix ${normalizedPrefix}`;
}

function normalizeGatewayBaseUrl(value: string): string {
  return normalizeSnippetField(value, "Gateway URL").replace(/\/+$/, "");
}

function normalizeSnippetField(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required for Agent integration templates.`);
  }
  return normalized;
}
