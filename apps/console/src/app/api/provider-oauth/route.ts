import {
  enqueueProviderConnectivityCheckJob,
  enqueueProviderModelRefreshJob,
} from "@llmingress/db/provider-jobs";
import { type NextRequest, NextResponse } from "next/server";
import { sessionCookieName, verifyConsoleSession } from "../../../server/auth";
import { readConsoleMasterKeySource } from "../../../server/provider-keys";
import {
  completeProviderOAuthAuthorization,
  revokeProviderOAuthConnection,
  setProviderOAuthConnectionEnabled,
  startProviderOAuthConnection,
} from "../../../server/provider-oauth";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const sessionToken = request.cookies.get(sessionCookieName)?.value;
  if (!(await verifyConsoleSession(sessionToken))) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const form = await request.formData();
  const action = readOptionalText(form, "action") ?? "start";

  try {
    if (action === "complete") {
      const result = await completeProviderOAuthAuthorization({
        callbackInput: readRequiredText(form, "callbackInput"),
        label: readNullableText(form, "label"),
        masterKeySource: readConsoleMasterKeySource(),
        priority: readOptionalNumber(form, "priority"),
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      await enqueueProviderModelRefreshJob({ providerId: result.providerId });
      await enqueueProviderConnectivityCheckJob({ providerId: result.providerId });
      return redirectToProvider(request, result.providerId);
    }

    if (action === "delete") {
      const result = await revokeProviderOAuthConnection({
        masterKeySource: readConsoleMasterKeySource(),
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      return redirectToProvider(request, result.providerId);
    }

    if (action === "enable" || action === "disable") {
      const result = await setProviderOAuthConnectionEnabled({
        enabled: action === "enable",
        providerOAuthId: readRequiredText(form, "providerOAuthId"),
      });
      await enqueueProviderConnectivityCheckJob({ providerId: result.providerId });
      return redirectToProvider(request, result.providerId);
    }

    const result = await startProviderOAuthConnection({
      label: readOptionalText(form, "label"),
      priority: readOptionalNumber(form, "priority"),
      providerId: readRequiredText(form, "providerId"),
    });

    return redirectToProviderOAuthDialog(request, {
      authorizeUrl: result.authorizeUrl,
      label: result.connection.label,
      priority: result.connection.priority,
      providerId: result.connection.providerId,
      providerOAuthId: result.connection.id,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Provider OAuth operation failed.";
    const providerId = readOptionalText(form, "providerId");
    if (providerId && (action === "start" || action === "complete")) {
      return redirectToProviderOAuthDialog(request, {
        authorizeUrl: readOptionalText(form, "providerAuthorizeUrl"),
        error: message,
        label: readNullableText(form, "label"),
        priority: readOptionalNumber(form, "priority"),
        providerId,
        providerOAuthId: readOptionalText(form, "providerOAuthId"),
      });
    }

    return NextResponse.json({ error: message }, { status: 400 });
  }
}

function redirectToProvider(request: NextRequest, providerId: string): NextResponse {
  return NextResponse.redirect(
    new URL(`/providers?selected=${encodeURIComponent(providerId)}`, request.url),
    303,
  );
}

function redirectToProviderOAuthDialog(
  request: NextRequest,
  input: {
    authorizeUrl?: string;
    error?: string;
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
  if (input.error) {
    url.searchParams.set("providerOAuthError", input.error);
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
  return NextResponse.redirect(url, 303);
}

function readOptionalText(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value.trim();
}

function readRequiredText(form: FormData, name: string): string {
  const value = form.get(name);
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function readNullableText(form: FormData, name: string): string | null | undefined {
  const value = form.get(name);
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || null;
}

function readOptionalNumber(form: FormData, name: string): number | undefined {
  const value = readOptionalText(form, name);
  return value === undefined ? undefined : Number(value);
}
