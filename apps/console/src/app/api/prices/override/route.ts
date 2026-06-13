import { type NextRequest, NextResponse } from "next/server";
import {
  getConsoleDatabaseUrl,
  sessionCookieName,
  verifyConsoleSession,
} from "../../../../server/auth";
import { saveManualPriceOverride } from "../../../../server/price-overrides";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const databaseUrl = getConsoleDatabaseUrl();
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(databaseUrl, sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const form = await request.formData();
  const providerKey = readText(form, "providerKey");
  const modelId = readText(form, "modelId");
  const inputPrice = readNumber(form, "inputUsdPerMillionTokens");
  const outputPrice = readNumber(form, "outputUsdPerMillionTokens");

  if (!providerKey || !modelId || inputPrice === undefined || outputPrice === undefined) {
    return NextResponse.json(
      { error: "Provider, model, input price, and output price are required." },
      { status: 400 },
    );
  }

  try {
    await saveManualPriceOverride({
      databaseUrl,
      inputUsdPerMillionTokens: inputPrice,
      modelId,
      outputUsdPerMillionTokens: outputPrice,
      providerKey,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to save price override." },
      { status: 400 },
    );
  }

  return NextResponse.redirect(new URL("/", request.url), { status: 303 });
}

function readText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(form: FormData, name: string): number | undefined {
  const value = readText(form, name);
  if (!value) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
