import { normalizeApiKeyLimitRulesInput } from "@llmingress/db/console-api-key-limits";
import {
  createApiKeyWithSettings,
  deleteApiKey,
  normalizeApiKeyFormInput,
  normalizeApiKeyVirtualModelAccessFormInput,
  normalizeApiKeyVirtualModelSelectionInput,
  setApiKeyEnabled,
  updateApiKey,
  updateApiKeyVirtualModelAccess,
  updateApiKeyWithSettings,
} from "@llmingress/db/console-api-keys";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText, readText, readTextValues } from "../_form";
import { redirectToConsolePath } from "../_redirect";
import { renderOneTimeApiKeyResponse } from "./_created-page";

export const POST = withConsoleAuth(async (request) => {
  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "create") {
      const limitsEnabled = readText(form, "enableLimits") === "true";
      const apiKey = normalizeApiKeyFormInput({
        name: readText(form, "name"),
      });
      const result = await createApiKeyWithSettings({
        apiKey,
        limitRules: limitsEnabled ? readApiKeyLimitRules(form) : [],
        limitsEnabled,
        virtualModels: normalizeApiKeyVirtualModelSelectionInput({
          allowedVirtualModelIds: readTextValues(form, "allowedVirtualModelIds"),
          defaultVirtualModelId: readText(form, "defaultVirtualModelId") ?? null,
        }),
      });
      return renderOneTimeApiKeyResponse(
        {
          ...result,
          virtualModelName: readApiKeyConnectionVirtualModelName(result.virtualModelAccess),
        },
        request.headers.get("accept")?.includes("application/json") ? "json" : "html",
      );
    } else if (action === "update") {
      await updateApiKey({
        apiKey: normalizeApiKeyFormInput({
          name: readText(form, "name"),
        }),
        id: readRequiredText(form, "id"),
      });
    } else if (action === "saveAll") {
      const id = readRequiredText(form, "id");
      const limitsEnabled = readText(form, "enableLimits") === "true";
      await updateApiKeyWithSettings({
        apiKey: normalizeApiKeyFormInput({
          name: readText(form, "name"),
        }),
        id,
        limitRules: limitsEnabled ? readApiKeyLimitRules(form) : [],
        limitsEnabled,
        virtualModels: normalizeApiKeyVirtualModelSelectionInput({
          allowedVirtualModelIds: readTextValues(form, "allowedVirtualModelIds"),
          defaultVirtualModelId: readText(form, "defaultVirtualModelId") ?? null,
        }),
      });
      return redirectToConsolePath(`/api-keys?selected=${encodeURIComponent(id)}`);
    } else if (action === "enable" || action === "disable") {
      await setApiKeyEnabled({
        enabled: action === "enable",
        id: readRequiredText(form, "id"),
      });
    } else if (action === "delete") {
      await deleteApiKey({
        id: readRequiredText(form, "id"),
      });
    } else if (action === "updateVirtualModelAccess") {
      await updateApiKeyVirtualModelAccess({
        access: normalizeApiKeyVirtualModelAccessFormInput({
          allowedVirtualModelIds: readTextValues(form, "allowedVirtualModelIds"),
          defaultVirtualModelId: readText(form, "defaultVirtualModelId") ?? null,
          id: readRequiredText(form, "id"),
        }),
      });
    } else {
      return NextResponse.json(
        { error: "Unknown API key action.", code: "api_key_action_unknown" },
        { status: 400 },
      );
    }
  } catch (error) {
    return consoleActionErrorResponse(error, "API key action failed.");
  }

  return redirectToConsolePath("/api-keys");
});

function readApiKeyLimitRules(form: FormData) {
  return normalizeApiKeyLimitRulesInput({
    budgetPeriod: readRequiredText(form, "budgetPeriod"),
    budgetUsd: readRequiredText(form, "budgetUsd"),
    concurrency: readText(form, "concurrency") ?? null,
    rpm: readRequiredText(form, "rpm"),
    tokenLimit: readRequiredText(form, "tokenLimit"),
    tpm: readRequiredText(form, "tpm"),
  });
}

function readApiKeyConnectionVirtualModelName(access: {
  allowedVirtualModels: Array<{ name: string }>;
  defaultVirtualModel: { name: string } | null;
}): string | null {
  return access.defaultVirtualModel?.name ?? access.allowedVirtualModels[0]?.name ?? null;
}
