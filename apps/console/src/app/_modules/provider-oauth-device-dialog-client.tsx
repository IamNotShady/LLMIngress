"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ConsoleDialog } from "../_components/console-dialog";
import { FlatIcon } from "../_components/flat-icon";

type DevicePollStatus = "complete" | "error" | "expired" | "polling";

// Device-code login dialog: shows the user code + verification URI to enter
// upstream, then polls the console poll route until the authorization completes
// (or the code expires). One-time: the dialog is driven entirely by the start
// redirect's query params, never a DB re-read (§ one-time dialog semantics).
export function ProviderOAuthDeviceCreateDialog({
  closeHref,
  error,
  intervalSeconds,
  providerDisplayName,
  providerId,
  providerOAuthId,
  userCode,
  verificationUri,
}: {
  closeHref: string;
  error?: string;
  intervalSeconds?: string;
  providerDisplayName: string;
  providerId: string;
  providerOAuthId?: string;
  userCode?: string;
  verificationUri?: string;
}) {
  const router = useRouter();
  const hasPending = Boolean(userCode && providerOAuthId);
  const [status, setStatus] = useState<DevicePollStatus>(error ? "error" : "polling");
  const [message, setMessage] = useState<string | null>(error ?? null);

  const parsedInterval = Number.parseInt(intervalSeconds ?? "", 10);
  const intervalMs =
    Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval * 1000 : 2000;

  useEffect(() => {
    if (!hasPending || status !== "polling" || !providerOAuthId) {
      return;
    }

    let active = true;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      try {
        const body = new FormData();
        body.set("action", "poll");
        body.set("providerOAuthId", providerOAuthId);
        const response = await fetch("/api/provider-oauth", {
          body,
          credentials: "same-origin",
          headers: { accept: "application/json" },
          method: "POST",
        });
        if (!active) {
          return;
        }
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
          status?: string;
        };
        const next = response.ok ? payload.status : "error";
        if (next === "complete") {
          setStatus("complete");
          router.refresh();
          return;
        }
        if (next === "expired") {
          setStatus("expired");
          setMessage("The authorization code expired. Close this dialog and start again.");
          return;
        }
        if (next === "error") {
          setStatus("error");
          setMessage(payload.error ?? "Device authorization failed. Close and try again.");
          return;
        }
        timer = setTimeout(poll, intervalMs);
      } catch {
        if (!active) {
          return;
        }
        timer = setTimeout(poll, intervalMs);
      }
    };

    timer = setTimeout(poll, intervalMs);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [hasPending, intervalMs, providerOAuthId, router, status]);

  return (
    <ConsoleDialog
      ariaLabelledby="provider-oauth-device-title"
      className="console-dialog provider-key-dialog"
      closeHref={closeHref}
      triggerId={`provider-key-${providerId}-trigger`}
    >
      <div className="console-dialog-head">
        <h2 id="provider-oauth-device-title">Connect {providerDisplayName}</h2>
        <a className="secondary-button" href={closeHref}>
          <FlatIcon name="cancel" />
          <span>Close</span>
        </a>
      </div>
      {status === "complete" ? (
        <div className="provider-oauth-device-status" role="status">
          <p>{providerDisplayName} is connected. You can close this dialog.</p>
          <a className="oauth-action-button" href={closeHref}>
            <FlatIcon name="confirm" />
            <span>Done</span>
          </a>
        </div>
      ) : hasPending ? (
        <div className="provider-create-form provider-oauth-device-form">
          <p>Open the verification page and enter this code to authorize the connection.</p>
          <span className="provider-oauth-device-code-label">Your code</span>
          <p className="provider-oauth-device-code mono" aria-label="Device authorization code">
            {userCode}
          </p>
          <a
            className="oauth-open-link secondary-button"
            href={verificationUri}
            target="_blank"
            rel="noreferrer"
          >
            <FlatIcon name="view" />
            <span>Open verification page</span>
          </a>
          <p className="provider-oauth-device-poll" role="status">
            {status === "polling"
              ? "Waiting for you to authorize…"
              : (message ?? "Authorization did not complete.")}
          </p>
        </div>
      ) : (
        <p className="form-error" role="alert">
          {message ?? "Could not start the device authorization. Close and try again."}
        </p>
      )}
    </ConsoleDialog>
  );
}
