"use client";

import type { ConsoleApiKeyLimit } from "@llmingress/db/console-api-key-limits";
import type { ApiKeyAllowedVirtualModel } from "@llmingress/db/console-api-keys";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { ConsoleDialog } from "../_components/console-dialog";
import {
  type ConsoleMutationFailure,
  toConsoleMutationFailure,
} from "../_components/console-mutation-failure";
import { ConsoleMutationError } from "../_components/console-mutation-form";
import { FlatIcon } from "../_components/flat-icon";
import { ApiKeyDetailPanels } from "./api-key-detail-panels";

type CreatedApiKeyDetails = {
  apiKey: string;
  createdAt: string;
  defaultVirtualModelName: string | null;
  enabled: boolean;
  gatewayBaseUrl: string;
  keyPrefix: string;
  limits: ConsoleApiKeyLimit[];
  name: string;
  virtualModelName: string;
  virtualModels: ApiKeyAllowedVirtualModel[];
};

export function ApiKeyCreateDialogClient({
  children,
  closeHref,
}: {
  children: ReactNode;
  closeHref: string;
}) {
  const router = useRouter();
  const [createdApiKey, setCreatedApiKey] = useState<CreatedApiKeyDetails | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [failure, setFailure] = useState<ConsoleMutationFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    setSubmitting(true);
    try {
      const form = event.currentTarget;
      if (new FormData(form).getAll("allowedVirtualModelIds").length === 0) {
        setFailure({ message: "Select at least one allowed Virtual Model." });
        form.querySelector<HTMLInputElement>('input[name="allowedVirtualModelIds"]')?.focus();
        return;
      }
      const response = await fetch(form.getAttribute("action") ?? "/api/api-keys", {
        body: new FormData(form),
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as Partial<CreatedApiKeyDetails> & {
        code?: string;
        details?: Record<string, unknown>;
        error?: string;
      };
      if (!response.ok) {
        setFailure(toConsoleMutationFailure(payload, "API key creation failed."));
        return;
      }
      if (
        !payload.apiKey ||
        !payload.createdAt ||
        !payload.gatewayBaseUrl ||
        !payload.keyPrefix ||
        !payload.name ||
        !payload.virtualModelName ||
        !Array.isArray(payload.limits) ||
        !Array.isArray(payload.virtualModels)
      ) {
        setFailure({ message: "API key creation returned incomplete connection details." });
        return;
      }
      setCreatedApiKey({
        apiKey: payload.apiKey,
        createdAt: payload.createdAt,
        defaultVirtualModelName: payload.defaultVirtualModelName ?? null,
        enabled: payload.enabled ?? true,
        gatewayBaseUrl: payload.gatewayBaseUrl,
        keyPrefix: payload.keyPrefix,
        limits: payload.limits,
        name: payload.name,
        virtualModelName: payload.virtualModelName,
        virtualModels: payload.virtualModels,
      });
      router.refresh();
    } catch {
      setFailure({ message: "API key creation failed." });
    } finally {
      setSubmitting(false);
    }
  };

  if (createdApiKey) {
    return (
      <ConsoleDialog
        ariaLabelledby="api-key-created-dialog-title"
        className="console-dialog api-key-view-dialog api-key-created-dialog"
        closeHref={closeHref}
        initialFocus="close"
        key="created"
        triggerId="api-key-create-dialog-trigger"
      >
        <div className="console-dialog-head">
          <h2 id="api-key-created-dialog-title">API Key created</h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <ApiKeyDetailPanels
          createdAt={createdApiKey.createdAt}
          defaultVirtualModelName={createdApiKey.defaultVirtualModelName}
          enabled={createdApiKey.enabled}
          gatewayBaseUrl={createdApiKey.gatewayBaseUrl}
          guideApiKey={createdApiKey.apiKey}
          guideKeyPrefix={null}
          guideModel={createdApiKey.virtualModelName}
          idPrefix="api-key-created"
          limits={createdApiKey.limits}
          secretHideable={true}
          secretLabel="API key"
          secretNote="Copy this API key now. It will not be shown again."
          secretValue={createdApiKey.apiKey}
          virtualModels={createdApiKey.virtualModels}
        />
      </ConsoleDialog>
    );
  }

  return (
    <ConsoleDialog
      ariaLabelledby="new-api-key-dialog-title"
      className="console-dialog"
      closeHref={closeHref}
      key="create"
      triggerId="api-key-create-dialog-trigger"
    >
      <div className="console-dialog-head">
        <h2 id="new-api-key-dialog-title">New API Key</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <form
        className="provider-create-form"
        action="/api/api-keys"
        id="new-api-key"
        method="post"
        onInput={() => setFailure(null)}
        onSubmit={submit}
        ref={formRef}
      >
        {children}
        <ConsoleMutationError failure={failure} formRef={formRef} />
        <button disabled={submitting} type="submit">
          <span>{submitting ? "Creating…" : "Create"}</span>
        </button>
      </form>
    </ConsoleDialog>
  );
}
