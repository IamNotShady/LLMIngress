import { type NextRequest, NextResponse } from "next/server";
import { normalizeAgentLimitFormInput, saveAgentLimitRules } from "../../../server/agent-limits";
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
    if (action !== "saveLimitRules") {
      return NextResponse.json({ error: "Unknown Agent limit action." }, { status: 400 });
    }

    await saveAgentLimitRules({
      databaseUrl,
      limits: normalizeAgentLimitFormInput({
        agentApiKeyId: readRequiredText(form, "agentApiKeyId"),
        budgetPeriod: readRequiredText(form, "budgetPeriod"),
        budgetPriceModelId: readRequiredText(form, "budgetPriceModelId"),
        budgetPriceProviderKey: readRequiredText(form, "budgetPriceProviderKey"),
        budgetUsd: readRequiredText(form, "budgetUsd"),
        rpm: readRequiredText(form, "rpm"),
        tokenLimit: readRequiredText(form, "tokenLimit"),
        tpm: readRequiredText(form, "tpm"),
      }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent limit action failed." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}

function readRequiredText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}
