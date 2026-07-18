"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useRef, useState } from "react";
import { ConsoleDialog } from "../_components/console-dialog";
import {
  type ConsoleMutationFailure,
  toConsoleMutationFailure,
} from "../_components/console-mutation-failure";
import { ConsoleMutationError } from "../_components/console-mutation-form";
import { FlatIcon } from "../_components/flat-icon";
import { IntegrationGuideTabs } from "./api-key-integration-guide-tabs";

type CreatedApiKeyDetails = {
  apiKey: string;
  gatewayBaseUrl: string;
  keyPrefix: string;
  virtualModelName: string;
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
  const [keyCopied, setKeyCopied] = useState(false);

  async function copyApiKey() {
    if (!createdApiKey) {
      return;
    }
    try {
      await navigator.clipboard.writeText(createdApiKey.apiKey);
      setKeyCopied(true);
      window.setTimeout(() => setKeyCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context); the input stays selectable.
    }
  }
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
        !payload.gatewayBaseUrl ||
        !payload.keyPrefix ||
        !payload.virtualModelName
      ) {
        setFailure({ message: "API key creation returned incomplete connection details." });
        return;
      }
      setCreatedApiKey({
        apiKey: payload.apiKey,
        gatewayBaseUrl: payload.gatewayBaseUrl,
        keyPrefix: payload.keyPrefix,
        virtualModelName: payload.virtualModelName,
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
        className="console-dialog api-key-created-dialog"
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
        <p>Copy this API key now. It will not be shown again.</p>
        <dl className="api-key-detail-fields">
          <div>
            <dt>API key</dt>
            <dd>
              <span className="api-key-reveal-field">
                <input
                  aria-label="API key"
                  className="mono"
                  readOnly
                  value={createdApiKey.apiKey}
                />
                <button
                  aria-label="Copy API key"
                  className="secondary-button row-action-button"
                  onClick={copyApiKey}
                  title={keyCopied ? "Copied" : "Copy API key"}
                  type="button"
                >
                  <FlatIcon name={keyCopied ? "confirm" : "copy"} />
                </button>
              </span>
            </dd>
          </div>
          <div>
            <dt>Gateway URL</dt>
            <dd>{createdApiKey.gatewayBaseUrl}</dd>
          </div>
        </dl>
        <section className="api-key-created-guide">
          <h3>Integration guide</h3>
          <IntegrationGuideTabs
            apiKey={createdApiKey.apiKey}
            gatewayBaseUrl={createdApiKey.gatewayBaseUrl}
            idPrefix="api-key-created"
            model={createdApiKey.virtualModelName}
          />
        </section>
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
