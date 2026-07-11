import {
  deleteAgentLimitRules,
  normalizeAgentLimitFormInput,
  saveAgentLimitRules,
} from "@llmingress/db/console-agent-limits";
import {
  createAgent,
  deleteAgent,
  normalizeAgentFormInput,
  normalizeAgentVirtualModelAccessFormInput,
  updateAgent,
  updateAgentVirtualModelAccess,
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
      const result = await createAgent({
        agent: normalizeAgentFormInput({
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
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
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
        }),
        id: readRequiredText(form, "id"),
      });
    } else if (action === "saveAll") {
      const id = readRequiredText(form, "id");
      await updateAgent({
        agent: normalizeAgentFormInput({
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
        }),
        id,
      });
      await saveAgentRelatedSettings({
        clearLimitsWhenDisabled: true,
        form,
        id,
        saveLimits: readText(form, "enableLimits") === "true",
      });
      return redirectToConsolePath(`/agents?selected=${encodeURIComponent(id)}`);
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
      budgetPeriod: readRequiredText(input.form, "budgetPeriod"),
      budgetUsd: readRequiredText(input.form, "budgetUsd"),
      concurrency: readText(input.form, "concurrency") ?? null,
      rpm: readRequiredText(input.form, "rpm"),
      tokenLimit: readRequiredText(input.form, "tokenLimit"),
      tpm: readRequiredText(input.form, "tpm"),
    }),
  });
}
