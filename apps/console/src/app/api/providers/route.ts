import { normalizeProviderTemplateFormInput } from "@llmingress/db/console-provider-templates";
import {
  createProvider,
  createProviderFromTemplate,
  deleteProvider,
  normalizeProviderFormInput,
  setProviderEnabled,
  updateProvider,
} from "@llmingress/db/console-providers";
import { enqueueProviderConnectivityCheckJob } from "@llmingress/db/provider-jobs";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { classifyConsoleActionError } from "../_error-classify";
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
      await enqueueProviderConnectivityCheckJob({ providerId: provider.id });
    } else if (action === "createFromTemplate") {
      const provider = await createProviderFromTemplate({
        template: normalizeProviderTemplateFormInput({
          baseUrl: readText(form, "baseUrl"),
          templateId: readText(form, "templateId"),
        }),
      });
      await enqueueProviderConnectivityCheckJob({ providerId: provider.id });
    } else if (action === "update") {
      const provider = await updateProvider({
        baseUrl: readText(form, "baseUrl"),
        displayName: readRequiredText(form, "displayName"),
        id: readRequiredText(form, "id"),
      });
      await enqueueProviderConnectivityCheckJob({ providerId: provider.id });
    } else if (action === "enable" || action === "disable") {
      const providerId = readRequiredText(form, "id");
      await setProviderEnabled({
        enabled: action === "enable",
        id: providerId,
      });
      if (action === "enable") {
        await enqueueProviderConnectivityCheckJob({
          providerId,
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
    if (request.headers.get("accept")?.includes("application/json")) {
      return consoleActionErrorResponse(error, "Provider action failed.");
    }
    const verdict = classifyConsoleActionError(error, "Provider action failed.");
    if (verdict.status === 500) {
      return consoleActionErrorResponse(error, "Provider action failed.");
    }
    if (action === "disable" || action === "delete") {
      return consoleActionErrorResponse(error, "Provider action failed.");
    }
    if (action === "create" || action === "createFromTemplate") {
      const redirectUrl = new URL("/providers", request.url);
      redirectUrl.searchParams.set("providerDialog", "new");
      redirectUrl.searchParams.set("providerError", verdict.message);
      redirectUrl.searchParams.set("providerErrorCode", verdict.code);
      redirectUrl.searchParams.set("providerErrorField", "providerKey");
      setSearchParam(redirectUrl, "providerKeyValue", readText(form, "providerKey"));
      setSearchParam(redirectUrl, "providerDisplayNameValue", readText(form, "displayName"));
      setSearchParam(redirectUrl, "providerBaseUrlValue", readText(form, "baseUrl"));
      return redirectToConsolePath(redirectUrl);
    }
    if (action === "update") {
      const redirectUrl = new URL("/providers", request.url);
      setSearchParam(redirectUrl, "providerDialog", readText(form, "id"));
      redirectUrl.searchParams.set("providerError", verdict.message);
      redirectUrl.searchParams.set("providerErrorCode", verdict.code);
      redirectUrl.searchParams.set("providerErrorField", "form");
      setSearchParam(redirectUrl, "providerDisplayNameValue", readText(form, "displayName"));
      setSearchParam(redirectUrl, "providerBaseUrlValue", readText(form, "baseUrl"));
      return redirectToConsolePath(redirectUrl);
    }
    return redirectToConsolePath("/providers");
  }

  return redirectToConsolePath("/providers");
});

function setSearchParam(url: URL, name: string, value: string | undefined): void {
  if (value) {
    url.searchParams.set(name, value);
  }
}
