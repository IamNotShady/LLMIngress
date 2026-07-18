import type {
  AgentAllowedVirtualModel,
  AgentIntegrationPlatform,
} from "@llmingress/db/console-agents";
import type { RouteEndpointProtocol } from "@llmingress/domain";

export const AGENT_API_KEY_PLACEHOLDER = "<YOUR_AGENT_API_KEY>";

// Local copy of the platform order: this module is bundled into client
// components, so it must not runtime-import @llmingress/db (node-only).
// tests/features/agent-integration-guidance.unit.case.ts pins it to
// agentIntegrationPlatforms from the db package.
export const agentIntegrationGuidePlatforms: readonly AgentIntegrationPlatform[] = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "hermes",
  "openclaw",
  "github-copilot",
  "other",
];

export type AgentConfigurationGuide = {
  codeBlocks: Array<{ code: string; label: string }>;
  steps: string[];
  title: string;
};

export type AgentIntegrationGuideEntry = {
  guide: AgentConfigurationGuide;
  label: string;
  platform: AgentIntegrationPlatform;
};

const agentIntegrationPlatformLabels: Record<AgentIntegrationPlatform, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "github-copilot": "GitHub Copilot",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  opencode: "OpenCode",
  other: "Other",
};

export function formatAgentIntegrationPlatformLabel(platform: AgentIntegrationPlatform): string {
  return agentIntegrationPlatformLabels[platform];
}

export function buildAgentIntegrationGuides(input: {
  apiKey: string;
  gatewayBaseUrl: string;
  model: string;
}): AgentIntegrationGuideEntry[] {
  return agentIntegrationGuidePlatforms.map((platform) => ({
    guide: buildAgentConfigurationGuide({ ...input, integrationPlatform: platform }),
    label: formatAgentIntegrationPlatformLabel(platform),
    platform,
  }));
}

export function buildAgentConfigurationGuide(input: {
  apiKey: string;
  gatewayBaseUrl: string;
  integrationPlatform: AgentIntegrationPlatform;
  model: string;
}): AgentConfigurationGuide {
  const gatewayBaseUrl = normalizeGatewayBaseUrl(input.gatewayBaseUrl);
  const openAiBaseUrl = `${gatewayBaseUrl}/v1`;
  const model = normalizeSnippetField(input.model, "model");
  const apiKey = normalizeSnippetField(input.apiKey, "API key");

  if (input.integrationPlatform === "codex") {
    return {
      title: "Configure Codex",
      steps: [
        "Codex calls the Responses endpoint; use a Virtual Model routed to /v1/responses.",
        "Export the Agent API key in your shell.",
        "Add the LLMIngress provider to the user-level ~/.codex/config.toml file.",
        "Start Codex; the configured Virtual Model will be sent through LLMIngress.",
      ],
      codeBlocks: [
        { label: "Shell", code: `export LLMINGRESS_API_KEY=${shellQuote(apiKey)}` },
        {
          label: "~/.codex/config.toml",
          code: `model = ${JSON.stringify(model)}\nmodel_provider = "llmingress"\n\n[model_providers.llmingress]\nname = "LLMIngress"\nbase_url = ${JSON.stringify(openAiBaseUrl)}\nenv_key = "LLMINGRESS_API_KEY"\nwire_api = "responses"`,
        },
      ],
    };
  }

  if (input.integrationPlatform === "claude-code") {
    return {
      title: "Configure Claude Code",
      steps: [
        "Claude Code calls the Messages endpoint; use a Virtual Model routed to /v1/messages.",
        "Export the LLMIngress Agent key and Gateway URL.",
        "Start Claude Code with the selected Virtual Model.",
      ],
      codeBlocks: [
        {
          label: "Shell",
          code: `export ANTHROPIC_AUTH_TOKEN=${shellQuote(apiKey)}\nexport ANTHROPIC_BASE_URL=${shellQuote(gatewayBaseUrl)}\nexport ANTHROPIC_DEFAULT_HAIKU_MODEL=${shellQuote(model)}\nclaude --model ${shellQuote(model)}`,
        },
      ],
    };
  }

  if (input.integrationPlatform === "cursor") {
    return uiGuide("Configure Cursor", [
      "Cursor calls the Chat Completions endpoint; use a Virtual Model routed to /v1/chat/completions.",
      "Open Cursor Settings, then open Models.",
      `Enter the Agent API key ${apiKey} in the OpenAI API key field.`,
      `Set Override OpenAI Base URL to ${openAiBaseUrl}.`,
      `Add or select the model ${model}, then verify the connection.`,
      "The Gateway URL must be reachable from Cursor's servers; a localhost or private address will not work.",
      "Custom keys apply to chat only; Tab completion and Agent features keep using Cursor's built-in models.",
    ]);
  }

  if (input.integrationPlatform === "opencode") {
    return {
      title: "Configure OpenCode",
      steps: [
        "OpenCode calls the Chat Completions endpoint; use a Virtual Model routed to /v1/chat/completions.",
        "Run /connect in OpenCode, pick Other, enter llmingress as the provider id, then paste the Agent API key.",
        "Add the provider and Virtual Model to your OpenCode configuration.",
      ],
      codeBlocks: [
        {
          label: "opencode.json",
          code: JSON.stringify(
            {
              $schema: "https://opencode.ai/config.json",
              provider: {
                llmingress: {
                  models: { [model]: { name: model } },
                  name: "LLMIngress",
                  npm: "@ai-sdk/openai-compatible",
                  options: { baseURL: openAiBaseUrl },
                },
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (input.integrationPlatform === "hermes") {
    return uiGuide("Configure Hermes", [
      "Hermes calls the Chat Completions endpoint; use a Virtual Model routed to /v1/chat/completions.",
      "Run hermes model and choose Custom endpoint.",
      `Enter ${openAiBaseUrl} as the API base URL.`,
      `Enter ${apiKey} as the API key and ${model} as the model name.`,
    ]);
  }

  if (input.integrationPlatform === "openclaw") {
    return {
      title: "Configure OpenClaw",
      steps: ["Add LLMIngress as a custom provider, then select its Virtual Model."],
      codeBlocks: [
        {
          label: "openclaw.json",
          code: JSON.stringify(
            {
              agents: { defaults: { model: { primary: `llmingress/${model}` } } },
              models: {
                providers: {
                  llmingress: {
                    api: "openai-responses",
                    apiKey,
                    baseUrl: openAiBaseUrl,
                    models: [{ id: model, name: model }],
                  },
                },
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (input.integrationPlatform === "github-copilot") {
    return {
      title: "Configure GitHub Copilot",
      steps: [
        "GitHub Copilot is configured here for the Chat Completions endpoint; use a Virtual Model routed to /v1/chat/completions.",
        "In VS Code, run Chat: Manage Language Models from the Command Palette, choose Add Models, then Custom Endpoint.",
        `Enter ${gatewayBaseUrl}/v1/chat/completions as the model url, ${apiKey} as the API key, and add ${model} as the model id.`,
        "Or use Copilot CLI with the environment variables below.",
      ],
      codeBlocks: [
        {
          label: "Copilot CLI shell",
          code: `export COPILOT_PROVIDER_BASE_URL=${shellQuote(openAiBaseUrl)}\nexport COPILOT_PROVIDER_API_KEY=${shellQuote(apiKey)}\nexport COPILOT_MODEL=${shellQuote(model)}\ncopilot`,
        },
      ],
    };
  }

  return uiGuide("Configure your integration", [
    `Use ${gatewayBaseUrl} as the Gateway URL.`,
    `Send ${apiKey} as a Bearer API key.`,
    `Use ${model} as the Virtual Model name.`,
    "Call the endpoint path that matches the Virtual Model's route policy: /v1/chat/completions, /v1/responses, or /v1/messages.",
  ]);
}

function uiGuide(title: string, steps: string[]): AgentConfigurationGuide {
  return { codeBlocks: [], steps, title };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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

// ---- Endpoint grouping (Console-only; Gateway paths live in apps/gateway/src/main.ts) ----

export const agentEndpointPathByProtocol: Record<RouteEndpointProtocol, string> = {
  chat_completions: "/v1/chat/completions",
  messages: "/v1/messages",
  responses: "/v1/responses",
};

const agentEndpointOrder: readonly RouteEndpointProtocol[] = [
  "chat_completions",
  "responses",
  "messages",
];

export type AgentEndpointGroup = {
  protocol: RouteEndpointProtocol;
  url: string;
  virtualModels: AgentAllowedVirtualModel[];
};

export type AgentEndpointGroups = {
  configured: AgentEndpointGroup[];
  unrouted: AgentAllowedVirtualModel[];
};

export function groupAgentVirtualModelEndpoints(input: {
  gatewayBaseUrl: string;
  virtualModels: readonly AgentAllowedVirtualModel[];
}): AgentEndpointGroups {
  const gatewayBaseUrl = input.gatewayBaseUrl.trim().replace(/\/+$/, "");
  const byProtocol = new Map<RouteEndpointProtocol, AgentAllowedVirtualModel[]>();
  const unrouted: AgentAllowedVirtualModel[] = [];
  for (const virtualModel of input.virtualModels) {
    if (!virtualModel.endpointProtocol) {
      unrouted.push(virtualModel);
      continue;
    }
    const group = byProtocol.get(virtualModel.endpointProtocol) ?? [];
    group.push(virtualModel);
    byProtocol.set(virtualModel.endpointProtocol, group);
  }
  return {
    configured: agentEndpointOrder.flatMap((protocol) => {
      const virtualModels = byProtocol.get(protocol);
      return virtualModels
        ? [
            {
              protocol,
              url: `${gatewayBaseUrl}${agentEndpointPathByProtocol[protocol]}`,
              virtualModels,
            },
          ]
        : [];
    }),
    unrouted,
  };
}
