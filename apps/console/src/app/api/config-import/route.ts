import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import { importConsoleConfig } from "@llmingress/db/console-import-export";
import { type NextRequest, NextResponse } from "next/server";
import { readRequiredText } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const configJson = readRequiredText(form, "configJson");
    const result = await importConsoleConfig({
      document: JSON.parse(configJson),
    });
    const redirectUrl = new URL("/settings", request.url);
    redirectUrl.searchParams.set("configImportVersion", String(result.version));
    return redirectToConsolePath(redirectUrl);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Config import failed." },
      { status: 400 },
    );
  }
}
