"use client";

import { useEffect, useState } from "react";

/**
 * Copies a value the operator would otherwise retype by hand — a device code, an
 * authorization url. It says it worked, because a copy that silently failed and
 * a copy that worked look identical, and the next thing the operator does is
 * paste somewhere this console cannot see.
 */
export function CopyButton({
  children,
  href,
  value,
}: {
  children: string;
  /** Opened in a new tab alongside the copy, where the design pairs the two. */
  href?: string;
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
      className="cursor-pointer whitespace-nowrap rounded-xs border border-btnbd bg-btnbg px-[10px] py-1 font-mono text-135 font-medium text-ink"
    >
      {copied ? "copied" : children}
    </button>
  );
}
