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
      await createProvider({
        databaseUrl,
        provider: normalizeProviderFormInput({
          baseUrl: readText(form, "baseUrl"),
          displayName: readText(form, "displayName"),
          providerKey: readText(form, "providerKey"),
          providerType: readText(form, "providerType"),
        }),
      });
    } else if (action === "createFromTemplate") {
      await createProviderFromTemplate({
        databaseUrl,
        template: normalizeProviderTemplateFormInput({
          baseUrl: readText(form, "baseUrl"),
          templateId: readText(form, "templateId"),
        }),
      });
    } else if (action === "update") {
      await updateProvider({
        baseUrl: readText(form, "baseUrl"),
        databaseUrl,
        displayName: readRequiredText(form, "displayName"),
        id: readRequiredText(form, "id"),
      });
    } else if (action === "enable" || action === "disable") {
      await setProviderEnabled({
        databaseUrl,
        enabled: action === "enable",
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json({ error: "Unknown provider action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Provider action failed." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
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
