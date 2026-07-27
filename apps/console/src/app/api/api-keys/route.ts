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
import { grantParamChanges } from "../../_ui/api-keys/grant-params";
import { withConsoleAuth } from "../_auth";
import { classifyAndLogConsoleActionError, consoleActionErrorResponse } from "../_errors";
import { readRequiredText, readText, readTextValues } from "../_form";
import { redirectToConsolePath } from "../_redirect";
import { renderOneTimeApiKeyResponse } from "./_created-page";

/** The limit draft the New API Key dialog carries, apart from the name. */
const CREATE_DRAFT_FIELDS = [
  "budgetPeriod",
  "budgetUsd",
  "concurrency",
  "enforcementPolicy",
  "rpm",
  "tokenLimit",
  "tpm",
] as const;

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
      // Whatever went wrong, including something unexpected: a browser that
      // posted a form gets its dialog back with the message. An error body
      // rendered over the console is a dead end — nothing to fix, nothing to
      // resubmit, and the draft gone.
      const verdict = classifyAndLogConsoleActionError(error, "The key could not be created.");
      const back = new URL("/api-keys", request.url);
      back.searchParams.set("dialog", "new");
      back.searchParams.set(
        "formError",
        verdict.errorId ? `${verdict.message} (error ${verdict.errorId})` : verdict.message,
      );
      // Both parameters, always: the dialog reads a missing one as "the URL
      // has not said", and comes back holding grants the operator dropped.
      const restored = grantParamChanges(
        readTextValues(form, "allowedVirtualModelIds"),
        readText(form, "defaultVirtualModelId") ?? "",
      );
      back.searchParams.set("grantIds", restored.grantIds);
      back.searchParams.set("defaultGrant", restored.defaultGrant);
      const name = readText(form, "name");
      if (name) {
        back.searchParams.set("keyName", name);
      }
      // The rest of what was typed. A refused save is usually one field wrong,
      // and retyping the other six is the console losing work it was handed.
      //
      // The marker is what makes an empty field readable. A cleared ceiling has
      // no value to put in the query string, and a parameter that is absent
      // cannot be told from one that was never sent — so the marker says the
      // whole draft is here, and a field missing from it was cleared on
      // purpose. Without it, removing every ceiling and then mistyping the name
      // brought all five back from the suggested defaults, silently.
      back.searchParams.set("draft", "1");
      for (const field of CREATE_DRAFT_FIELDS) {
        const value = readText(form, field);
        if (value) {
          back.searchParams.set(`draft_${field}`, value);
        }
      }
      back.searchParams.set("draft_enableLimits", readText(form, "enableLimits") ?? "false");
      return redirectToConsolePath(back);
    }
    return consoleActionErrorResponse(error, "API key action failed.");
  }

  return redirectToConsolePath("/api-keys");
});

function readApiKeyLimitRules(form: FormData) {
  return normalizeApiKeyLimitRulesInput({
    enforcementPolicy: readText(form, "enforcementPolicy"),
    budgetPeriod: readText(form, "budgetPeriod"),
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
