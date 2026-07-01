import { sessionCookieName, verifyConsoleSession } from "@llmingress/db/console-auth";
import { saveManualPriceOverride } from "@llmingress/db/console-price-overrides";
import { type NextRequest, NextResponse } from "next/server";
import { readNumber, readText } from "../../_form";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const form = await request.formData();
  const providerKey = readText(form, "providerKey");
  const modelId = readText(form, "modelId");
  const redirectModel = readText(form, "redirectModel");
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

  const redirectUrl = new URL("/pricing", request.url);
  if (redirectModel) {
    redirectUrl.searchParams.set("model", redirectModel);
  }
  return NextResponse.redirect(redirectUrl, { status: 303 });
}
