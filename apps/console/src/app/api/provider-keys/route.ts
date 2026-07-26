import {
  deleteProviderApiKey,
  readConsoleEncryptionKeySource,
  saveProviderApiKey,
  setProviderApiKeyEnabled,
  setProviderApiKeyQuotaProbeEnabled,
  updateProviderApiKeySettings,
} from "@llmingress/db/console-provider-keys";
import {
  enqueueProviderConnectionProbeJob,
  enqueueProviderModelRefreshJob,
} from "@llmingress/db/provider-jobs";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readNumber, readRequiredText, readText } from "../_form";
import {
  standaloneCopyScript,
  standaloneThemeCss,
  standaloneThemeHead,
} from "../_standalone-theme";

export const POST = withConsoleAuth(async (request) => {
  try {
    const form = await request.formData();
    const action = readText(form, "action") ?? "save";

    if (action === "delete") {
      const providerApiKeyId = readRequiredText(form, "providerApiKeyId");
      const result = await deleteProviderApiKey({ providerApiKeyId });
      return providerApiKeyMutationResponse(request, result.providerId);
    }

    if (action === "quota-probe-enable" || action === "quota-probe-disable") {
      const result = await setProviderApiKeyQuotaProbeEnabled({
        providerApiKeyId: readRequiredText(form, "providerApiKeyId"),
        quotaProbeEnabled: action === "quota-probe-enable",
      });
      return providerApiKeyMutationResponse(request, result.providerId);
    }

    if (action === "enable" || action === "disable") {
      const result = await setProviderApiKeyEnabled({
        enabled: action === "enable",
        providerApiKeyId: readRequiredText(form, "providerApiKeyId"),
      });
      if (result.enabled) {
        await enqueueProviderConnectionProbeJob({
          providerConnectionId: result.id,
          providerId: result.providerId,
          resetHealth: true,
          source: "api_key_saved",
        });
        await enqueueProviderModelRefreshJob({
          providerId: result.providerId,
          source: "api_key_saved",
          trigger: "system",
        });
      }
      return providerApiKeyMutationResponse(request, result.providerId);
    }

    const providerId = readRequiredText(form, "providerId");
    const providerApiKeyId = readText(form, "providerApiKeyId");
    const pastedKey = readText(form, "providerApiKey");

    // The connection dialog saves everything about a connection at once: its
    // credential, what it is called, where it sits in the order, and whether it
    // routes and is probed. State is a field of the form, not a separate act.
    const enabled = readText(form, "enabled") !== "false";
    const quotaProbeEnabled = readText(form, "quotaProbeEnabled") !== "false";

    // Saving an existing connection without a new key keeps the stored one —
    // renaming a connection must not mean rotating a working credential.
    if (providerApiKeyId && !pastedKey) {
      const updated = await updateProviderApiKeySettings({
        enabled,
        label: readText(form, "label") ?? null,
        priority: readNumber(form, "priority") ?? 100,
        providerApiKeyId,
      });
      await setProviderApiKeyQuotaProbeEnabled({ providerApiKeyId, quotaProbeEnabled });
      if (updated.enabled) {
        await enqueueProviderConnectionProbeJob({
          providerConnectionId: updated.id,
          providerId: updated.providerId,
          resetHealth: true,
          source: "api_key_saved",
        });
      }
      return providerApiKeyMutationResponse(request, updated.providerId);
    }

    const plaintext = readRequiredText(form, "providerApiKey");
    const result = await saveProviderApiKey({
      enabled,
      label: readText(form, "label"),
      encryptionKeySource: readConsoleEncryptionKeySource(),
      plaintext,
      priority: readNumber(form, "priority"),
      providerApiKeyId,
      providerId,
    });
    await setProviderApiKeyQuotaProbeEnabled({
      providerApiKeyId: result.metadata.id,
      quotaProbeEnabled,
    });
    if (result.metadata.enabled) {
      await enqueueProviderConnectionProbeJob({
        providerConnectionId: result.metadata.id,
        providerId,
        resetHealth: true,
        source: "api_key_saved",
      });
      await enqueueProviderModelRefreshJob({
        providerId,
        source: "api_key_saved",
        trigger: "system",
      });
    }

    if (request.headers.get("accept")?.includes("application/json")) {
      return NextResponse.json(
        {
          action: result.action,
          apiKey: plaintext.trim(),
          keyPrefix: result.metadata.keyPrefix,
        },
        { headers: { "cache-control": "no-store" } },
      );
    }

    return new NextResponse(
      renderOneTimeProviderKeyPage({
        action: result.action,
        keyPrefix: result.metadata.keyPrefix,
        plaintext: plaintext.trim(),
      }),
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
        status: 200,
      },
    );
  } catch (error) {
    return consoleActionErrorResponse(error, "Provider API key operation failed.");
  }
});

function providerApiKeyMutationResponse(request: Request, providerId: string): NextResponse {
  if (request.headers.get("accept")?.includes("application/json")) {
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.redirect(
    new URL(`/providers?selected=${encodeURIComponent(providerId)}`, request.url),
    303,
  );
}

function renderOneTimeProviderKeyPage(input: {
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
      main { width: min(560px, 100%); border: 1px solid var(--hair); background: var(--bg); padding: 24px 28px; box-shadow: 0 12px 40px rgba(0,0,0,.25); }
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
