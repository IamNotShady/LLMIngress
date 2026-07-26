"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Idempotent actions (Re-check, Refresh models, Copy, Send request) report here
 * bottom-right for 4 seconds. Nothing destructive ever reports through a toast —
 * those get a confirm dialog.
 *
 * A toast is something that just happened, not somewhere the operator is: it
 * does not belong in the address bar. Actions announce one by raising an event,
 * which leaves the URL — the selection, the filters, the open dialog — exactly
 * as the operator left it. A server redirect can still carry one in the query
 * string for a form posted without JavaScript.
 */
const TOAST_MS = 4000;

export type ToastTone = "accent" | "green" | "amber";

export type ConsoleToast = { message: string; meta?: string; tone?: ToastTone };

const TOAST_EVENT = "llmingress:toast";

export function announceToast(toast: ConsoleToast): void {
  window.dispatchEvent(new CustomEvent<ConsoleToast>(TOAST_EVENT, { detail: toast }));
}

const accentVar: Record<ToastTone, string> = {
  accent: "var(--accent)",
  green: "var(--green)",
  amber: "var(--amber)",
};

export function ToastHost() {
  const params = useSearchParams();
  const fromUrl = params.get("toast");
  const [toast, setToast] = useState<ConsoleToast | null>(null);

  useEffect(() => {
    const onToast = (event: Event) => {
      setToast((event as CustomEvent<ConsoleToast>).detail);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  useEffect(() => {
    if (!fromUrl) {
      return;
    }
    setToast({
      message: fromUrl,
      meta: params.get("toastMeta") ?? undefined,
      tone: (params.get("toastTone") ?? "accent") as ToastTone,
    });
  }, [fromUrl, params]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);

  if (!toast) {
    return null;
  }

  return (
    <output
      className="fixed bottom-14 right-6 z-95 flex w-[420px] max-w-[calc(100vw-48px)] items-start gap-3 rounded-sm border border-hair bg-btnbg px-[14px] py-[11px] shadow-drawer"
      style={{ borderLeft: `3px solid ${accentVar[toast.tone ?? "accent"] ?? accentVar.accent}` }}
    >
      <div className="min-w-0 flex-1">
        <div className="font-mono text-13 leading-[1.5] text-ink">{toast.message}</div>
        {toast.meta ? (
          <div className="mt-[3px] font-mono text-125 leading-[1.5] text-faint">{toast.meta}</div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => setToast(null)}
        aria-label="Dismiss notification"
        className="flex-none cursor-pointer border-0 bg-transparent font-mono text-15 font-medium text-dim"
      >
        ✕
      </button>
    </output>
  );
}
