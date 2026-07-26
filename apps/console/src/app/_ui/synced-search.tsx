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

  useEffect(() => {
    if (typed === settled.current) {
      return;
    }
    const timer = setTimeout(() => {
      settled.current = typed;
      const url = new URL(href.replace("__value__", encodeURIComponent(typed)), location.origin);
      for (const field of preserveFields ?? []) {
        const element = document.querySelector<HTMLInputElement>(`input[name="${field}"]`);
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
      name={name}
      placeholder={placeholder}
      value={typed}
      onChange={(event) => setTyped(event.target.value)}
      className={className}
    />
  );
}
