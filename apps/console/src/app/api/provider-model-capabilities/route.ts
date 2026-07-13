import { consoleValidationError } from "@llmingress/db/console-operation-error";
import { updateProviderModelManualCapabilities } from "@llmingress/db/console-provider-model-capabilities";
import { normalizeModelInputModalities, normalizeModelOutputModalities } from "@llmingress/domain";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readNumber, readRequiredText, readText } from "../_form";

export const POST = withConsoleAuth(async (request) => {
  try {
    const form = await request.formData();
    const providerModelId = readRequiredText(form, "providerModelId");
    const action = readText(form, "action") ?? "save";

    if (action === "clear") {
      await updateProviderModelManualCapabilities({
        capabilities: null,
        providerModelId,
      });
      return NextResponse.json({ ok: true });
    }

    const inputModalities = normalizeModelInputModalities(
      readRequiredText(form, "inputModalities").split(","),
    );
    const outputModalities = normalizeModelOutputModalities(
      readRequiredText(form, "outputModalities").split(","),
    );
    const maxContextTokens = readRequiredNumber(form, "maxContextTokens");
    const maxOutputTokens = readRequiredNumber(form, "maxOutputTokens");

    if (!inputModalities || !outputModalities) {
      throw consoleValidationError(
        "Model modalities must contain supported values.",
        "provider_model_capability_modalities_invalid",
      );
    }

    await updateProviderModelManualCapabilities({
      capabilities: {
        inputModalities,
        maxContextTokens,
        maxOutputTokens,
        outputModalities,
        supportsFunctionCalling: readRequiredBoolean(form, "supportsFunctionCalling"),
        supportsReasoning: readRequiredBoolean(form, "supportsReasoning"),
      },
      providerModelId,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return consoleActionErrorResponse(error, "Provider model capability update failed.");
  }
});

function readRequiredNumber(form: FormData, name: string): number {
  const value = readNumber(form, name);
  if (value === undefined) {
    throw consoleValidationError(`${name} is required.`, "form_field_required", { field: name });
  }
  return value;
}

function readRequiredBoolean(form: FormData, name: string): boolean {
  const value = readRequiredText(form, name);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw consoleValidationError(`${name} must be true or false.`, "form_field_required", {
    field: name,
  });
}
