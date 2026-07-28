import {
  standaloneCopyScript,
  standaloneThemeCss,
  standaloneThemeHead,
} from "../_standalone-theme";

/**
 * The page a saved provider credential renders on its own, outside the console
 * shell. It exists for the browser that posted the form without JavaScript —
 * the console's own dialog reports through its answer — and it is the only
 * place the pasted secret is echoed back, once.
 */
export function renderOneTimeProviderKeyPage(input: {
  action: "created" | "rotated";
  keyPrefix: string;
  plaintext: string;
}): string {
  const heading =
    input.action === "created" ? "Provider API key saved" : "Provider API key rotated";

  // Rendered outside the console shell — same tokens, and the same rule for
  // which theme they resolve to, so landing here does not change the console's
  // appearance under the operator.
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(heading)}</title>
    ${standaloneThemeHead()}
    <style>
      ${standaloneThemeCss()}
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: start center; padding: 48px 32px; background: var(--bg); color: var(--ink); font-family: var(--sans); }
      main { width: min(560px, 100%); border: 1px solid var(--hair); background: var(--bg); padding: 24px 28px; box-shadow: var(--shadow-dialog); }
      h1 { margin: 0 0 16px; font: 600 18px var(--sans); }
      dl { display: block; margin: 0 0 20px; border-top: 1px solid var(--hair); }
      dl div { padding: 10px 0; border-bottom: 1px solid var(--rule2); }
      dt { font: 500 11.5px var(--mono); color: var(--dim); letter-spacing: .08em; }
      dd { margin: 6px 0 0; font: 400 13.5px var(--mono); color: var(--ink); overflow-wrap: anywhere; }
      code { display: block; border: 1px solid var(--ambbd); border-radius: 3px; background: var(--track); padding: 12px 66px 12px 14px; font: 500 15px var(--mono); overflow-wrap: anywhere; }
      a { display: inline-flex; align-items: center; border: 1px solid transparent; border-radius: 3px; background: var(--seg); color: var(--segfg); font: 500 13.5px var(--mono); padding: 6px 18px; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(heading)}</h1>
      <dl>
        <div>
          <dt>PROVIDER API KEY · SHOWN ONCE</dt>
          <dd class="codewrap">
            <code id="provider-key">${escapeHtml(input.plaintext)}</code>
            <button type="button" class="copy" data-copy="#provider-key">Copy</button>
          </dd>
        </div>
        <div>
          <dt>PREFIX</dt>
          <dd>${escapeHtml(input.keyPrefix)}</dd>
        </div>
      </dl>
      <a href="/providers">Back to Providers</a>
    </main>
    <script>${standaloneCopyScript()}</script>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
