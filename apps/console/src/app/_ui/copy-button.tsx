"use client";

import { useEffect, useState } from "react";

/**
 * Copies a value the operator would otherwise retype by hand — a device code, an
 * authorization url. It says it worked, because a copy that silently failed and
 * a copy that worked look identical, and the next thing the operator does is
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
  size = "default",
  value,
}: {
  children: string;
  /** Opened in a new tab alongside the copy, where the design pairs the two. */
  href?: string;
  /** "row" for the small one that sits on a block's label line. */
  size?: keyof typeof sizeClass;
  value: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
        if (href) {
          window.open(href, "_blank", "noreferrer");
        }
      }}
      className={`cursor-pointer whitespace-nowrap rounded-xs border border-btnbd bg-btnbg font-mono font-medium text-ink ${sizeClass[size]}`}
    >
      {copied ? "copied" : children}
    </button>
  );
}
