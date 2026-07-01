import { type NextRequest, NextResponse } from "next/server";
import { buildAgentConnectionDetails } from "../../../server/agent-integrations";
import {
  deleteAgentLimitRules,
  normalizeAgentLimitFormInput,
  saveAgentLimitRules,
} from "../../../server/agent-limits";
import {
  createAgent,
  deleteAgent,
  normalizeAgentFormInput,
  normalizeAgentVirtualModelAccessFormInput,
  updateAgent,
  updateAgentVirtualModelAccess,
} from "../../../server/agents";
import { sessionCookieName, verifyConsoleSession } from "../../../server/auth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "create") {
      const result = await createAgent({
        agent: normalizeAgentFormInput({
          agentType: readText(form, "agentType"),
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
          requestLoggingEnabled: readText(form, "requestLoggingEnabled"),
        }),
      });
      await saveAgentRelatedSettings({
        clearLimitsWhenDisabled: false,
        form,
        id: result.id,
        saveLimits: readText(form, "enableLimits") === "true",
      });
      return renderOneTimeAgentResponse(result);
    } else if (action === "update") {
      await updateAgent({
        agent: normalizeAgentFormInput({
          agentType: readText(form, "agentType"),
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
          requestLoggingEnabled: readText(form, "requestLoggingEnabled"),
        }),
        id: readRequiredText(form, "id"),
      });
    } else if (action === "saveAll") {
      const id = readRequiredText(form, "id");
      await updateAgent({
        agent: normalizeAgentFormInput({
          agentType: readText(form, "agentType"),
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
          requestLoggingEnabled: readText(form, "requestLoggingEnabled"),
        }),
        id,
      });
      await saveAgentRelatedSettings({
        clearLimitsWhenDisabled: true,
        form,
        id,
        saveLimits: readText(form, "enableLimits") === "true",
      });
      return NextResponse.redirect(
        new URL(`/agents?selected=${encodeURIComponent(id)}`, request.url),
        { status: 303 },
      );
    } else if (action === "delete") {
      await deleteAgent({
        id: readRequiredText(form, "id"),
      });
    } else if (action === "updateVirtualModelAccess") {
      await updateAgentVirtualModelAccess({
        access: normalizeAgentVirtualModelAccessFormInput({
          allowedVirtualModelIds: readTextValues(form, "allowedVirtualModelIds"),
          defaultVirtualModelId: readText(form, "defaultVirtualModelId") ?? null,
          id: readRequiredText(form, "id"),
        }),
      });
    } else {
      return NextResponse.json({ error: "Unknown agent action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent action failed." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/agents", request.url), { status: 303 });
}

async function saveAgentRelatedSettings(input: {
  clearLimitsWhenDisabled: boolean;
  form: FormData;
  id: string;
  saveLimits: boolean;
}): Promise<void> {
  await updateAgentVirtualModelAccess({
    access: normalizeAgentVirtualModelAccessFormInput({
      allowedVirtualModelIds: readTextValues(input.form, "allowedVirtualModelIds"),
      defaultVirtualModelId: readText(input.form, "defaultVirtualModelId") ?? null,
      id: input.id,
    }),
  });
  if (!input.saveLimits) {
    if (input.clearLimitsWhenDisabled) {
      await deleteAgentLimitRules({
        agentId: input.id,
      });
    }
    return;
  }
  await saveAgentLimitRules({
    limits: normalizeAgentLimitFormInput({
      agentId: input.id,
      alertThresholdPercent: readText(input.form, "alertThresholdPercent") ?? null,
      budgetPeriod: readRequiredText(input.form, "budgetPeriod"),
      budgetUsd: readRequiredText(input.form, "budgetUsd"),
      concurrency: readText(input.form, "concurrency") ?? null,
      rpm: readRequiredText(input.form, "rpm"),
      tokenLimit: readRequiredText(input.form, "tokenLimit"),
      tpm: readRequiredText(input.form, "tpm"),
    }),
  });
}

function readText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequiredText(form: FormData, name: string): string {
  const value = readText(form, name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readTextValues(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : []));
}

function renderOneTimeAgentResponse(input: {
  keyPrefix: string | null;
  plaintext: string;
}): NextResponse {
  const connectionDetails = buildAgentConnectionDetails({
    apiKey: input.plaintext,
    gatewayBaseUrl: process.env.GATEWAY_PUBLIC_BASE_URL?.trim() || "http://127.0.0.1:4000",
    model: "<Virtual Model Name>",
  });

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
            <dt>Agent API key prefix</dt>
            <dd>${escapeHtml(input.keyPrefix ?? connectionDetails.apiKey.slice(0, 12))}</dd>
          </div>
          <div>
            <dt>Gateway URL</dt>
            <dd>${escapeHtml(connectionDetails.gatewayBaseUrl)}</dd>
          </div>
          <div>
            <dt>Virtual Model Name</dt>
            <dd>${escapeHtml(connectionDetails.model)}</dd>
          </div>
        </dl>
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
