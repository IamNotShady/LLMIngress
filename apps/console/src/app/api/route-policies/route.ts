import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import {
  createRoutePolicy,
  deleteRoutePolicy,
  normalizeRoutePolicyFormInput,
  updateRoutePolicy,
} from "@llmingress/db/console-route-policies";
import { type NextRequest, NextResponse } from "next/server";
import { readRequiredText, readText, readTextValues } from "../_form";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "create") {
      await createRoutePolicy({
        routePolicy: normalizeRoutePolicyFormInput({
          providerModelIds: readTextValues(form, "providerModelIds"),
          strategy: readText(form, "strategy"),
          virtualModelId: readText(form, "virtualModelId"),
        }),
      });
    } else if (action === "update") {
      await updateRoutePolicy({
        id: readRequiredText(form, "id"),
        routePolicy: normalizeRoutePolicyFormInput({
          providerModelIds: readTextValues(form, "providerModelIds"),
          strategy: readText(form, "strategy"),
          virtualModelId: readText(form, "virtualModelId"),
        }),
      });
    } else if (action === "delete") {
      await deleteRoutePolicy({
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json({ error: "Unknown route policy action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Route Policy action failed." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/routing", request.url), { status: 303 });
}
