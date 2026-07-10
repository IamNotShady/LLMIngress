import {
  deleteAgentLimitRules,
  normalizeAgentLimitFormInput,
  saveAgentLimitRules,
} from "@llmingress/db/console-agent-limits";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText, readText } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export const POST = withConsoleAuth(async (request) => {
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
      return NextResponse.json(
        { error: "Unknown Agent limit action.", code: "agent_limit_action_unknown" },
        { status: 400 },
      );
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
    return consoleActionErrorResponse(error, "Agent limit action failed.");
  }
});
