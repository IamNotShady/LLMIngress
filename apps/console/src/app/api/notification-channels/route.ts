import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import {
  createNotificationChannel,
  normalizeNotificationChannelFormInput,
} from "@llmingress/db/console-notification-channels";
import { type NextRequest, NextResponse } from "next/server";
import { readRequiredText, readText } from "../_form";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Notification channel action failed." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/settings#notification-channels", request.url), {
    status: 303,
  });
}
