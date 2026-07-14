import { normalizeAgentLimitRulesInput } from "@llmingress/db/console-agent-limits";
import {
  createAgentWithSettings,
  deleteAgent,
  normalizeAgentFormInput,
  normalizeAgentVirtualModelAccessFormInput,
  normalizeAgentVirtualModelSelectionInput,
  setAgentEnabled,
  updateAgent,
  updateAgentVirtualModelAccess,
  updateAgentWithSettings,
} from "@llmingress/db/console-agents";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText, readText, readTextValues } from "../_form";
import { redirectToConsolePath } from "../_redirect";
import { renderOneTimeAgentResponse } from "./_created-page";

export const POST = withConsoleAuth(async (request) => {
  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "create") {
      const limitsEnabled = readText(form, "enableLimits") === "true";
      const agent = normalizeAgentFormInput({
        integrationPlatform: readText(form, "integrationPlatform"),
        name: readText(form, "name"),
      });
      const result = await createAgentWithSettings({
        agent,
        limitRules: limitsEnabled ? readAgentLimitRules(form) : [],
        limitsEnabled,
        virtualModels: normalizeAgentVirtualModelSelectionInput({
          allowedVirtualModelIds: readTextValues(form, "allowedVirtualModelIds"),
          defaultVirtualModelId: readText(form, "defaultVirtualModelId") ?? null,
        }),
      });
      return renderOneTimeAgentResponse(
        {
          ...result,
          integrationPlatform: agent.integrationPlatform,
          virtualModelName: readAgentConnectionVirtualModelName(result.virtualModelAccess),
        },
        request.headers.get("accept")?.includes("application/json") ? "json" : "html",
      );
    } else if (action === "update") {
      await updateAgent({
        agent: normalizeAgentFormInput({
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
        }),
        id: readRequiredText(form, "id"),
      });
    } else if (action === "saveAll") {
      const id = readRequiredText(form, "id");
      const limitsEnabled = readText(form, "enableLimits") === "true";
      await updateAgentWithSettings({
        agent: normalizeAgentFormInput({
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
        }),
        id,
        limitRules: limitsEnabled ? readAgentLimitRules(form) : [],
        limitsEnabled,
        virtualModels: normalizeAgentVirtualModelSelectionInput({
          allowedVirtualModelIds: readTextValues(form, "allowedVirtualModelIds"),
          defaultVirtualModelId: readText(form, "defaultVirtualModelId") ?? null,
        }),
      });
      return redirectToConsolePath(`/agents?selected=${encodeURIComponent(id)}`);
    } else if (action === "enable" || action === "disable") {
      await setAgentEnabled({
        enabled: action === "enable",
        id: readRequiredText(form, "id"),
      });
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
      return NextResponse.json(
        { error: "Unknown agent action.", code: "agent_action_unknown" },
        { status: 400 },
      );
    }
  } catch (error) {
    return consoleActionErrorResponse(error, "Agent action failed.");
  }

  return redirectToConsolePath("/agents");
});

function readAgentLimitRules(form: FormData) {
  return normalizeAgentLimitRulesInput({
    budgetPeriod: readRequiredText(form, "budgetPeriod"),
    budgetUsd: readRequiredText(form, "budgetUsd"),
    concurrency: readText(form, "concurrency") ?? null,
    rpm: readRequiredText(form, "rpm"),
    tokenLimit: readRequiredText(form, "tokenLimit"),
    tpm: readRequiredText(form, "tpm"),
  });
}

function readAgentConnectionVirtualModelName(access: {
  allowedVirtualModels: Array<{ name: string }>;
  defaultVirtualModel: { name: string } | null;
}): string | null {
  return access.defaultVirtualModel?.name ?? access.allowedVirtualModels[0]?.name ?? null;
}
