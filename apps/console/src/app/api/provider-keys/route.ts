import { enqueueProviderConnectivityCheckJob } from "@llmingress/db/provider-jobs";
import { type NextRequest, NextResponse } from "next/server";
import { sessionCookieName, verifyConsoleSession } from "../../../server/auth";
import {
  deleteProviderApiKey,
  readConsoleMasterKeySource,
  saveProviderApiKey,
} from "../../../server/provider-keys";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const action = readOptionalText(form, "action") ?? "save";

    if (action === "delete") {
      const providerApiKeyId = readRequiredText(form, "providerApiKeyId");
      const result = await deleteProviderApiKey({ providerApiKeyId });
      return NextResponse.redirect(
        new URL(`/providers?selected=${encodeURIComponent(result.providerId)}`, request.url),
        303,
      );
    }

    const providerId = readRequiredText(form, "providerId");
    const plaintext = readRequiredText(form, "providerApiKey");
    const result = await saveProviderApiKey({
      label: readOptionalText(form, "label"),
      masterKeySource: readConsoleMasterKeySource(),
      plaintext,
      priority: readOptionalNumber(form, "priority"),
      providerId,
    });
    await enqueueProviderConnectivityCheckJob({
      providerApiKeyId: result.metadata.id,
      providerId,
    });

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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Provider API key operation failed." },
      { status: 400 },
    );
  }
}

function readOptionalText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

function readRequiredText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function readOptionalNumber(form: FormData, name: string): number | undefined {
  const value = readOptionalText(form, name);
  return value === undefined ? undefined : Number(value);
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
