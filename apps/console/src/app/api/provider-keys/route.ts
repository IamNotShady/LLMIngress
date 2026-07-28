import {
  deleteProviderApiKey,
  readConsoleEncryptionKeySource,
  saveProviderApiKey,
  setProviderApiKeyEnabled,
  setProviderApiKeyQuotaProbeEnabled,
  updateProviderApiKeySettings,
} from "@llmingress/db/console-provider-keys";
import {
  enqueueProviderConnectionProbeJob,
  enqueueProviderModelRefreshJob,
} from "@llmingress/db/provider-jobs";
import { NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { consoleActionErrorResponse } from "../_errors";
import { readNumber, readRequiredText, readText } from "../_form";
import { renderOneTimeProviderKeyPage } from "./_created-page";

export const POST = withConsoleAuth(async (request) => {
  try {
    const form = await request.formData();
    const action = readText(form, "action") ?? "save";

    if (action === "delete") {
      const providerApiKeyId = readRequiredText(form, "providerApiKeyId");
      const result = await deleteProviderApiKey({ providerApiKeyId });
      return providerApiKeyMutationResponse(request, result.providerId);
    }

    if (action === "quota-probe-enable" || action === "quota-probe-disable") {
      const result = await setProviderApiKeyQuotaProbeEnabled({
        providerApiKeyId: readRequiredText(form, "providerApiKeyId"),
        quotaProbeEnabled: action === "quota-probe-enable",
      });
      return providerApiKeyMutationResponse(request, result.providerId);
    }

    if (action === "enable" || action === "disable") {
      const result = await setProviderApiKeyEnabled({
        enabled: action === "enable",
        providerApiKeyId: readRequiredText(form, "providerApiKeyId"),
      });
      if (result.enabled) {
        await enqueueProviderConnectionProbeJob({
          providerConnectionId: result.id,
          providerId: result.providerId,
          resetHealth: true,
          source: "api_key_saved",
        });
        await enqueueProviderModelRefreshJob({
          providerId: result.providerId,
          source: "api_key_saved",
          trigger: "system",
        });
      }
      return providerApiKeyMutationResponse(request, result.providerId);
    }

    const providerId = readRequiredText(form, "providerId");
    const providerApiKeyId = readText(form, "providerApiKeyId");
    const pastedKey = readText(form, "providerApiKey");

    // The connection dialog saves everything about a connection at once: its
    // credential, what it is called, where it sits in the order, and whether it
    // routes and is probed. State is a field of the form, not a separate act.
    const enabled = readText(form, "enabled") !== "false";
    const quotaProbeEnabled = readText(form, "quotaProbeEnabled") !== "false";

    // Saving an existing connection without a new key keeps the stored one —
    // renaming a connection must not mean rotating a working credential.
    if (providerApiKeyId && !pastedKey) {
      const updated = await updateProviderApiKeySettings({
        enabled,
        label: readText(form, "label") ?? null,
        priority: readNumber(form, "priority") ?? 100,
        providerApiKeyId,
        quotaProbeEnabled,
      });
      if (updated.enabled) {
        await enqueueProviderConnectionProbeJob({
          providerConnectionId: updated.id,
          providerId: updated.providerId,
          resetHealth: true,
          source: "api_key_saved",
        });
      }
      return providerApiKeyMutationResponse(request, updated.providerId);
    }

    const plaintext = readRequiredText(form, "providerApiKey");
    const result = await saveProviderApiKey({
      enabled,
      label: readText(form, "label"),
      encryptionKeySource: readConsoleEncryptionKeySource(),
      plaintext,
      priority: readNumber(form, "priority"),
      providerApiKeyId,
      providerId,
      quotaProbeEnabled,
    });
    if (result.metadata.enabled) {
      await enqueueProviderConnectionProbeJob({
        providerConnectionId: result.metadata.id,
        providerId,
        resetHealth: true,
        source: "api_key_saved",
      });
      await enqueueProviderModelRefreshJob({
        providerId,
        source: "api_key_saved",
        trigger: "system",
      });
    }

    // The console posts this form through MutationForm, which needs nothing
    // back but the outcome. The secret the operator pasted is stored encrypted
    // and read again only as a prefix; answering with it would put it in the
    // page's scripts, where nothing asked for it and nothing can account for it.
    if (request.headers.get("accept")?.includes("application/json")) {
      return providerApiKeyMutationResponse(request, providerId);
    }

    return new NextResponse(
      renderOneTimeProviderKeyPage({
        action: result.action,
        keyPrefix: result.metadata.keyPrefix,
        plaintext: plaintext.trim(),
      }),
      {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
        status: 200,
      },
    );
  } catch (error) {
    return consoleActionErrorResponse(error, "Provider API key operation failed.");
  }
});

function providerApiKeyMutationResponse(request: Request, providerId: string): NextResponse {
  if (request.headers.get("accept")?.includes("application/json")) {
    return new NextResponse(null, { status: 204 });
  }

  return NextResponse.redirect(
    new URL(`/providers?selected=${encodeURIComponent(providerId)}`, request.url),
    303,
  );
}
