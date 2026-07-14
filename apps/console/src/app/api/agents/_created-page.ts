import { gatewayPublicBaseUrl } from "@llmingress/config";
import type { AgentIntegrationPlatform } from "@llmingress/db/console-agents";
import { NextResponse } from "next/server";

export type AgentConfigurationGuide = {
  codeBlocks: Array<{ code: string; label: string }>;
  steps: string[];
  title: string;
};

export function renderOneTimeAgentResponse(
  input: {
    keyPrefix: string | null;
    integrationPlatform: AgentIntegrationPlatform;
    plaintext: string;
    virtualModelName: string | null;
  },
  format: "html" | "json" = "html",
): NextResponse {
  const connectionDetails = buildAgentConnectionDetails({
    apiKey: input.plaintext,
    gatewayBaseUrl: gatewayPublicBaseUrl(),
    integrationPlatform: input.integrationPlatform,
    model: input.virtualModelName ?? "No Virtual Model configured",
  });
  const configurationGuide = buildAgentConfigurationGuide(connectionDetails);
  const keyPrefix = input.keyPrefix ?? connectionDetails.apiKey.slice(0, 12);

  if (format === "json") {
    return NextResponse.json(
      {
        apiKey: connectionDetails.apiKey,
        configurationGuide,
        gatewayBaseUrl: connectionDetails.gatewayBaseUrl,
        integrationPlatform: connectionDetails.integrationPlatform,
        keyPrefix,
        virtualModelName: connectionDetails.model,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Agent created</title>
    <style>
      :root { color: #101828; background: #f6f7f9; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; }
      main { width: min(560px, 100%); border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; padding: 28px; }
      h1 { margin: 0 0 16px; font-size: 28px; line-height: 1.2; }
      h2 { margin: 0 0 12px; font-size: 18px; line-height: 1.3; }
      section { margin: 0 0 24px; }
      dl { display: grid; gap: 10px; margin: 0 0 24px; }
      dt { color: #667085; font-size: 13px; font-weight: 700; }
      dd { margin: 0; color: #101828; font-size: 16px; overflow-wrap: anywhere; }
      code { border: 1px solid #d0d5dd; border-radius: 6px; background: #f9fafb; display: block; padding: 12px; }
      a { display: inline-flex; min-height: 44px; align-items: center; border-radius: 6px; background: #175cd3; color: #fff; font-weight: 700; padding: 10px 14px; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent created</h1>
      <section aria-label="Connection details">
        <h2>Connection details</h2>
        <dl>
          <div>
            <dt>Agent API key</dt>
            <dd><code>${escapeHtml(connectionDetails.apiKey)}</code></dd>
          </div>
          <div>
            <dt>Gateway URL</dt>
            <dd>${escapeHtml(connectionDetails.gatewayBaseUrl)}</dd>
          </div>
        </dl>
      </section>
      <section aria-label="Platform configuration">
        <h2>${escapeHtml(configurationGuide.title)}</h2>
        <ol>${configurationGuide.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
        ${configurationGuide.codeBlocks
          .map(
            (block) =>
              `<h3>${escapeHtml(block.label)}</h3><pre><code>${escapeHtml(block.code)}</code></pre>`,
          )
          .join("")}
      </section>
      <a href="/agents">Back to dashboard</a>
    </main>
  </body>
</html>`,
    {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/html; charset=utf-8",
      },
      status: 200,
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type AgentConnectionDetails = {
  apiKey: string;
  gatewayBaseUrl: string;
  integrationPlatform: AgentIntegrationPlatform;
  model: string;
};

function buildAgentConnectionDetails(input: {
  apiKey: string;
  gatewayBaseUrl: string;
  integrationPlatform: AgentIntegrationPlatform;
  model: string;
}): AgentConnectionDetails {
  return {
    apiKey: normalizeSnippetField(input.apiKey, "API key"),
    gatewayBaseUrl: normalizeGatewayBaseUrl(input.gatewayBaseUrl),
    integrationPlatform: input.integrationPlatform,
    model: normalizeSnippetField(input.model || "<Virtual Model Name>", "model"),
  };
}

export function buildAgentConfigurationGuide(
  input: AgentConnectionDetails,
): AgentConfigurationGuide {
  const gatewayBaseUrl = normalizeGatewayBaseUrl(input.gatewayBaseUrl);
  const openAiBaseUrl = `${gatewayBaseUrl}/v1`;
  const model = normalizeSnippetField(input.model, "model");
  const apiKey = normalizeSnippetField(input.apiKey, "API key");

  if (input.integrationPlatform === "codex") {
    return {
      title: "Configure Codex",
      steps: [
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
        "Export the LLMIngress Agent key and Gateway URL.",
        "Start Claude Code with the selected Virtual Model.",
      ],
      codeBlocks: [
        {
          label: "Shell",
          code: `export ANTHROPIC_AUTH_TOKEN=${shellQuote(apiKey)}\nexport ANTHROPIC_BASE_URL=${shellQuote(gatewayBaseUrl)}\nclaude --model ${shellQuote(model)}`,
        },
      ],
    };
  }

  if (input.integrationPlatform === "cursor") {
    return uiGuide("Configure Cursor", [
      "Open Cursor Settings, then open Models.",
      `Enter the Agent API key ${apiKey} in the OpenAI API key field.`,
      `Set Override OpenAI Base URL to ${openAiBaseUrl}.`,
      `Add or select the model ${model}, then verify the connection.`,
    ]);
  }

  if (input.integrationPlatform === "opencode") {
    return {
      title: "Configure OpenCode",
      steps: [
        "Run /connect in OpenCode and store the Agent API key for the llmingress provider.",
        "Add the provider and Virtual Model to your OpenCode configuration.",
      ],
      codeBlocks: [
        {
          label: "opencode.json",
          code: JSON.stringify(
            {
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
    return uiGuide("Configure GitHub Copilot", [
      "Open GitHub Copilot app settings, then Model providers.",
      "Choose Add provider and select an OpenAI-compatible HTTP endpoint.",
      `Enter ${openAiBaseUrl} as the base URL and ${apiKey} as the API key.`,
      `Add ${model} as an available model and save the provider.`,
    ]);
  }

  return uiGuide("Configure your integration", [
    `Use ${gatewayBaseUrl} as the Gateway URL.`,
    `Send ${apiKey} as a Bearer API key.`,
    `Use ${model} as the Virtual Model name.`,
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
