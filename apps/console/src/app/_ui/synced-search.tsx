"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * A search box that applies itself. Typing settles for a moment and then the
 * list below re-reads — there is no button to press, and so no state where the
 * box says one thing and the list shows another.
 *
 * The pause matters: a request per keystroke would be mostly wasted work, and
 * the results would jump under the operator while they are still typing.
 */
export function SyncedSearchInput({
  className,
  href,
  name,
  placeholder,
  preserveFields,
  value,
  ...rest
}: {
  className?: string;
  /** Href for the typed value; `__value__` is replaced with it. */
  href: string;
  name: string;
  placeholder?: string;
  /** Sibling text fields to carry along, so typed input survives the reload. */
  preserveFields?: readonly string[];
  value: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "defaultValue">) {
  const router = useRouter();
  const [typed, setTyped] = useState(value);
  const settled = useRef(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (typed === settled.current) {
      return;
    }
    const timer = setTimeout(() => {
      settled.current = typed;
      const url = new URL(href.replace("__value__", encodeURIComponent(typed)), location.origin);
      for (const field of preserveFields ?? []) {
        // The draft this box sits beside — scoped to its own form, the way the
        // select next to it reads its siblings. A document-wide lookup finds
        // whichever field of that name renders first on the page.
        const element = inputRef.current
          ?.closest("form")
          ?.elements.namedItem(field) as HTMLInputElement | null;
        if (element?.value) {
          url.searchParams.set(`editor_${field}`, element.value);
        }
      }
      router.replace(`${url.pathname}${url.search}`, { scroll: false });
    }, 350);
    return () => clearTimeout(timer);
  }, [href, preserveFields, router, typed]);

  return (
    <input
      {...rest}
      ref={inputRef}
      name={name}
      placeholder={placeholder}
      value={typed}
      onChange={(event) => setTyped(event.target.value)}
      // The box applies itself, so Enter has nothing to do here — and inside an
      // editor it would submit the form the operator is still filling in.
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
        }
      }}
      className={className}
    />
  );
}
