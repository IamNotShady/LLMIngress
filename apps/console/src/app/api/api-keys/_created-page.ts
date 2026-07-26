import { gatewayPublicBaseUrl } from "@llmingress/config";
import type { ConsoleApiKeyLimit } from "@llmingress/db/console-api-key-limits";
import type { ApiKeyAllowedVirtualModel } from "@llmingress/db/console-api-keys";
import { NextResponse } from "next/server";
import {
  buildIntegrationGuides,
  type IntegrationGuideEntry,
} from "../../_ui/api-keys/integration-guide";
import { formatApiKeyLimitRules } from "../../_ui/api-keys/limits-view";
import { PLAYGROUND_KEY_HANDOFF } from "../../_ui/playground/handoff";
import {
  standaloneCopyScript,
  standaloneThemeCss,
  standaloneThemeHead,
} from "../_standalone-theme";

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
    ["limits", formatApiKeyLimitRules(input.limits)],
  ];

  return new NextResponse(
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>API key created</title>
    ${standaloneThemeHead()}
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
          <!-- A textarea rather than an input: with the button inside the box a
               one-line field would scroll the tail of the secret out of sight,
               and this is the only time it is ever shown. -->
          <div class="secret codewrap">
            <textarea id="secret" readonly rows="2" aria-label="API key secret">${escapeHtml(
              apiKey,
            )}</textarea>
            <button type="button" class="copy" data-copy="#secret">Copy</button>
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
              } /><label data-guide-tab for="tab-${escapeHtml(entry.platform)}">${escapeHtml(entry.label)}</label>`,
          )
          .join("")}
        ${guides.map((entry) => renderGuidePanel(entry)).join("")}
        <style>${guides
          .map((entry) => `#tab-${entry.platform}:checked ~ #panel-${entry.platform}{display:grid}`)
          .join("")}</style>
      </div>

      <footer>
        <a class="primary" href="/api-keys">Done</a>
        <a href="/playground" data-handoff="#secret">Test in Playground</a>
      </footer>
    </main>
    <script>${standaloneCopyScript()}</script>
    <script>${playgroundHandoffScript()}</script>
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
${standaloneThemeCss()}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:start center;padding:48px 32px;background:var(--bg);color:var(--ink);font-family:var(--sans)}
main{width:min(900px,100%);border:1px solid var(--hair);padding:24px 28px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
header{display:flex;align-items:center;gap:10px}
h1{margin:0;font:600 18px var(--sans)}
.note{font:400 12.5px var(--mono);color:var(--faint)}
.label{margin:0;font:500 11.5px var(--mono);color:var(--dim);letter-spacing:.08em}
.label.spaced{margin-top:20px}
.split{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;margin-top:16px;align-items:start}
.secret{margin-top:6px;background:var(--track);border:1px solid var(--ambbd);border-radius:3px;padding:12px 14px}
.secret textarea{display:block;width:100%;padding:0 58px 0 0;border:0;resize:none;overflow:auto;background:transparent;color:var(--ink);font:500 15px var(--mono);line-height:1.5;overflow-wrap:anywhere}
.codewrap pre{padding-right:66px}
.warn{margin:6px 0 0;font:400 12.5px var(--mono);color:var(--ambtx)}
dl{display:block;margin:6px 0 0;border-top:1px solid var(--hair)}
dl div{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid var(--rule2);font:400 12.5px var(--mono)}
dt{color:var(--dim);flex:none}
dd{margin:0;text-align:right;overflow-wrap:anywhere}
.tabs{margin-top:6px}
.tabs input{position:absolute;opacity:0;pointer-events:none}
.tabs label{display:inline-block;padding:6px 12px;font:400 13px var(--mono);color:var(--dim);cursor:pointer;white-space:nowrap}
.tabs input:checked + label{color:var(--ink);font-weight:500;box-shadow:inset 0 -2px 0 var(--accent)}
.panel{display:none;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px;margin-top:14px;border-top:1px solid var(--hair);padding-top:14px}
.panel ol{margin:0;padding-left:18px}
/* A step can name the whole secret, which has no spaces to break at. */
.panel li{font:400 13px var(--mono);line-height:1.6;margin-bottom:7px;overflow-wrap:anywhere}
.panel h2{margin:0 0 5px;font:500 11.5px var(--mono);color:var(--dim);letter-spacing:.08em}
.blockhead{display:flex;align-items:center;gap:8px;margin-bottom:5px}
.blockhead h2{margin:0;text-transform:uppercase}
.blockhead .copy{margin-left:auto}
.guide-title{margin:0 0 6px;font:500 13.5px var(--mono);color:var(--ink);letter-spacing:0}
.guide-note{margin:12px 0 0;font:400 13px var(--mono);line-height:1.6;color:var(--faint);overflow-wrap:anywhere}
pre{margin:0 0 10px;background:var(--track);border:1px solid var(--rule);border-radius:3px;padding:10px 12px;font:400 12px var(--mono);line-height:1.65;white-space:pre-wrap;overflow-wrap:anywhere}
footer{display:flex;align-items:center;gap:8px;margin-top:20px;padding-top:14px;border-top:1px solid var(--hair)}
footer a{display:inline-flex;align-items:center;border:1px solid var(--btnbd);background:var(--btnbg);color:var(--ink);border-radius:3px;font:500 13.5px var(--mono);padding:6px 12px;text-decoration:none}
footer a.primary{border-color:transparent;background:var(--seg);color:var(--segfg);padding:6px 18px}
@media (max-width:760px){body{padding:24px 16px}main{padding:20px 16px}.split,.panel{grid-template-columns:minmax(0,1fr)}.tabs label{white-space:normal;padding:6px 8px}.secret{padding:10px}}
`;
}

/**
 * Carries the secret to the Playground so the operator can send a request with
 * the key they just made. It rides in sessionStorage rather than the link — see
 * PLAYGROUND_KEY_HANDOFF — and the navigation itself is left alone.
 */
function playgroundHandoffScript(): string {
  return `(function(){
document.addEventListener("click",function(event){
var link=event.target&&event.target.closest?event.target.closest("[data-handoff]"):null;
if(!link){return}
var node=document.querySelector(link.getAttribute("data-handoff"));
if(!node){return}
try{sessionStorage.setItem(${JSON.stringify(PLAYGROUND_KEY_HANDOFF)},typeof node.value==="string"?node.value:node.textContent||"")}catch(e){}
});
})()`;
}

function renderGuidePanel(entry: IntegrationGuideEntry): string {
  return `<div class="panel" data-guide-panel id="panel-${escapeHtml(entry.platform)}">
        <div>
          <h2 class="guide-title">${escapeHtml(entry.guide.title)}</h2>
          <ol>${entry.guide.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>
          ${entry.guide.note ? `<p class="guide-note">${escapeHtml(entry.guide.note)}</p>` : ""}
        </div>
        <div>
          ${entry.guide.codeBlocks
            .map((block, index) => {
              // The key's detail renders the same label row, so an operator who
              // comes back later finds the snippet in the same shape.
              const id = `code-${escapeHtml(entry.platform)}-${index}`;
              // The button sits over the block rather than beside its label, and
              // outside the <pre> — inside, its own word would be copied with
              // the snippet.
              return `<div class="blockhead"><h2>${escapeHtml(
                block.label,
              )}</h2></div><div class="codewrap"><pre id="${id}">${escapeHtml(
                block.code,
              )}</pre><button type="button" class="copy" data-copy="#${id}">Copy</button></div>`;
            })
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
