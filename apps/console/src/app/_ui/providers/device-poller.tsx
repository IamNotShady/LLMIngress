"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";

/**
 * Device-code authorization completes at the provider, not here, so the console
 * polls its own endpoint at the interval the provider asked for and refreshes
 * the page once the token lands.
 */
export function DeviceCodePoller({
  children,
  formId,
  intervalSeconds,
  oauthId,
  providerId,
}: {
  /** Trailing content of the status row — the code's expiry countdown. */
  children?: ReactNode;
  /**
   * The settings form on the same screen. The operator sets the label, priority
   * and state while they wait, so once the provider confirms, those values are
   * submitted rather than thrown away by the refresh.
   */
  formId?: string;
  intervalSeconds: number;
  oauthId: string;
  providerId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<"authorized" | "failed" | "waiting">("waiting");
  const [detail, setDetail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const period = Math.max(1, intervalSeconds) * 1000;

    const poll = async () => {
      try {
        const body = new FormData();
        body.set("action", "poll");
        body.set("providerId", providerId);
        body.set("providerOAuthId", oauthId);
        const response = await fetch("/api/provider-oauth", {
          body,
          headers: { accept: "application/json" },
          method: "POST",
        });
        if (cancelled) {
          return;
        }
        if (response.ok) {
          const payload = (await response.json().catch(() => null)) as {
            message?: string;
            status?: string;
          } | null;
          // The route reports complete | error | expired | pending; only the
          // first is done and the middle two are terminal, so polling must stop
          // rather than hammering an authorization that will never arrive.
          if (payload?.status === "complete") {
            setState("authorized");
            // The provider confirmed, so the connection now exists for real:
            // save what the operator set while they were waiting. Submitting
            // the form navigates, so no refresh is needed on that path.
            const settings = formId
              ? (document.getElementById(formId) as HTMLFormElement | null)
              : null;
            if (settings) {
              settings.requestSubmit();
            } else {
              router.refresh();
            }
            return;
          }
          if (payload?.status === "error" || payload?.status === "expired") {
            setState("failed");
            setDetail(payload.message ?? `Authorization ${payload.status}.`);
            return;
          }
        } else if (response.status >= 400 && response.status !== 409) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          setState("failed");
          setDetail(payload?.error ?? "Authorization failed at the provider.");
          return;
        }
      } catch {
        // A transient network error is not a failed authorization — keep polling.
      }
      if (!cancelled) {
        timer = setTimeout(poll, period);
      }
    };

    let timer = setTimeout(poll, period);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [formId, intervalSeconds, oauthId, providerId, router]);

  const tone = state === "authorized" ? "bg-green" : state === "failed" ? "bg-red" : "bg-amber";
  const message =
    state === "authorized"
      ? "authorized · this connection is connected"
      : state === "failed"
        ? (detail ?? "authorization failed")
        : `waiting for authorization · polling every ${Math.max(1, intervalSeconds)}s`;

  return (
    <div className="mt-3 flex items-center gap-[9px]">
      <span className={`size-[7px] flex-none rounded-full ${tone}`} />
      <span className="font-mono text-13 text-ink">{message}</span>
      {state === "waiting" ? children : null}
    </div>
  );
}
