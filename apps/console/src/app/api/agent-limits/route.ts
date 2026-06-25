import { type NextRequest, NextResponse } from "next/server";
import {
  deleteAgentLimitRules,
  normalizeAgentLimitFormInput,
  saveAgentLimitRules,
} from "../../../server/agent-limits";
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
    if (action === "deleteLimitRules") {
      await deleteAgentLimitRules({
        agentId: readRequiredText(form, "agentId", "agentApiKeyId"),
        databaseUrl,
      });
      return NextResponse.redirect(new URL("/limits", request.url), { status: 303 });
    }
    if (action !== "saveLimitRules") {
      return NextResponse.json({ error: "Unknown Agent limit action." }, { status: 400 });
    }

    const agentId = readRequiredText(form, "agentId", "agentApiKeyId");
    await saveAgentLimitRules({
      databaseUrl,
      limits: normalizeAgentLimitFormInput({
        agentId,
        alertThresholdPercent: readOptionalText(form, "alertThresholdPercent"),
        budgetPeriod: readRequiredText(form, "budgetPeriod"),
        budgetUsd: readRequiredText(form, "budgetUsd"),
        concurrency: readOptionalText(form, "concurrency"),
        rpm: readRequiredText(form, "rpm"),
        tokenLimit: readRequiredText(form, "tokenLimit"),
        tpm: readRequiredText(form, "tpm"),
      }),
    });
    return NextResponse.redirect(
      new URL(`/limits?selected=${encodeURIComponent(agentId)}`, request.url),
      { status: 303 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent limit action failed." },
      { status: 400 },
    );
  }
}

function readRequiredText(form: FormData, name: string, fallbackName?: string): string {
  const value = form.get(name) ?? (fallbackName ? form.get(fallbackName) : null);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function readOptionalText(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
