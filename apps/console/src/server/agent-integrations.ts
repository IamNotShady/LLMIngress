export type AgentConnectionDetails = {
  apiKey: string;
  gatewayBaseUrl: string;
  model: string;
};

const modelPlaceholder = "<Virtual Model Name>";

export function buildAgentConnectionDetails(input: {
  apiKey: string;
  gatewayBaseUrl: string;
  model: string;
}): AgentConnectionDetails {
  return {
    apiKey: normalizeSnippetField(input.apiKey, "API key"),
    gatewayBaseUrl: normalizeGatewayBaseUrl(input.gatewayBaseUrl),
    model: normalizeSnippetField(input.model || modelPlaceholder, "model"),
  };
}

function normalizeGatewayBaseUrl(value: string): string {
  return normalizeSnippetField(value, "Gateway URL").replace(/\/+$/, "");
}

function normalizeSnippetField(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required for Agent connection details.`);
  }
  return normalized;
}
