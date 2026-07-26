import { enqueueProviderConnectionProbeJob } from "@llmingress/db/provider-jobs";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText } from "../_form";

export const POST = withConsoleAuth(async (request) => {
  try {
    const form = await request.formData();
    const providerId = readRequiredText(form, "providerId");
    const providerConnectionId = readRequiredText(form, "providerConnectionId");
    const result = await enqueueProviderConnectionProbeJob({
      providerConnectionId,
      providerId,
      source: "manual_probe",
      trigger: "manual",
    });
    if (!result.queued) {
      return NextResponse.json(
        {
          code: `provider_connection_${result.reason}`,
          error: "Provider connection is not available for probing.",
        },
        { status: 409 },
      );
    }
    // Both callers land in the same place with the same words: a native post
    // follows the redirect, and a fetch is told where to go so it can navigate
    // in the client rather than reloading the page.
    const landing = `/providers?selected=${encodeURIComponent(providerId)}&toast=${encodeURIComponent("Connection re-check queued")}&toastMeta=${encodeURIComponent("Health updates once the probe returns — nothing about the credential changed.")}`;
    if (request.headers.get("accept")?.includes("application/json")) {
      return NextResponse.json({
        jobId: result.jobId,
        ok: true,
        redirectTo: landing,
        reused: result.reused,
      });
    }
    return NextResponse.redirect(new URL(landing, request.url), 303);
  } catch (error) {
    return consoleActionErrorResponse(error, "Provider connection probe failed.");
  }
});
