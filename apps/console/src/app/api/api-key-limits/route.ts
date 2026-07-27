import {
  deleteApiKeyLimitRules,
  normalizeApiKeyLimitFormInput,
  saveApiKeyLimitRules,
} from "@llmingress/db/console-api-key-limits";
import { setApiKeyLimitsEnabled } from "@llmingress/db/console-api-keys";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText, readText } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export const POST = withConsoleAuth(async (request) => {
  try {
    const form = await request.formData();
    const action = readRequiredText(form, "action");
    if (action === "setLimitsEnabled") {
      const apiKeyId = readRequiredText(form, "apiKeyId");
      await setApiKeyLimitsEnabled({
        enabled: readText(form, "enabled") === "true",
        id: apiKeyId,
      });
      return redirectToConsolePath(`/limits?selected=${encodeURIComponent(apiKeyId)}`);
    }
    if (action === "deleteLimitRules") {
      await deleteApiKeyLimitRules({
        apiKeyId: readRequiredText(form, "apiKeyId"),
      });
      return redirectToConsolePath("/limits");
    }
    if (action !== "saveLimitRules") {
      return NextResponse.json(
        { error: "Unknown API key limit action.", code: "api_key_limit_action_unknown" },
        { status: 400 },
      );
    }

    const apiKeyId = readRequiredText(form, "apiKeyId");
    await saveApiKeyLimitRules({
      limits: normalizeApiKeyLimitFormInput({
        apiKeyId,
        budgetPeriod: readText(form, "budgetPeriod"),
        budgetUsd: readText(form, "budgetUsd"),
        concurrency: readText(form, "concurrency"),
        enforcementPolicy: readText(form, "enforcementPolicy"),
        rpm: readText(form, "rpm"),
        tokenLimit: readText(form, "tokenLimit"),
        tpm: readText(form, "tpm"),
      }),
    });
    return redirectToConsolePath(`/limits?selected=${encodeURIComponent(apiKeyId)}`);
  } catch (error) {
    return consoleActionErrorResponse(error, "API key limit action failed.");
  }
});
