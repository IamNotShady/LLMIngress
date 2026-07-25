import Link from "next/link";
import type { ReactNode } from "react";

type ButtonTone = "danger" | "primary" | "secondary";

const toneClass: Record<ButtonTone, string> = {
  primary: "bg-seg text-segfg",
  secondary: "border border-btnbd bg-btnbg text-ink",
  danger: "border border-btnbd bg-btnbg text-redtx",
};

const buttonBase =
  "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-xs font-mono text-13 font-medium disabled:cursor-not-allowed disabled:opacity-50";

export function ActionButton({
  children,
  className = "",
  disabled,
  name,
  onClick,
  tone = "secondary",
  type = "submit",
  value,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  name?: string;
  onClick?: () => void;
  tone?: ButtonTone;
  type?: "button" | "submit";
  value?: string;
}) {
  return (
    <button
      type={type === "submit" ? "submit" : "button"}
      name={name}
      value={value}
      disabled={disabled}
      onClick={onClick}
      className={`${buttonBase} ${toneClass[tone]} px-[10px] py-1 ${className}`}
    >
      {children}
    </button>
  );
}

export function ActionLink({
  children,
  className = "",
  href,
  id,
  tone = "secondary",
}: {
  children: ReactNode;
  className?: string;
  href: string;
  id?: string;
  tone?: ButtonTone;
}) {
  return (
    <Link
      id={id}
      href={href}
      className={`${buttonBase} ${toneClass[tone]} px-3 py-[5px] ${className}`}
    >
      {children}
    </Link>
  );
}

/** Compact button used inside table rows. */
export function RowActionButton({
  children,
  name,
  tone = "secondary",
  value,
}: {
  children: ReactNode;
  name?: string;
  tone?: ButtonTone;
  value?: string;
}) {
  return (
    <ActionButton className="px-2 py-[2px]" name={name} tone={tone} value={value}>
      {children}
    </ActionButton>
  );
}

const inputClass =
  "w-full box-border rounded-xs border border-btnbd bg-btnbg px-2 py-[6px] font-mono text-135 text-ink";

/**
 * Labelled form control. Every non self-explanatory field gets one line of hint
 * text underneath — RPM/TPM/CONCURRENCY are never left as bare abbreviations.
 */
export function Field({
  children,
  hint,
  label,
  labelNote,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
  labelNote?: string;
}) {
  return (
    <>
      {/* biome-ignore lint/a11y/noLabelWithoutControl: the control arrives as children and is wrapped by this label, which associates the two implicitly. */}
      <label className="block min-w-0">
        <span className="block font-mono text-115 font-medium tracking-[.08em] text-dim">
          {label}
          {labelNote ? <span className="text-faint"> {labelNote}</span> : null}
        </span>
        <span className="mt-[5px] block">{children}</span>
        {hint ? (
          <span className="mt-1 block font-mono text-115 leading-[1.5] text-faint">{hint}</span>
        ) : null}
      </label>
    </>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className = "", ...rest } = props;
  return <input {...rest} className={`${inputClass} ${className}`} />;
}

export function SelectInput(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  const { children, className = "", ...rest } = props;
  return (
    <select {...rest} className={`${inputClass} ${className}`}>
      {children}
    </select>
  );
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const { className = "", ...rest } = props;
  return <textarea {...rest} className={`${inputClass} resize-y px-2 py-[7px] ${className}`} />;
}

/** Small filter control that sits in a toolbar rather than a form column. */
export const filterControlClass =
  "min-w-0 rounded-xs border border-btnbd bg-btnbg px-2 py-1 font-mono text-13 text-ink";

export function StatusDot({ tone }: { tone: "amber" | "dim" | "green" | "red" }) {
  const background =
    tone === "green"
      ? "bg-green"
      : tone === "amber"
        ? "bg-amber"
        : tone === "red"
          ? "bg-red"
          : "bg-dim";
  return <span className={`size-[6px] flex-none rounded-full ${background}`} />;
}

/** Horizontal meter. Balance-style quota entries render without one. */
export function Meter({
  className = "",
  fillClassName = "bg-accent",
  height = 7,
  ratio,
}: {
  className?: string;
  fillClassName?: string;
  height?: number;
  ratio: number;
}) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return (
    <span className={`block bg-track ${className}`} style={{ height }}>
      <span
        className={`block h-full ${fillClassName}`}
        style={{ width: `${(clamped * 100).toFixed(2)}%` }}
      />
    </span>
  );
}
