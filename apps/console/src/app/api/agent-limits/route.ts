import {
  deleteAgentLimitRules,
  normalizeAgentLimitFormInput,
  saveAgentLimitRules,
} from "@llmingress/db/console-agent-limits";
import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import { type NextRequest, NextResponse } from "next/server";
import { readRequiredText, readText } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const action = readRequiredText(form, "action");
    if (action === "deleteLimitRules") {
      await deleteAgentLimitRules({
        agentId: readRequiredText(form, "agentId", "agentApiKeyId"),
      });
      return redirectToConsolePath("/limits");
    }
    if (action !== "saveLimitRules") {
      return NextResponse.json({ error: "Unknown Agent limit action." }, { status: 400 });
    }

    const agentId = readRequiredText(form, "agentId", "agentApiKeyId");
    await saveAgentLimitRules({
      limits: normalizeAgentLimitFormInput({
        agentId,
        alertThresholdPercent: readText(form, "alertThresholdPercent"),
        budgetPeriod: readRequiredText(form, "budgetPeriod"),
        budgetUsd: readRequiredText(form, "budgetUsd"),
        concurrency: readText(form, "concurrency"),
        rpm: readRequiredText(form, "rpm"),
        tokenLimit: readRequiredText(form, "tokenLimit"),
        tpm: readRequiredText(form, "tpm"),
      }),
    });
    return redirectToConsolePath(`/limits?selected=${encodeURIComponent(agentId)}`);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent limit action failed." },
      { status: 400 },
    );
  }
}
