import type { ApiKeyAllowedVirtualModel } from "@llmingress/db/console-api-keys";
import type { RouteEndpointProtocol } from "@llmingress/domain";

// Platform enum is a UI-local vocabulary: the API key entity no longer carries
// an integration_platform column, and this module is bundled into client
// components, so it must not runtime-import @llmingress/db (node-only).
export type IntegrationPlatform =
  | "codex"
  | "claude-code"
  | "cursor"
  | "opencode"
  | "hermes"
  | "openclaw"
  | "github-copilot"
  | "other";

export const integrationGuidePlatforms: readonly IntegrationPlatform[] = [
  "codex",
  "claude-code",
  "cursor",
  "opencode",
  "hermes",
  "openclaw",
  "github-copilot",
  "other",
];

export type ConfigurationGuide = {
  codeBlocks: Array<{ code: string; label: string }>;
  /**
   * Which endpoint this agent speaks, and therefore what the virtual model has
   * to be routed to. It is a precondition rather than a step — following the
   * steps with the wrong route protocol produces a 404 from the Gateway, not a
   * misconfigured agent — so it reads after them rather than as the first one.
   */
  note?: string;
  steps: string[];
  title: string;
};

export type IntegrationGuideEntry = {
  guide: ConfigurationGuide;
  label: string;
  platform: IntegrationPlatform;
};

const integrationPlatformLabels: Record<IntegrationPlatform, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  "github-copilot": "GitHub Copilot",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  opencode: "OpenCode",
  other: "Other / curl",
};

const routeNote = (agent: string, endpoint: string, path: string) =>
  `${agent} calls the ${endpoint} endpoint — the virtual model must be routed to ${path}.`;

export function formatIntegrationPlatformLabel(platform: IntegrationPlatform): string {
  return integrationPlatformLabels[platform];
}

export function buildIntegrationGuides(input: {
  apiKey: string;
  gatewayBaseUrl: string;
  model: string;
}): IntegrationGuideEntry[] {
  return integrationGuidePlatforms.map((platform) => ({
    guide: buildConfigurationGuide({ ...input, integrationPlatform: platform }),
    label: formatIntegrationPlatformLabel(platform),
    platform,
  }));
}

export function buildConfigurationGuide(input: {
  apiKey: string;
  gatewayBaseUrl: string;
  integrationPlatform: IntegrationPlatform;
  model: string;
}): ConfigurationGuide {
  const gatewayBaseUrl = normalizeGatewayBaseUrl(input.gatewayBaseUrl);
  const openAiBaseUrl = `${gatewayBaseUrl}/v1`;
  const model = normalizeSnippetField(input.model, "model");
  const apiKey = normalizeSnippetField(input.apiKey, "API key");

  if (input.integrationPlatform === "codex") {
    return {
      title: "Configure Codex",
      note: routeNote("Codex", "Responses", "/v1/responses"),
      steps: [
        "Export the API key in your shell.",
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
      note: routeNote("Claude Code", "Messages", "/v1/messages"),
      steps: [
        "Export the LLMIngress API key and Gateway URL.",
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
    return uiGuide(
      "Configure Cursor",
      [
        "Open Cursor Settings, then open Models.",
        `Enter the API key ${apiKey} in the OpenAI API key field.`,
        `Set Override OpenAI Base URL to ${openAiBaseUrl}.`,
        `Add or select the model ${model}, then verify the connection.`,
      ],
      `${routeNote("Cursor", "Chat Completions", "/v1/chat/completions")} The Gateway URL must be reachable from Cursor's servers, so a localhost or private address will not work, and custom keys apply to chat only — Tab completion and Agent features keep using Cursor's built-in models.`,
    );
  }

  if (input.integrationPlatform === "opencode") {
    return {
      title: "Configure OpenCode",
      note: routeNote("OpenCode", "Chat Completions", "/v1/chat/completions"),
      steps: [
        "Run /connect in OpenCode, pick Other, enter llmingress as the provider id, then paste the API key.",
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
    return uiGuide(
      "Configure Hermes",
      [
        "Run hermes model and choose Custom endpoint.",
        `Enter ${openAiBaseUrl} as the API base URL.`,
        `Enter ${apiKey} as the API key and ${model} as the model name.`,
      ],
      routeNote("Hermes", "Chat Completions", "/v1/chat/completions"),
    );
  }

  if (input.integrationPlatform === "openclaw") {
    return {
      title: "Configure OpenClaw",
      note: routeNote("OpenClaw", "Responses", "/v1/responses"),
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
      note: routeNote("GitHub Copilot", "Chat Completions", "/v1/chat/completions"),
      steps: [
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

  return uiGuide(
    "Configure your integration",
    [
      `Use ${gatewayBaseUrl} as the Gateway URL.`,
      `Send ${apiKey} as a Bearer API key.`,
      `Use ${model} as the Virtual Model name.`,
    ],
    "Call the endpoint path that matches the virtual model's route policy: /v1/chat/completions, /v1/responses, or /v1/messages.",
  );
}

function uiGuide(title: string, steps: string[], note?: string): ConfigurationGuide {
  return { codeBlocks: [], note, steps, title };
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
    throw new Error(`${label} is required for API key connection details.`);
  }
  return normalized;
}

// ---- Endpoint grouping (Console-only; Gateway paths live in apps/gateway/src/main.ts) ----

export const endpointPathByProtocol: Record<RouteEndpointProtocol, string> = {
  chat_completions: "/v1/chat/completions",
  messages: "/v1/messages",
  responses: "/v1/responses",
};

const apiKeyEndpointOrder: readonly RouteEndpointProtocol[] = [
  "chat_completions",
  "responses",
  "messages",
];

export type EndpointGroup = {
  protocol: RouteEndpointProtocol;
  url: string;
  virtualModels: ApiKeyAllowedVirtualModel[];
};

export type EndpointGroups = {
  configured: EndpointGroup[];
  unrouted: ApiKeyAllowedVirtualModel[];
};

export function groupVirtualModelEndpoints(input: {
  gatewayBaseUrl: string;
  virtualModels: readonly ApiKeyAllowedVirtualModel[];
}): EndpointGroups {
  const gatewayBaseUrl = input.gatewayBaseUrl.trim().replace(/\/+$/, "");
  const byProtocol = new Map<RouteEndpointProtocol, ApiKeyAllowedVirtualModel[]>();
  const unrouted: ApiKeyAllowedVirtualModel[] = [];
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
    configured: apiKeyEndpointOrder.flatMap((protocol) => {
      const virtualModels = byProtocol.get(protocol);
      return virtualModels
        ? [
            {
              protocol,
              url: `${gatewayBaseUrl}${endpointPathByProtocol[protocol]}`,
              virtualModels,
            },
          ]
        : [];
    }),
    unrouted,
  };
}
