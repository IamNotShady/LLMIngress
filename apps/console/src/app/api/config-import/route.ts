import { type NextRequest, NextResponse } from "next/server";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../server/auth";
import { importConsoleConfig } from "../../../server/import-export";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const configJson = readRequiredText(form, "configJson");
    const result = await importConsoleConfig({
      databaseUrl,
      document: JSON.parse(configJson),
    });
    const redirectUrl = new URL("/", request.url);
    redirectUrl.searchParams.set("configImportVersion", String(result.version));
    redirectUrl.hash = "settings";
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
