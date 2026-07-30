"use client";

import { useRouter } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";

/** Text fields whose typed value has to survive a candidate click. */
const PRESERVED_FIELDS = ["name", "description"] as const;

/**
 * The candidate list, its filters and the endpoint choice are all URL state, so
 * picking one re-renders the editor from the server. Anything typed but not yet
 * saved would be lost on the way — so every link inside the editor carries the
 * current name and description along, and the server renders them back.
 */
export function EditorNav({ children }: { children: ReactNode }) {
  const router = useRouter();

  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.button !== 0) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest("a");
    if (!anchor?.href) {
      return;
    }
    const form = anchor.closest("form") ?? anchor.closest("[data-editor]")?.querySelector("form");
    if (!form) {
      return;
    }
    const url = new URL(anchor.href);
    // Leaving the editor — Cancel, or the dialog's close — discards the draft
    // rather than carrying it into the URL of the page behind.
    if (!url.searchParams.has("dialog")) {
      return;
    }
    for (const field of PRESERVED_FIELDS) {
      const element = (form as HTMLFormElement).elements.namedItem(field);
      const value = element instanceof HTMLInputElement ? element.value : "";
      if (value) {
        url.searchParams.set(`editor_${field}`, value);
      } else {
        url.searchParams.delete(`editor_${field}`);
      }
    }
    event.preventDefault();
    router.replace(`${url.pathname}${url.search}`, { scroll: false });
  };

  return (
    <div data-editor onClickCapture={onClickCapture}>
      {children}
    </div>
  );
}
