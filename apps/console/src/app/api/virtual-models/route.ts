import { type NextRequest, NextResponse } from "next/server";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../server/auth";
import {
  createVirtualModel,
  deleteVirtualModel,
  normalizeVirtualModelFormInput,
  updateVirtualModel,
} from "../../../server/virtual-models";

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
      await createVirtualModel({
        databaseUrl,
        virtualModel: normalizeVirtualModelFormInput({
          displayName: readText(form, "displayName"),
          name: readText(form, "name"),
        }),
      });
    } else if (action === "update") {
      await updateVirtualModel({
        databaseUrl,
        id: readRequiredText(form, "id"),
        virtualModel: normalizeVirtualModelFormInput({
          displayName: readText(form, "displayName"),
          name: readText(form, "name"),
        }),
      });
    } else if (action === "delete") {
      await deleteVirtualModel({
        databaseUrl,
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json({ error: "Unknown virtual model action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Virtual Model action failed." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}

function readText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRequiredText(form: FormData, name: string): string {
  const value = readText(form, name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}
