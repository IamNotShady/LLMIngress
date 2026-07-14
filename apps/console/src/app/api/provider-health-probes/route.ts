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
    if (request.headers.get("accept")?.includes("application/json")) {
      return NextResponse.json({ jobId: result.jobId, ok: true, reused: result.reused });
    }
    return NextResponse.redirect(
      new URL(`/providers?selected=${encodeURIComponent(providerId)}`, request.url),
      303,
    );
  } catch (error) {
    return consoleActionErrorResponse(error, "Provider connection probe failed.");
  }
});
