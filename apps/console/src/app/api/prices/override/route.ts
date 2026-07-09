import { saveManualPriceOverride } from "@llmingress/db/console-price-overrides";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../../_auth";
import { consoleActionErrorResponse } from "../../_errors";
import { readNumber, readText } from "../../_form";
import { redirectToConsolePath } from "../../_redirect";

export const POST = withConsoleAuth(async (request) => {
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
    return consoleActionErrorResponse(error, "Failed to save price override.");
  }

  const redirectUrl = new URL("/providers", request.url);
  if (redirectModel) {
    redirectUrl.searchParams.set("model", redirectModel);
  }
  return redirectToConsolePath(redirectUrl);
});
