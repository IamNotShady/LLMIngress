import {
  enqueueProviderConnectivityCheckJob,
  enqueueProviderModelRefreshJob,
} from "@llmingress/db/provider-jobs";
import { type NextRequest, NextResponse } from "next/server";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../server/auth";
import { readConsoleMasterKeySource } from "../../../server/provider-keys";
import {
  completeProviderOAuthAuthorization,
  deleteProviderOAuthConnection,
  setProviderOAuthConnectionEnabled,
  startProviderOAuthConnection,
} from "../../../server/provider-oauth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const action = readOptionalText(form, "action") ?? "start";

    if (action === "complete") {
      const result = await completeProviderOAuthAuthorization({
        callbackInput: readRequiredText(form, "callbackInput"),
        databaseUrl,
        masterKeySource: readConsoleMasterKeySource(),
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      await enqueueProviderModelRefreshJob({ databaseUrl, providerId: result.providerId });
      await enqueueProviderConnectivityCheckJob({ databaseUrl, providerId: result.providerId });
      return redirectToProvider(request, result.providerId);
    }

    if (action === "delete") {
      const result = await deleteProviderOAuthConnection({
        databaseUrl,
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      return redirectToProvider(request, result.providerId);
    }

    if (action === "enable" || action === "disable") {
      const result = await setProviderOAuthConnectionEnabled({
        databaseUrl,
        enabled: action === "enable",
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      await enqueueProviderConnectivityCheckJob({ databaseUrl, providerId: result.providerId });
      return redirectToProvider(request, result.providerId);
    }

    const result = await startProviderOAuthConnection({
      databaseUrl,
      label: readOptionalText(form, "label"),
      priority: readOptionalNumber(form, "priority"),
      providerId: readRequiredText(form, "providerId"),
    });

    return new NextResponse(
      renderProviderOAuthAuthorizePage({
        authorizeUrl: result.authorizeUrl,
        providerOAuthId: result.connection.id,
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
      { error: error instanceof Error ? error.message : "Provider OAuth operation failed." },
      { status: 400 },
    );
  }
}

function redirectToProvider(request: NextRequest, providerId: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/providers?selected=${encodeURIComponent(providerId)}`, request.url),
    303,
  );
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

function renderProviderOAuthAuthorizePage(input: {
  authorizeUrl: string;
  providerOAuthId: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect provider OAuth</title>
    <style>
      :root { color: #101828; background: #f6f7f9; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 32px; }
      main { width: min(720px, 100%); border: 1px solid #d0d5dd; border-radius: 8px; background: #fff; padding: 28px; }
      h1 { margin: 0 0 16px; font-size: 28px; line-height: 1.2; }
      label { display: block; margin: 18px 0 8px; font-weight: 700; }
      input, textarea { width: 100%; border: 1px solid #d0d5dd; border-radius: 6px; font: inherit; padding: 12px; }
      code { border: 1px solid #d0d5dd; border-radius: 6px; background: #f9fafb; display: block; overflow-wrap: anywhere; padding: 12px; }
      a, button { display: inline-flex; min-height: 44px; align-items: center; border: 0; border-radius: 6px; background: #175cd3; color: #fff; cursor: pointer; font-weight: 700; margin-top: 18px; padding: 10px 14px; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>Connect provider OAuth</h1>
      <label>Authorization URL</label>
      <code>${escapeHtml(input.authorizeUrl)}</code>
      <a href="${escapeHtml(input.authorizeUrl)}" target="_blank" rel="noreferrer">Open authorization URL</a>
      <form action="/api/provider-oauth" method="post">
        <input type="hidden" name="action" value="complete" />
        <input type="hidden" name="providerOAuthId" value="${escapeHtml(input.providerOAuthId)}" />
        <label for="callback-input">Callback URL or authorization code</label>
        <textarea id="callback-input" name="callbackInput" rows="4" required></textarea>
        <button type="submit">Connect</button>
      </form>
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
