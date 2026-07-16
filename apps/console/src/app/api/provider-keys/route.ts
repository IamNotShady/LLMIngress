import {
  deleteProviderApiKey,
  readConsoleEncryptionKeySource,
  saveProviderApiKey,
  setProviderApiKeyEnabled,
} from "@llmingress/db/console-provider-keys";
import {
  enqueueProviderConnectionProbeJob,
  enqueueProviderModelRefreshJob,
} from "@llmingress/db/provider-jobs";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readNumber, readRequiredText, readText } from "../_form";

export const POST = withConsoleAuth(async (request) => {
  try {
    const form = await request.formData();
    const action = readText(form, "action") ?? "save";

    if (action === "delete") {
      const providerApiKeyId = readRequiredText(form, "providerApiKeyId");
      const result = await deleteProviderApiKey({ providerApiKeyId });
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
    const plaintext = readRequiredText(form, "providerApiKey");
    const result = await saveProviderApiKey({
      label: readText(form, "label"),
      encryptionKeySource: readConsoleEncryptionKeySource(),
      plaintext,
      priority: readNumber(form, "priority"),
      providerApiKeyId: readText(form, "providerApiKeyId"),
      providerId,
    });
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

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(heading)}</title>
    <style>
      :root { color: #101828; background: #f6f7f9; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; }
      main { width: min(560px, 100%); border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; padding: 28px; }
      h1 { margin: 0 0 16px; font-size: 28px; line-height: 1.2; }
      dl { display: grid; gap: 10px; margin: 0 0 24px; }
      dt { color: #667085; font-size: 13px; font-weight: 700; }
      dd { margin: 0; color: #101828; font-size: 16px; overflow-wrap: anywhere; }
      code { border: 1px solid #d0d5dd; border-radius: 6px; background: #f9fafb; display: block; padding: 12px; }
      a { display: inline-flex; min-height: 44px; align-items: center; border-radius: 6px; background: #175cd3; color: #fff; font-weight: 700; padding: 10px 14px; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(heading)}</h1>
      <dl>
        <div>
          <dt>Provider API key</dt>
          <dd><code>${escapeHtml(input.plaintext)}</code></dd>
        </div>
        <div>
          <dt>Provider API key prefix</dt>
          <dd>${escapeHtml(input.keyPrefix)}</dd>
        </div>
      </dl>
      <a href="/providers">Back to dashboard</a>
    </main>
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
