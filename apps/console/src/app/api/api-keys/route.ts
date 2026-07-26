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
import { classifyConsoleActionError } from "../_error-classify";
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
          createdAt: result.createdAt,
          defaultVirtualModelName: result.virtualModelAccess.defaultVirtualModel?.name ?? null,
          enabled: result.enabled,
          keyPrefix: result.keyPrefix,
          limits: result.limits,
          name: result.name,
          plaintext: result.plaintext,
          virtualModelName: readApiKeyConnectionVirtualModelName(result.virtualModelAccess),
          virtualModels: result.virtualModelAccess.allowedVirtualModels,
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
    // Creating is the one action that cannot post through MutationForm — its
    // success response is the one-time secret page — so a browser's refusal
    // comes back to the dialog with the message and the name, instead of
    // replacing the console with an error body. Only a browser: a caller that
    // did not ask for a page gets the refusal as JSON, with its status.
    if (action === "create" && request.headers.get("accept")?.includes("text/html")) {
      const verdict = classifyConsoleActionError(error, "The key could not be created.");
      if (verdict.status !== 500) {
        const back = new URL("/api-keys", request.url);
        back.searchParams.set("dialog", "new");
        back.searchParams.set("formError", verdict.message);
        const grantIds = readTextValues(form, "allowedVirtualModelIds");
        if (grantIds.length > 0) {
          back.searchParams.set("grantIds", grantIds.join(","));
        }
        const defaultGrant = readText(form, "defaultVirtualModelId");
        if (defaultGrant) {
          back.searchParams.set("defaultGrant", defaultGrant);
        }
        const name = readText(form, "name");
        if (name) {
          back.searchParams.set("keyName", name);
        }
        return redirectToConsolePath(back);
      }
    }
    return consoleActionErrorResponse(error, "API key action failed.");
  }

  return redirectToConsolePath("/api-keys");
});

function readApiKeyLimitRules(form: FormData) {
  return normalizeApiKeyLimitRulesInput({
    // A save rewrites every rule, so the policy has to come back with the form
    // or the key silently reverts to block — warn_only is set in Limits and
    // would be lost by renaming a key here.
    enforcementPolicy: readText(form, "enforcementPolicy"),
    // Blank means unlimited, here as in the Limits drawer.
    budgetPeriod: readRequiredText(form, "budgetPeriod"),
    budgetUsd: readText(form, "budgetUsd"),
    concurrency: readText(form, "concurrency") ?? null,
    rpm: readText(form, "rpm"),
    tokenLimit: readText(form, "tokenLimit"),
    tpm: readText(form, "tpm"),
  });
}

function readApiKeyConnectionVirtualModelName(access: {
  allowedVirtualModels: Array<{ name: string }>;
  defaultVirtualModel: { name: string } | null;
}): string | null {
  return access.defaultVirtualModel?.name ?? access.allowedVirtualModels[0]?.name ?? null;
}
