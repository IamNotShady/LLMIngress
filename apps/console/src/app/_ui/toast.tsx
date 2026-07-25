"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Idempotent actions (Re-check, Refresh models, Copy, Send request) redirect
 * back with ?toast=…, which this renders bottom-right for 4 seconds. Nothing
 * destructive ever reports through a toast — those get a confirm dialog.
 */
const TOAST_MS = 4000;

export type ToastTone = "accent" | "green" | "amber";

const accentVar: Record<ToastTone, string> = {
  accent: "var(--accent)",
  green: "var(--green)",
  amber: "var(--amber)",
};

export function ToastHost() {
  const params = useSearchParams();
  const router = useRouter();
  const message = params.get("toast");
  const meta = params.get("toastMeta");
  const tone = (params.get("toastTone") ?? "accent") as ToastTone;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
    if (!message) {
      return;
    }
    const timer = setTimeout(() => setDismissed(true), TOAST_MS);
    return () => clearTimeout(timer);
  }, [message]);

  if (!message || dismissed) {
    return null;
  }

  const dismiss = () => {
    setDismissed(true);
    const next = new URLSearchParams(params.toString());
    next.delete("toast");
    next.delete("toastMeta");
    next.delete("toastTone");
    const query = next.toString();
    router.replace(query ? `?${query}` : "?", { scroll: false });
  };

  return (
    <output
      className="fixed bottom-14 right-6 z-95 flex w-[420px] max-w-[calc(100vw-48px)] items-start gap-3 rounded-sm border border-hair bg-btnbg px-[14px] py-[11px] shadow-drawer"
      style={{ borderLeft: `3px solid ${accentVar[tone] ?? accentVar.accent}` }}
    >
      <div className="min-w-0 flex-1">
        <div className="font-mono text-13 leading-[1.5] text-ink">{message}</div>
        {meta ? (
          <div className="mt-[3px] font-mono text-125 leading-[1.5] text-faint">{meta}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss notification"
        className="flex-none cursor-pointer border-0 bg-transparent font-mono text-15 font-medium text-dim"
      >
        ✕
      </button>
    </output>
  );
}
