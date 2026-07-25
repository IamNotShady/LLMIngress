"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SelectInput } from "./controls";

/**
 * A form field whose choice also has to change what the rest of the dialog
 * shows — the endpoint protocol decides which candidates are selectable, the
 * strategy decides how the order is read. The value is posted with the form
 * like any other field, and picking it also rewrites the URL so the server
 * re-renders everything downstream against the new choice.
 */
export function SyncedSelect({
  children,
  href,
  name,
  preserveFields,
  value,
  ...rest
}: {
  children: React.ReactNode;
  /** Href for the chosen value; `__value__` is replaced with the selection. */
  href: string;
  name: string;
  /** Sibling text fields to carry along, so typed input survives the reload. */
  preserveFields?: readonly string[];
  value: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "value">) {
  const router = useRouter();
  const [pending, setPending] = useState(value);

  return (
    <SelectInput
      {...rest}
      data-sync-href={href}
      name={name}
      value={pending}
      onChange={(event) => {
        const next = event.target.value;
        setPending(next);
        const url = new URL(
          href.replace("__value__", encodeURIComponent(next)),
          window.location.origin,
        );
        for (const field of preserveFields ?? []) {
          const element = event.target.form?.elements.namedItem(field);
          const fieldValue = element instanceof HTMLInputElement ? element.value : "";
          if (fieldValue) {
            url.searchParams.set(`editor_${field}`, fieldValue);
          }
        }
        router.replace(`${url.pathname}${url.search}`, { scroll: false });
      }}
    >
      {children}
    </SelectInput>
  );
}
