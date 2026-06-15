import { type NextRequest, NextResponse } from "next/server";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../server/auth";
import {
  enqueueProviderModelRefreshJob,
  normalizeProviderModelRefreshInput,
} from "../../../server/model-refresh-jobs";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const input = normalizeProviderModelRefreshInput({
      providerId: readText(form, "providerId"),
    });
    await enqueueProviderModelRefreshJob({ databaseUrl, providerId: input.providerId });
    return NextResponse.redirect(
      new URL(`/?modelRefreshProviderId=${encodeURIComponent(input.providerId)}`, request.url),
      { status: 303 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Provider model refresh failed." },
      { status: 400 },
    );
  }
}

function readText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
