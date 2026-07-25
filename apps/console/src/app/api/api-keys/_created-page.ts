import { gatewayPublicBaseUrl } from "@llmingress/config";
import type { ConsoleApiKeyLimit } from "@llmingress/db/console-api-key-limits";
import type { ApiKeyAllowedVirtualModel } from "@llmingress/db/console-api-keys";
import { NextResponse } from "next/server";
import {
  buildIntegrationGuides,
  type IntegrationGuideEntry,
} from "../../_ui/api-keys/integration-guide";

export function renderOneTimeApiKeyResponse(
  input: {
    createdAt: Date;
    defaultVirtualModelName: string | null;
    enabled: boolean;
    keyPrefix: string | null;
    limits: readonly ConsoleApiKeyLimit[];
    name: string;
    plaintext: string;
    virtualModelName: string | null;
    virtualModels: readonly ApiKeyAllowedVirtualModel[];
  },
  format: "html" | "json" = "html",
): NextResponse {
  const apiKey = input.plaintext.trim();
  if (!apiKey) {
    throw new Error("API key is required for connection details.");
  }
  const gatewayBaseUrl = gatewayPublicBaseUrl().trim().replace(/\/+$/, "");
  const virtualModelName = input.virtualModelName?.trim() || "No Virtual Model configured";
  const guides = buildIntegrationGuides({ apiKey, gatewayBaseUrl, model: virtualModelName });
  const keyPrefix = input.keyPrefix ?? apiKey.slice(0, 12);

  if (format === "json") {
    return NextResponse.json(
      {
        apiKey,
        createdAt: input.createdAt.toISOString(),
        defaultVirtualModelName: input.defaultVirtualModelName,
        enabled: input.enabled,
        gatewayBaseUrl,
        guides,
        keyPrefix,
        limits: input.limits,
        name: input.name,
        virtualModelName,
        virtualModels: input.virtualModels,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }

  const summaryRows: Array<[string, string]> = [
    ["gateway", gatewayBaseUrl],
    ["default model", input.defaultVirtualModelName ?? "none — clients must send a model"],
    [
      "also granted",
      input.virtualModels
        .map((model) => model.name)
        .filter((name) => name !== input.defaultVirtualModelName)
        .join(", ") || "—",
    ],
    ["limits", formatLimitSummary(input.limits)],
  ];

  return new NextResponse(
    `<!doctype html>
<html lang="en" data-theme="light">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>API key created</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;500;600&amp;family=DM+Mono:wght@400;500&amp;display=swap" rel="stylesheet" />
    <style>${pageStyles()}</style>
  </head>
  <body>
    <main>
      <header>
        <h1>API key created</h1>
        <span class="note">${escapeHtml(input.name)}</span>
      </header>
      <div class="split">
        <section aria-label="Secret">
          <p class="label">SECRET · SHOWN ONCE</p>
          <div class="secret">
            <code id="secret">${escapeHtml(apiKey)}</code>
            <button type="button" id="copy">Copy</button>
          </div>
          <p class="warn">Stored hashed — it cannot be shown again. Copy it before closing.</p>
        </section>
        <section aria-label="Configuration">
          <p class="label">CONFIGURATION</p>
          <dl>
            ${summaryRows
              .map(
                ([term, value]) =>
                  `<div><dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd></div>`,
              )
              .join("")}
          </dl>
        </section>
      </div>

      <p class="label spaced">SET UP YOUR AGENT</p>
      <div class="tabs">
        ${guides
          .map(
            (entry, index) =>
              `<input type="radio" name="guide" id="tab-${escapeHtml(entry.platform)}" ${
                index === 0 ? "checked" : ""
              } /><label for="tab-${escapeHtml(entry.platform)}">${escapeHtml(entry.label)}</label>`,
          )
          .join("")}
        ${guides.map((entry) => renderGuidePanel(entry)).join("")}
        <style>${guides
          .map((entry) => `#tab-${entry.platform}:checked ~ #panel-${entry.platform}{display:grid}`)
          .join("")}</style>
      </div>

      <footer>
        <a class="primary" href="/api-keys">Done</a>
        <a href="/playground">Test in Playground</a>
      </footer>
    </main>
    <div id="toast" role="status" hidden>Secret copied to the clipboard<span>It is not stored anywhere else — paste it into your agent now.</span></div>
    <script>
      document.getElementById("copy").addEventListener("click", async () => {
        await navigator.clipboard.writeText(document.getElementById("secret").textContent ?? "");
        const toast = document.getElementById("toast");
        toast.hidden = false;
        setTimeout(() => { toast.hidden = true; }, 4000);
      });
    </script>
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

/** Same tokens as the console, inlined because this page renders outside it. */
function pageStyles(): string {
  return `
:root{--bg:#ffffff;--ink:#23262b;--seg:#343a42;--segfg:#ffffff;--dim:#767d86;--faint:#a2a8b0;--hair:#ccd4dc;--rule:#e6eaef;--rule2:#f2f4f7;--track:#edf0f4;--btnbg:#fbfcfd;--btnbd:#ccd3da;--accent:oklch(0.64 0.13 245);--ambtx:oklch(0.56 0.12 68);--ambbd:oklch(0.88 0.08 85);--sans:'Open Sans',system-ui,sans-serif;--mono:'DM Mono',ui-monospace,monospace}
@media (prefers-color-scheme: dark){:root{--bg:#15181c;--ink:#e9ecf0;--seg:oklch(0.72 0.12 245);--segfg:#15181c;--dim:#b3bac2;--faint:#8b929b;--hair:rgba(255,255,255,.17);--rule:rgba(255,255,255,.09);--rule2:rgba(255,255,255,.05);--track:#20242a;--btnbg:#22262d;--btnbd:rgba(255,255,255,.22);--accent:oklch(0.70 0.12 245);--ambtx:oklch(0.85 0.11 82);--ambbd:rgba(226,182,96,.30)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:start center;padding:48px 32px;background:var(--bg);color:var(--ink);font-family:var(--sans)}
main{width:min(900px,100%);border:1px solid var(--hair);padding:24px 28px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
header{display:flex;align-items:center;gap:10px}
h1{margin:0;font:600 18px var(--sans)}
.note{font:400 12.5px var(--mono);color:var(--faint)}
.label{margin:0;font:500 11.5px var(--mono);color:var(--dim);letter-spacing:.08em}
.label.spaced{margin-top:20px}
.split{display:grid;grid-template-columns:1fr 300px;gap:24px;margin-top:16px;align-items:start}
.secret{display:flex;align-items:center;gap:10px;margin-top:6px;background:var(--track);border:1px solid var(--ambbd);border-radius:3px;padding:12px 14px}
.secret code{flex:1;font:500 15px var(--mono);word-break:break-all}
.secret button{flex:none;border:0;border-radius:3px;background:var(--seg);color:var(--segfg);font:500 13px var(--mono);padding:5px 14px;cursor:pointer}
.warn{margin:6px 0 0;font:400 12.5px var(--mono);color:var(--ambtx)}
dl{display:block;margin:6px 0 0;border-top:1px solid var(--hair)}
dl div{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--rule2);font:400 12.5px var(--mono)}
dt{color:var(--dim);flex:none}
dd{margin:0;text-align:right;overflow-wrap:anywhere}
.tabs{margin-top:6px}
.tabs input{position:absolute;opacity:0;pointer-events:none}
.tabs label{display:inline-block;padding:6px 12px;font:400 13px var(--mono);color:var(--dim);cursor:pointer;white-space:nowrap}
.tabs input:checked + label{color:var(--ink);font-weight:500;box-shadow:inset 0 -2px 0 var(--accent)}
.panel{display:none;grid-template-columns:1fr 1fr;gap:24px;margin-top:14px;border-top:1px solid var(--hair);padding-top:14px}
.panel ol{margin:0;padding-left:18px}
.panel li{font:400 13px var(--mono);line-height:1.6;margin-bottom:7px}
.panel h2{margin:0 0 5px;font:500 11.5px var(--mono);color:var(--dim);letter-spacing:.08em}
pre{margin:0 0 10px;background:var(--track);border:1px solid var(--rule);border-radius:3px;padding:10px 12px;font:400 12px var(--mono);line-height:1.65;white-space:pre-wrap}
footer{display:flex;align-items:center;gap:8px;margin-top:20px;padding-top:14px;border-top:1px solid var(--hair)}
footer a{display:inline-flex;align-items:center;border:1px solid var(--btnbd);background:var(--btnbg);color:var(--ink);border-radius:3px;font:500 13.5px var(--mono);padding:6px 12px;text-decoration:none}
footer a.primary{border-color:transparent;background:var(--seg);color:var(--segfg);padding:6px 18px}
#toast{position:fixed;right:24px;bottom:24px;width:420px;max-width:calc(100vw - 48px);background:var(--btnbg);border:1px solid var(--hair);border-left:3px solid var(--accent);border-radius:4px;padding:11px 14px;font:400 13px var(--mono);box-shadow:0 8px 24px rgba(0,0,0,.18)}
#toast span{display:block;margin-top:3px;font-size:12.5px;color:var(--faint)}
`;
}

function formatLimitSummary(limits: readonly ConsoleApiKeyLimit[]): string {
  if (limits.length === 0) {
    return "no rules — unlimited";
  }
  return limits
    .map((limit) =>
      limit.limitType === "budget"
        ? `$${limit.limitValue} ${limit.period}`
        : `${limit.limitValue} ${limit.limitType}`,
    )
    .join(" · ");
}

function renderGuidePanel(entry: IntegrationGuideEntry): string {
  return `<div class="panel" id="panel-${escapeHtml(entry.platform)}">
        <div>
          <h2>${escapeHtml(entry.guide.title)}</h2>
          <ol>${entry.guide.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
        </div>
        <div>
          ${entry.guide.codeBlocks
            .map(
              (block) => `<h2>${escapeHtml(block.label)}</h2><pre>${escapeHtml(block.code)}</pre>`,
            )
            .join("")}
        </div>
      </div>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
