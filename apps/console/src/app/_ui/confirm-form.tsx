"use client";

import { useId, useState } from "react";
import { ActionButton, TextInput } from "./controls";
import { MutationForm } from "./mutation-form";

/**
 * Destructive confirm for objects: the delete button stays inert until the
 * operator types the object's name, so a mis-click cannot destroy an API key,
 * provider or virtual model.
 */
export function TypeNameToConfirm({
  action,
  children,
  confirmLabel,
  hiddenFields,
  label,
  name,
}: {
  action: string;
  children?: React.ReactNode;
  confirmLabel: string;
  hiddenFields: Record<string, string>;
  label: string;
  name: string;
}) {
  const [typed, setTyped] = useState("");
  const inputId = useId();
  const armed = typed.trim() === name;

  return (
    <MutationForm action={action} fallbackError="The delete was refused.">
      {Object.entries(hiddenFields).map(([field, value]) => (
        <input key={field} type="hidden" name={field} value={value} />
      ))}
      <div className="mt-4">
        <label
          htmlFor={inputId}
          className="block font-mono text-115 font-medium tracking-[.08em] text-dim"
        >
          {label}
        </label>
        <TextInput
          id={inputId}
          className="mt-[5px]"
          autoComplete="off"
          placeholder={name}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
        />
      </div>
      <div className="mt-[18px] flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={!armed}
          className="inline-flex cursor-pointer items-center whitespace-nowrap rounded-xs bg-red px-[18px] py-[6px] font-mono text-135 font-medium text-bg disabled:cursor-not-allowed disabled:opacity-50"
        >
          {confirmLabel}
        </button>
        {children}
      </div>
    </MutationForm>
  );
}

/** Confirm with no typing gate — used for limit rules and state changes. */
export function ConfirmForm({
  action,
  children,
  confirmLabel,
  hiddenFields,
  tone = "danger",
}: {
  action: string;
  children?: React.ReactNode;
  confirmLabel: string;
  hiddenFields: Record<string, string>;
  tone?: "danger" | "primary";
}) {
  return (
    <MutationForm action={action} className="mt-[18px]" fallbackError="The action was refused.">
      <div className="flex flex-wrap items-center gap-2">
        {Object.entries(hiddenFields).map(([field, value]) => (
          <input key={field} type="hidden" name={field} value={value} />
        ))}
        {tone === "danger" ? (
          <button
            type="submit"
            className="inline-flex cursor-pointer items-center whitespace-nowrap rounded-xs bg-red px-[18px] py-[6px] font-mono text-135 font-medium text-bg"
          >
            {confirmLabel}
          </button>
        ) : (
          <ActionButton className="px-[18px] py-[6px] text-135" tone="primary">
            {confirmLabel}
          </ActionButton>
        )}
        {children}
      </div>
    </MutationForm>
  );
}
