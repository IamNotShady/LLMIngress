import {
  createNotificationChannel,
  normalizeNotificationChannelFormInput,
} from "@llmingress/db/console-notification-channels";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readRequiredText, readText } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export const POST = withConsoleAuth(async (request) => {
  const form = await request.formData();
  const action = readRequiredText(form, "action");

  try {
    if (action !== "create") {
      return NextResponse.json({ error: "Unknown notification channel action." }, { status: 400 });
    }

    await createNotificationChannel({
      channel: normalizeNotificationChannelFormInput({
        channelType: readRequiredText(form, "channelType"),
        displayName: readRequiredText(form, "displayName"),
        webhookUrl: readText(form, "webhookUrl"),
      }),
    });
  } catch (error) {
    return consoleActionErrorResponse(error, "Notification channel action failed.");
  }

  return redirectToConsolePath("/settings#notification-channels");
});
