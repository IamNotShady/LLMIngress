import { createAdminPassword } from "@llmingress/db/console-auth";
import { type NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const password = await readPassword(request);
  if (!password) {
    return NextResponse.json({ error: "Admin password is required." }, { status: 400 });
  }

  try {
    await createAdminPassword(password);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to create admin." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}

async function readPassword(request: NextRequest): Promise<string | undefined> {
  const form = await request.formData();
  const password = form.get("password");
  return typeof password === "string" ? password : undefined;
}
