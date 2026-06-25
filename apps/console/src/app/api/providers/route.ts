import { enqueueProviderConnectivityCheckJob } from "@llmingress/db/provider-jobs";
import { type NextRequest, NextResponse } from "next/server";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../server/auth";
import { normalizeProviderTemplateFormInput } from "../../../server/provider-templates";
import {
  createProvider,
  createProviderFromTemplate,
  deleteProvider,
  normalizeProviderFormInput,
  setProviderEnabled,
  updateProvider,
} from "../../../server/providers";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "create") {
      const provider = await createProvider({
        databaseUrl,
        provider: normalizeProviderFormInput({
          baseUrl: readText(form, "baseUrl"),
          displayName: readText(form, "displayName"),
          providerKey: readText(form, "providerKey"),
          providerType: readText(form, "providerType"),
        }),
      });
      await enqueueProviderConnectivityCheckJob({ databaseUrl, providerId: provider.id });
    } else if (action === "createFromTemplate") {
      const provider = await createProviderFromTemplate({
        databaseUrl,
        template: normalizeProviderTemplateFormInput({
          baseUrl: readText(form, "baseUrl"),
          templateId: readText(form, "templateId"),
        }),
      });
      await enqueueProviderConnectivityCheckJob({ databaseUrl, providerId: provider.id });
    } else if (action === "update") {
      const provider = await updateProvider({
        baseUrl: readText(form, "baseUrl"),
        databaseUrl,
        displayName: readRequiredText(form, "displayName"),
        id: readRequiredText(form, "id"),
      });
      await enqueueProviderConnectivityCheckJob({ databaseUrl, providerId: provider.id });
    } else if (action === "enable" || action === "disable") {
      const providerId = readRequiredText(form, "id");
      await setProviderEnabled({
        databaseUrl,
        enabled: action === "enable",
        id: providerId,
      });
      if (action === "enable") {
        await enqueueProviderConnectivityCheckJob({
          databaseUrl,
          providerId,
        });
      }
    } else if (action === "delete") {
      await deleteProvider({
        databaseUrl,
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json({ error: "Unknown provider action." }, { status: 400 });
    }
  } catch (error) {
    const message = normalizeProviderActionError(
      error instanceof Error ? error.message : "Provider action failed.",
    );
    if (action === "create" || action === "createFromTemplate") {
      const redirectUrl = new URL("/providers", request.url);
      redirectUrl.searchParams.set("providerDialog", "new");
      redirectUrl.searchParams.set("providerError", message);
      redirectUrl.searchParams.set("providerErrorField", "providerKey");
      setSearchParam(redirectUrl, "providerKeyValue", readText(form, "providerKey"));
      setSearchParam(redirectUrl, "providerDisplayNameValue", readText(form, "displayName"));
      setSearchParam(redirectUrl, "providerBaseUrlValue", readText(form, "baseUrl"));
      return NextResponse.redirect(redirectUrl, { status: 303 });
    }
    if (action === "update") {
      const redirectUrl = new URL("/providers", request.url);
      setSearchParam(redirectUrl, "providerDialog", readText(form, "id"));
      redirectUrl.searchParams.set("providerError", message);
      redirectUrl.searchParams.set("providerErrorField", "form");
      setSearchParam(redirectUrl, "providerDisplayNameValue", readText(form, "displayName"));
      setSearchParam(redirectUrl, "providerBaseUrlValue", readText(form, "baseUrl"));
      return NextResponse.redirect(redirectUrl, { status: 303 });
    }
    return NextResponse.redirect(new URL("/providers", request.url), { status: 303 });
  }

  return NextResponse.redirect(new URL("/providers", request.url), { status: 303 });
}

function readText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequiredText(form: FormData, name: string): string {
  const value = readText(form, name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function setSearchParam(url: URL, name: string, value: string | undefined): void {
  if (value) {
    url.searchParams.set(name, value);
  }
}

function normalizeProviderActionError(message: string): string {
  if (message.includes("providers_provider_key_key")) {
    return "Provider type already exists.";
  }
  return message;
}
