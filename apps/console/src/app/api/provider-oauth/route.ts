import { readConsoleEncryptionKeySource } from "@llmingress/db/console-provider-keys";
import {
  completeProviderOAuthAuthorization,
  pollProviderOAuthDeviceAuthorization,
  revokeProviderOAuthConnection,
  setProviderOAuthConnectionEnabled,
  setProviderOAuthQuotaProbeEnabled,
  startProviderOAuthConnection,
  updateProviderOAuthConnectionSettings,
} from "@llmingress/db/console-provider-oauth";
import {
  enqueueProviderConnectionProbeJob,
  enqueueProviderModelRefreshJob,
} from "@llmingress/db/provider-jobs";
import { type NextRequest, NextResponse } from "next/server";
import { withConsoleAuth } from "../_auth";
import { classifyConsoleActionError } from "../_error-classify";
import { consoleActionErrorResponse } from "../_errors";
import { readNullableText, readNumber, readRequiredText, readText } from "../_form";
import { redirectToConsolePath } from "../_redirect";

export const POST = withConsoleAuth(async (request) => {
  const form = await request.formData();
  const action = readText(form, "action") ?? "start";

  try {
    if (action === "complete") {
      const result = await completeProviderOAuthAuthorization({
        callbackInput: readRequiredText(form, "callbackInput"),
        label: readNullableText(form, "label"),
        encryptionKeySource: readConsoleEncryptionKeySource(),
        priority: readNumber(form, "priority"),
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      await enqueueProviderConnectionProbeJob({
        providerConnectionId: result.id,
        providerId: result.providerId,
        resetHealth: true,
        source: "oauth_ready",
      });
      await enqueueProviderModelRefreshJob({
        providerId: result.providerId,
        source: "oauth_ready",
        trigger: "system",
      });
      return redirectToProvider(result.providerId);
    }

    if (action === "poll") {
      const result = await pollProviderOAuthDeviceAuthorization({
        encryptionKeySource: readConsoleEncryptionKeySource(),
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      if (result.status === "complete" && result.id && result.providerId) {
        await enqueueProviderConnectionProbeJob({
          providerConnectionId: result.id,
          providerId: result.providerId,
          resetHealth: true,
          source: "oauth_ready",
        });
        await enqueueProviderModelRefreshJob({
          providerId: result.providerId,
          source: "oauth_ready",
          trigger: "system",
        });
      }
      return NextResponse.json({ message: result.message, status: result.status });
    }

    // Saving an authorized connection edits what the console owns about it —
    // its label and its routing priority. Starting an authorization from the
    // edit dialog would have created a second connection instead.
    if (action === "update") {
      const providerOAuthId = readRequiredText(form, "providerOAuthId");
      const result = await updateProviderOAuthConnectionSettings({
        enabled: readText(form, "enabled") !== "false",
        label: readNullableText(form, "label") ?? null,
        priority: readNumber(form, "priority") ?? 100,
        providerOAuthId,
      });
      await setProviderOAuthQuotaProbeEnabled({
        providerOAuthId,
        quotaProbeEnabled: readText(form, "quotaProbeEnabled") !== "false",
      });
      if (result.enabled) {
        await enqueueProviderConnectionProbeJob({
          providerConnectionId: result.id,
          providerId: result.providerId,
          resetHealth: true,
          source: "oauth_ready",
        });
      }
      return redirectToProvider(result.providerId);
    }

    if (action === "delete") {
      const result = await revokeProviderOAuthConnection({
        encryptionKeySource: readConsoleEncryptionKeySource(),
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      return redirectToProvider(result.providerId);
    }

    if (action === "quota-probe-enable" || action === "quota-probe-disable") {
      const result = await setProviderOAuthQuotaProbeEnabled({
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
        quotaProbeEnabled: action === "quota-probe-enable",
      });
      return redirectToProvider(result.providerId);
    }

    if (action === "enable" || action === "disable") {
      const result = await setProviderOAuthConnectionEnabled({
        enabled: action === "enable",
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      if (result.enabled) {
        await enqueueProviderConnectionProbeJob({
          providerConnectionId: result.id,
          providerId: result.providerId,
          resetHealth: true,
          source: "oauth_ready",
        });
        await enqueueProviderModelRefreshJob({
          providerId: result.providerId,
          source: "oauth_ready",
          trigger: "system",
        });
      }
      return redirectToProvider(result.providerId);
    }

    const result = await startProviderOAuthConnection({
      label: readText(form, "label"),
      priority: readNumber(form, "priority"),
      providerId: readRequiredText(form, "providerId"),
    });

    return redirectToProviderOAuthDialog(request, {
      ...(result.flowType === "device_code"
        ? {
            deviceInterval: result.intervalSeconds,
            deviceUserCode: result.userCode,
            deviceVerificationUri: result.verificationUri,
          }
        : { authorizeUrl: result.authorizeUrl }),
      label: result.connection.label,
      priority: result.connection.priority,
      providerId: result.connection.providerId,
      providerOAuthId: result.connection.id,
    });
  } catch (error) {
    if (request.headers.get("accept")?.includes("application/json")) {
      return consoleActionErrorResponse(error, "Provider OAuth operation failed.");
    }
    const providerId = readText(form, "providerId");
    if (providerId && (action === "start" || action === "complete")) {
      const verdict = classifyConsoleActionError(error, "Provider OAuth operation failed.");
      if (verdict.status === 500) {
        return consoleActionErrorResponse(error, "Provider OAuth operation failed.");
      }
      return redirectToProviderOAuthDialog(request, {
        authorizeUrl: readText(form, "providerAuthorizeUrl"),
        error: verdict.message,
        errorCode: verdict.code,
        label: readNullableText(form, "label"),
        priority: readNumber(form, "priority"),
        providerId,
        providerOAuthId: readText(form, "providerOAuthId"),
      });
    }

    return consoleActionErrorResponse(error, "Provider OAuth operation failed.");
  }
});

function redirectToProvider(providerId: string): NextResponse {
  return redirectToConsolePath(`/providers?selected=${encodeURIComponent(providerId)}`);
}

function redirectToProviderOAuthDialog(
  request: NextRequest,
  input: {
    authorizeUrl?: string;
    deviceInterval?: number;
    deviceUserCode?: string;
    deviceVerificationUri?: string;
    error?: string;
    errorCode?: string;
    label?: string | null;
    priority?: number;
    providerId: string;
    providerOAuthId?: string;
  },
): NextResponse {
  const url = new URL("/providers", request.url);
  url.searchParams.set("selected", input.providerId);
  url.searchParams.set("providerKeyDialog", input.providerId);
  if (input.authorizeUrl) {
    url.searchParams.set("providerAuthorizeUrl", input.authorizeUrl);
  }
  if (input.deviceUserCode) {
    url.searchParams.set("providerOAuthUserCode", input.deviceUserCode);
  }
  if (input.deviceVerificationUri) {
    url.searchParams.set("providerOAuthVerificationUri", input.deviceVerificationUri);
  }
  if (input.deviceInterval !== undefined) {
    url.searchParams.set("providerOAuthInterval", String(input.deviceInterval));
  }
  if (input.error) {
    url.searchParams.set("providerOAuthError", input.error);
  }
  if (input.errorCode) {
    url.searchParams.set("providerOAuthErrorCode", input.errorCode);
  }
  if (input.providerOAuthId) {
    url.searchParams.set("providerOAuthId", input.providerOAuthId);
  }
  if (input.label) {
    url.searchParams.set("providerOAuthLabelValue", input.label);
  }
  if (input.priority !== undefined) {
    url.searchParams.set("providerOAuthPriorityValue", String(input.priority));
  }
  return redirectToConsolePath(url);
}
