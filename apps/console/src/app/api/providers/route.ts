import { normalizeProviderTemplateFormInput } from "@llmingress/db/console-provider-templates";
import {
  createProvider,
  createProviderFromTemplate,
  deleteProvider,
  normalizeProviderFormInput,
  setProviderEnabled,
  updateProvider,
} from "@llmingress/db/console-providers";
import {
  enqueueProviderConnectionProbeJob,
  enqueueProviderConnectionProbesForProvider,
} from "@llmingress/db/provider-jobs";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText, readText } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export const POST = withConsoleAuth(async (request) => {
  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "create") {
      const provider = await createProvider({
        provider: normalizeProviderFormInput({
          baseUrl: readText(form, "baseUrl"),
          displayName: readText(form, "displayName"),
          providerKey: readText(form, "providerKey"),
          providerType: readText(form, "providerType"),
        }),
      });
      if (provider.providerType === "local") {
        await enqueueProviderConnectionProbeJob({
          providerConnectionId: provider.id,
          providerId: provider.id,
          source: "provider_created",
        });
      }
    } else if (action === "createFromTemplate") {
      const provider = await createProviderFromTemplate({
        template: normalizeProviderTemplateFormInput({
          baseUrl: readText(form, "baseUrl"),
          displayName: readText(form, "displayName"),
          templateId: readText(form, "templateId"),
        }),
      });
      if (provider.providerType === "local") {
        await enqueueProviderConnectionProbeJob({
          providerConnectionId: provider.id,
          providerId: provider.id,
          source: "provider_created",
        });
      }
    } else if (action === "update") {
      const result = await updateProvider({
        baseUrl: readText(form, "baseUrl"),
        displayName: readRequiredText(form, "displayName"),
        id: readRequiredText(form, "id"),
      });
      if (result.baseUrlChanged) {
        await enqueueProviderConnectionProbesForProvider({
          providerId: result.provider.id,
          resetHealth: true,
          source: "base_url_changed",
        });
      }
    } else if (action === "enable" || action === "disable") {
      const providerId = readRequiredText(form, "id");
      await setProviderEnabled({
        enabled: action === "enable",
        id: providerId,
      });
      if (action === "enable") {
        await enqueueProviderConnectionProbesForProvider({
          providerId,
          resetHealth: true,
          source: "provider_enabled",
        });
      }
    } else if (action === "delete") {
      await deleteProvider({
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json(
        { error: "Unknown provider action.", code: "provider_action_unknown" },
        { status: 400 },
      );
    }
  } catch (error) {
    // Every console form posts through MutationForm, which renders the refusal
    // where the operator was working — so a refusal is an error response, not a
    // redirect carrying an error the page would have to re-render itself.
    return consoleActionErrorResponse(error, "Provider action failed.");
  }

  return redirectToConsolePath("/providers");
});
