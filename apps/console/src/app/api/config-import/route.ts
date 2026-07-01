import { type NextRequest, NextResponse } from "next/server";
import { sessionCookieName, verifyConsoleSession } from "../../../server/auth";
import { importConsoleConfig } from "../../../server/import-export";

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
    return NextResponse.redirect(redirectUrl, { status: 303 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Config import failed." },
      { status: 400 },
    );
  }
}

function readRequiredText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}
