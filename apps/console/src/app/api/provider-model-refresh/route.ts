import { enqueueProviderModelRefreshJob } from "@llmingress/db/provider-jobs";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText } from "../_form";

export const POST = withConsoleAuth(async (request) => {
  try {
    const form = await request.formData();
    const input = { providerId: readRequiredText(form, "providerId") };
    await enqueueProviderModelRefreshJob({ providerId: input.providerId });
    // Same landing for both callers — see the connection probe route.
    const landing = `/providers?modelRefreshProviderId=${encodeURIComponent(input.providerId)}&selected=${encodeURIComponent(input.providerId)}&toast=${encodeURIComponent("Model refresh queued")}&toastMeta=${encodeURIComponent("The worker re-reads this provider's model list; the table updates when it finishes.")}`;
    if (request.headers.get("accept")?.includes("application/json")) {
      return NextResponse.json({ ok: true, providerId: input.providerId, redirectTo: landing });
    }
    return NextResponse.redirect(new URL(landing, request.url), { status: 303 });
  } catch (error) {
    return consoleActionErrorResponse(error, "Provider model refresh failed.");
  }
});
