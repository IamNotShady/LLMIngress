"use client";

import { useEffect, useState } from "react";
import { copyText } from "./copy-text";
import { announceToast } from "./toast";

/**
 * Copies a value the operator would otherwise retype by hand — a device code, an
 * authorization url. It says what happened, because a copy that silently failed
 * and a copy that worked look identical, and the next thing the operator does is
 * paste somewhere this console cannot see.
 */
/** Sized by prop, not by an override: a class would depend on stylesheet order. */
const sizeClass = {
  default: "px-[10px] py-1 text-135",
  row: "px-2 py-[2px] text-12",
} as const;

export function CopyButton({
  children,
  href,
  label = "to the clipboard",
  size = "default",
  value,
}: {
  children: string;
  /** What was copied, said in the toast: "Copied the gateway address". */
  label?: string;
  /** Opened in a new tab alongside the copy, where the design pairs the two. */
  href?: string;
  /** "row" for the small one that sits on a block's label line. */
  size?: keyof typeof sizeClass;
  value: string;
}) {
  const [outcome, setOutcome] = useState<"copied" | "failed" | null>(null);

  useEffect(() => {
    if (!outcome) {
      return;
    }
    const timer = setTimeout(() => setOutcome(null), 2000);
    return () => clearTimeout(timer);
  }, [outcome]);

  return (
    <button
      type="button"
      onClick={() => {
        void copyText(value).then((copied) => {
          setOutcome(copied ? "copied" : "failed");
          // Copy is an idempotent action, and those report through the toast:
          // the button's own label is at the edge of where the eye is.
          announceToast(
            copied
              ? { message: `Copied ${label}`, tone: "green" }
              : {
                  message: `Could not copy ${label}`,
                  meta: "This browser blocks clipboard access on plain http — select the value and copy it by hand.",
                  tone: "red",
                },
          );
        });
        if (href) {
          window.open(href, "_blank", "noreferrer");
        }
      }}
      className={`cursor-pointer whitespace-nowrap rounded-xs border border-btnbd bg-btnbg font-mono font-medium ${
        outcome === "failed" ? "text-redtx" : "text-ink"
      } ${sizeClass[size]}`}
    >
      {outcome === "failed" ? "copy failed" : outcome === "copied" ? "copied" : children}
    </button>
  );
}
