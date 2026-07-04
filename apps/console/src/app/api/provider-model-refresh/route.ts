import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import {
  enqueueProviderModelRefreshJob,
  normalizeProviderModelRefreshInput,
} from "@llmingress/db/provider-jobs";
import { type NextRequest, NextResponse } from "next/server";
import { readText } from "../_form";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  try {
    const form = await request.formData();
    const input = normalizeProviderModelRefreshInput({
      providerId: readText(form, "providerId"),
    });
    await enqueueProviderModelRefreshJob({ providerId: input.providerId });
    if (request.headers.get("accept")?.includes("application/json")) {
      return NextResponse.json({ ok: true, providerId: input.providerId });
    }
    return NextResponse.redirect(
      new URL(
        `/providers?modelRefreshProviderId=${encodeURIComponent(input.providerId)}&selected=${encodeURIComponent(input.providerId)}`,
        request.url,
      ),
      { status: 303 },
    );
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Provider model refresh failed." },
      { status: 400 },
    );
  }
}
