import { type NextRequest, NextResponse } from "next/server";
import {
  createAgent,
  deleteAgent,
  normalizeAgentFormInput,
  updateAgent,
} from "../../../server/agents";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../server/auth";

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
      await createAgent({
        agent: normalizeAgentFormInput({
          agentType: readText(form, "agentType"),
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
          requestLoggingEnabled: readText(form, "requestLoggingEnabled"),
        }),
        databaseUrl,
      });
    } else if (action === "update") {
      await updateAgent({
        agent: normalizeAgentFormInput({
          agentType: readText(form, "agentType"),
          integrationPlatform: readText(form, "integrationPlatform"),
          name: readText(form, "name"),
          requestLoggingEnabled: readText(form, "requestLoggingEnabled"),
        }),
        databaseUrl,
        id: readRequiredText(form, "id"),
      });
    } else if (action === "delete") {
      await deleteAgent({
        databaseUrl,
        id: readRequiredText(form, "id"),
      });
    } else {
      return NextResponse.json({ error: "Unknown agent action." }, { status: 400 });
    }
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Agent action failed." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/agents", request.url), { status: 303 });
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
