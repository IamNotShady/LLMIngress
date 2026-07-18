import { gatewayPublicBaseUrl } from "@llmingress/config";
import { NextResponse } from "next/server";
import {
  type AgentIntegrationGuideEntry,
  buildAgentIntegrationGuides,
} from "../../_modules/agent-integration-guide";

export function renderOneTimeAgentResponse(
  input: {
    keyPrefix: string | null;
    plaintext: string;
    virtualModelName: string | null;
  },
  format: "html" | "json" = "html",
): NextResponse {
  const apiKey = input.plaintext.trim();
  if (!apiKey) {
    throw new Error("API key is required for Agent connection details.");
  }
  const gatewayBaseUrl = gatewayPublicBaseUrl().trim().replace(/\/+$/, "");
  const virtualModelName = input.virtualModelName?.trim() || "No Virtual Model configured";
  const guides = buildAgentIntegrationGuides({ apiKey, gatewayBaseUrl, model: virtualModelName });
  const keyPrefix = input.keyPrefix ?? apiKey.slice(0, 12);

  if (format === "json") {
    return NextResponse.json(
      { apiKey, gatewayBaseUrl, guides, keyPrefix, virtualModelName },
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
            <dd><code>${escapeHtml(apiKey)}</code></dd>
          </div>
          <div>
            <dt>Gateway URL</dt>
            <dd>${escapeHtml(gatewayBaseUrl)}</dd>
          </div>
        </dl>
      </section>
      ${guides.map((entry) => renderGuideSection(entry)).join("")}
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

function renderGuideSection(entry: AgentIntegrationGuideEntry): string {
  return `<section aria-label="${escapeHtml(entry.label)} configuration">
        <h2>${escapeHtml(entry.guide.title)}</h2>
        <ol>${entry.guide.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
        ${entry.guide.codeBlocks
          .map(
            (block) =>
              `<h3>${escapeHtml(block.label)}</h3><pre><code>${escapeHtml(block.code)}</code></pre>`,
          )
          .join("")}
      </section>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
