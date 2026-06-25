import { type NextRequest, NextResponse } from "next/server";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../server/auth";
import {
  createRoutePolicy,
  deleteRoutePolicy,
  normalizeRoutePolicyFormInput,
  updateRoutePolicy,
} from "../../../server/route-policies";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const form = await request.formData();
  const action = readText(form, "action");

  try {
    if (action === "create") {
      await createRoutePolicy({
        databaseUrl,
        routePolicy: normalizeRoutePolicyFormInput({
          providerModelIds: readAllText(form, "providerModelIds"),
          strategy: readText(form, "strategy"),
          virtualModelId: readText(form, "virtualModelId"),
        }),
      });
    } else if (action === "update") {
      await updateRoutePolicy({
        databaseUrl,
        id: readRequiredText(form, "id"),
        routePolicy: normalizeRoutePolicyFormInput({
          providerModelIds: readAllText(form, "providerModelIds"),
          strategy: readText(form, "strategy"),
          virtualModelId: readText(form, "virtualModelId"),
        }),
      });
    } else if (action === "delete") {
      await deleteRoutePolicy({
        databaseUrl,
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

function readText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readAllText(form: FormData, name: string): string[] {
  return form
    .getAll(name)
    .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    .map((value) => value.trim());
}

function readRequiredText(form: FormData, name: string): string {
  const value = readText(form, name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
