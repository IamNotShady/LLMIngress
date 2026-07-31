"use client";

import { useState } from "react";

/**
 * The "?" a Field's help hides behind: click opens, click again or focus
 * leaving closes. The bubble is anchored to the label row and spans the
 * field's own width, so it cannot escape the dialog the field sits in.
 */
export function FieldHelp({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="ml-[6px] inline-block">
      <button
        type="button"
        aria-expanded={open}
        aria-label={text}
        className="cursor-pointer rounded-full border border-btnbd bg-btnbg px-[6px] py-0 font-mono text-115 leading-[1.5] text-dim"
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
      >
        ?
      </button>
      {open ? (
        <span
          aria-hidden
          className="absolute inset-x-0 top-full z-10 mt-1 block rounded-xs border border-rule bg-bg px-3 py-2 font-mono text-115 font-normal tracking-normal leading-[1.6] text-dim"
        >
          {text}
        </span>
      ) : null}
    </span>
  );
}
