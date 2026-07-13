"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useRef, useState } from "react";
import { ConsoleDialog } from "../_components/console-dialog";
import {
  ConsoleMutationError,
  type ConsoleMutationFailure,
  toConsoleMutationFailure,
} from "../_components/console-mutation-form";
import { FlatIcon } from "../_components/flat-icon";

type SavedProviderKey = {
  action: "created" | "rotated";
  apiKey: string;
  keyPrefix: string;
};

export function ProviderKeyCreateDialogClient({
  closeHref,
  providerId,
  providerName,
}: {
  closeHref: string;
  providerId: string;
  providerName: string;
}) {
  const router = useRouter();
  const [savedKey, setSavedKey] = useState<SavedProviderKey | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const [failure, setFailure] = useState<ConsoleMutationFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const triggerId = `provider-key-${providerId}-trigger`;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFailure(null);
    setSubmitting(true);
    try {
      const form = event.currentTarget;
      const response = await fetch(form.action, {
        body: new FormData(form),
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as Partial<SavedProviderKey> & {
        code?: string;
        details?: Record<string, unknown>;
        error?: string;
      };
      if (!response.ok) {
        setFailure(toConsoleMutationFailure(payload, "Provider API key operation failed."));
        return;
      }
      if (
        (payload.action !== "created" && payload.action !== "rotated") ||
        !payload.apiKey ||
        !payload.keyPrefix
      ) {
        setFailure({ message: "Provider API key operation returned incomplete details." });
        return;
      }
      setSavedKey({
        action: payload.action,
        apiKey: payload.apiKey,
        keyPrefix: payload.keyPrefix,
      });
      router.refresh();
    } catch {
      setFailure({ message: "Provider API key operation failed." });
    } finally {
      setSubmitting(false);
    }
  };

  if (savedKey) {
    const heading =
      savedKey.action === "created" ? "Provider API key saved" : "Provider API key rotated";
    return (
      <ConsoleDialog
        ariaLabelledby="provider-key-saved-title"
        className="console-dialog provider-key-dialog"
        closeHref={closeHref}
        initialFocus="close"
        key="saved"
        triggerId={triggerId}
      >
        <div className="console-dialog-head">
          <h2 id="provider-key-saved-title">{heading}</h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <p>Copy this API key now. It will not be shown again.</p>
        <dl className="agent-detail-fields">
          <div>
            <dt>Provider API key</dt>
            <dd>
              <input
                aria-label="Provider API key"
                className="mono"
                readOnly
                value={savedKey.apiKey}
              />
            </dd>
          </div>
          <div>
            <dt>Provider API key prefix</dt>
            <dd className="mono">{savedKey.keyPrefix}</dd>
          </div>
        </dl>
      </ConsoleDialog>
    );
  }

  return (
    <ConsoleDialog
      ariaLabelledby="provider-key-create-title"
      className="console-dialog provider-key-dialog"
      closeHref={closeHref}
      key="create"
      triggerId={triggerId}
    >
      <div className="console-dialog-head">
        <h2 id="provider-key-create-title">New {providerName} API key</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <form
        className="provider-create-form"
        action="/api/provider-keys"
        method="post"
        onInput={() => setFailure(null)}
        onSubmit={submit}
        ref={formRef}
      >
        <input type="hidden" name="providerId" value={providerId} />
        <label htmlFor="provider-key-create-value">Provider API key</label>
        <input
          autoComplete="off"
          id="provider-key-create-value"
          name="providerApiKey"
          required
          type="password"
        />
        <label htmlFor="provider-key-create-label">Label</label>
        <input id="provider-key-create-label" maxLength={100} name="label" type="text" />
        <label htmlFor="provider-key-create-priority">Priority</label>
        <input
          defaultValue={100}
          id="provider-key-create-priority"
          max={100}
          min={0}
          name="priority"
          step={1}
          type="number"
        />
        <ConsoleMutationError failure={failure} formRef={formRef} />
        <button disabled={submitting} type="submit">
          <span>{submitting ? "Saving…" : "Save"}</span>
        </button>
      </form>
    </ConsoleDialog>
  );
}
