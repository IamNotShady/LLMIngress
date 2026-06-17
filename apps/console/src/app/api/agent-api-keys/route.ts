import { type NextRequest, NextResponse } from "next/server";
import {
  createAgentApiKey,
  deleteAgentApiKey,
  disableAgentApiKey,
  normalizeAgentApiKeyVirtualModelAccessInput,
  rotateAgentApiKey,
  updateAgentApiKeyVirtualModelAccess,
} from "../../../server/agent-api-keys";
import { buildAgentIntegrationTemplates } from "../../../server/agent-integrations";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const action = readRequiredText(form, "action");

    if (action === "create") {
      const result = await createAgentApiKey({
        agentId: readRequiredText(form, "agentId"),
        databaseUrl,
      });
      return renderOneTimeAgentApiKeyResponse(result);
    }

    if (action === "rotate") {
      const result = await rotateAgentApiKey({
        databaseUrl,
        id: readRequiredText(form, "id"),
      });
      return renderOneTimeAgentApiKeyResponse(result);
    }

    if (action === "updateVirtualModelAccess") {
      await updateAgentApiKeyVirtualModelAccess({
        access: normalizeAgentApiKeyVirtualModelAccessInput({
          allowedVirtualModelIds: readTextValues(form, "allowedVirtualModelIds"),
          defaultVirtualModelId: readOptionalText(form, "defaultVirtualModelId"),
          id: readRequiredText(form, "id"),
        }),
        databaseUrl,
      });
    } else if (action === "disable") {
      await disableAgentApiKey({
        databaseUrl,
        id: readRequiredText(form, "id"),
      });
    } else if (action === "delete") {
      await deleteAgentApiKey({
        databaseUrl,
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json({ error: "Unknown Agent API key action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent API key action failed." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/agents", request.url), { status: 303 });
}

function renderOneTimeAgentApiKeyResponse(input: {
  action: "created" | "rotated";
  metadata: { keyPrefix: string };
  plaintext: string;
}): NextResponse {
  const heading = input.action === "created" ? "Agent API key created" : "Agent API key rotated";
  const integrationTemplates = buildAgentIntegrationTemplates({
    apiKey: input.plaintext,
    gatewayBaseUrl: getAgentIntegrationGatewayBaseUrl(),
    model: "<Virtual Model Name>",
  });
  const integrationTemplateHtml = integrationTemplates
    .map(
      (template) => `
        <div class="snippet">
          <label for="${escapeHtml(template.id)}-setup-snippet">${escapeHtml(
            template.displayName,
          )} setup snippet</label>
          <textarea id="${escapeHtml(template.id)}-setup-snippet" readonly rows="5">${escapeHtml(
            template.snippet,
          )}</textarea>
        </div>`,
    )
    .join("");

  return new NextResponse(
    `<!doctype html>
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
      .snippets { display: grid; gap: 12px; margin: 0 0 24px; }
      .snippet { display: grid; gap: 6px; }
      label { color: #344054; font-size: 14px; font-weight: 700; }
      textarea { width: 100%; min-height: 116px; border: 1px solid #98a2b3; border-radius: 6px; background: #f9fafb; color: #101828; font: inherit; padding: 10px 12px; resize: vertical; }
      a { display: inline-flex; min-height: 44px; align-items: center; border-radius: 6px; background: #175cd3; color: #fff; font-weight: 700; padding: 10px 14px; text-decoration: none; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(heading)}</h1>
      <dl>
        <div>
          <dt>Agent API key</dt>
          <dd><code>${escapeHtml(input.plaintext)}</code></dd>
        </div>
        <div>
          <dt>Agent API key prefix</dt>
          <dd>${escapeHtml(input.metadata.keyPrefix)}</dd>
        </div>
      </dl>
      <section class="snippets" aria-label="Agent integration templates">
        ${integrationTemplateHtml}
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

function getAgentIntegrationGatewayBaseUrl(): string {
  return process.env.GATEWAY_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000";
}

function readRequiredText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function readOptionalText(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readTextValues(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
