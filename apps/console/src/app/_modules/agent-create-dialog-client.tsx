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
import { AgentIntegrationGuideTabs } from "./agent-integration-guide-tabs";

type CreatedAgentDetails = {
  apiKey: string;
  gatewayBaseUrl: string;
  keyPrefix: string;
  virtualModelName: string;
};

export function AgentCreateDialogClient({
  children,
  closeHref,
}: {
  children: ReactNode;
  closeHref: string;
}) {
  const router = useRouter();
  const [createdAgent, setCreatedAgent] = useState<CreatedAgentDetails | null>(null);
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
      const response = await fetch(form.getAttribute("action") ?? "/api/agents", {
        body: new FormData(form),
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "POST",
      });
      const payload = (await response.json()) as Partial<CreatedAgentDetails> & {
        code?: string;
        details?: Record<string, unknown>;
        error?: string;
      };
      if (!response.ok) {
        setFailure(toConsoleMutationFailure(payload, "Agent creation failed."));
        return;
      }
      if (
        !payload.apiKey ||
        !payload.gatewayBaseUrl ||
        !payload.keyPrefix ||
        !payload.virtualModelName
      ) {
        setFailure({ message: "Agent creation returned incomplete connection details." });
        return;
      }
      setCreatedAgent({
        apiKey: payload.apiKey,
        gatewayBaseUrl: payload.gatewayBaseUrl,
        keyPrefix: payload.keyPrefix,
        virtualModelName: payload.virtualModelName,
      });
      router.refresh();
    } catch {
      setFailure({ message: "Agent creation failed." });
    } finally {
      setSubmitting(false);
    }
  };

  if (createdAgent) {
    return (
      <ConsoleDialog
        ariaLabelledby="agent-created-dialog-title"
        className="console-dialog agent-created-dialog"
        closeHref={closeHref}
        initialFocus="close"
        key="created"
        triggerId="agent-create-dialog-trigger"
      >
        <div className="console-dialog-head">
          <h2 id="agent-created-dialog-title">Agent created</h2>
          <a className="secondary-button" href={closeHref}>
            <FlatIcon name="cancel" />
            <span>Close</span>
          </a>
        </div>
        <p>Copy this API key now. It will not be shown again.</p>
        <dl className="agent-detail-fields">
          <div>
            <dt>Agent API key</dt>
            <dd>
              <input
                aria-label="Agent API key"
                className="mono"
                readOnly
                value={createdAgent.apiKey}
              />
            </dd>
          </div>
          <div>
            <dt>Gateway URL</dt>
            <dd>{createdAgent.gatewayBaseUrl}</dd>
          </div>
        </dl>
        <section className="agent-created-guide">
          <h3>Integration guide</h3>
          <AgentIntegrationGuideTabs
            apiKey={createdAgent.apiKey}
            gatewayBaseUrl={createdAgent.gatewayBaseUrl}
            idPrefix="agent-created"
            model={createdAgent.virtualModelName}
          />
        </section>
      </ConsoleDialog>
    );
  }

  return (
    <ConsoleDialog
      ariaLabelledby="new-agent-dialog-title"
      className="console-dialog"
      closeHref={closeHref}
      key="create"
      triggerId="agent-create-dialog-trigger"
    >
      <div className="console-dialog-head">
        <h2 id="new-agent-dialog-title">New agent</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      <form
        className="provider-create-form"
        action="/api/agents"
        id="new-agent"
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
