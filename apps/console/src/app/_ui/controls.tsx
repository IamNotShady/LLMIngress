import Link from "next/link";
import type { ReactNode } from "react";

type ButtonTone = "danger" | "primary" | "secondary";

/**
 * Size is a prop, not something a caller pastes into className: two padding
 * utilities on one element are a conflict Tailwind resolves by stylesheet
 * order, not by the order they were written, so an override silently wins or
 * loses. That is what made a button and a link sitting in the same row render
 * at different heights.
 */
type ButtonSize = "dialog" | "default" | "row";

const toneClass: Record<ButtonTone, string> = {
  primary: "bg-seg text-segfg",
  secondary: "border border-btnbd bg-btnbg text-ink",
  danger: "border border-btnbd bg-btnbg text-redtx",
};

const sizeClass: Record<ButtonSize, string> = {
  /** Footer action of a dialog or drawer. */
  dialog: "px-[18px] py-[6px] text-135",
  /** Toolbar, detail header, anywhere a control stands on its own. */
  default: "px-3 py-[5px] text-13",
  /** Inside a table row, where the row height is the constraint. */
  row: "px-2 py-[2px] text-13",
};

const buttonBase =
  "inline-flex cursor-pointer items-center justify-center whitespace-nowrap rounded-xs font-mono font-medium disabled:cursor-not-allowed disabled:opacity-50";

export function ActionButton({
  children,
  className = "",
  disabled,
  name,
  onClick,
  size = "default",
  tone = "secondary",
  type = "submit",
  value,
}: {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  name?: string;
  onClick?: () => void;
  size?: ButtonSize;
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
      className={`${buttonBase} ${toneClass[tone]} ${sizeClass[size]} ${className}`}
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
  size = "default",
  tone = "secondary",
}: {
  children: ReactNode;
  className?: string;
  href: string;
  id?: string;
  size?: ButtonSize;
  tone?: ButtonTone;
}) {
  return (
    <Link
      id={id}
      href={href}
      className={`${buttonBase} ${toneClass[tone]} ${sizeClass[size]} ${className}`}
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
    <ActionButton name={name} size="row" tone={tone} value={value}>
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
  help,
  hint,
  label,
  labelNote,
}: {
  children: ReactNode;
  /** An explanation too long for a hint line, held behind a "?" by the label. */
  help?: string;
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
          {help ? <FieldHelp text={help} /> : null}
        </span>
        <span className="mt-[5px] block">{children}</span>
        {hint ? (
          <span className="mt-1 block font-mono text-115 leading-[1.5] text-faint">{hint}</span>
        ) : null}
      </label>
    </>
  );
}

/**
 * The "?" a Field's help hides behind. CSS only: the bubble shows while the
 * trigger is hovered or keyboard-focused, so it works in a server-rendered
 * form. A button, not a span — inside a label, only an interactive element
 * keeps a click from being forwarded to the field's own control.
 */
function FieldHelp({ text }: { text: string }) {
  return (
    <span className="group relative ml-[6px] inline-block">
      <button
        type="button"
        aria-label={text}
        className="cursor-help rounded-full border border-btnbd bg-btnbg px-[6px] py-0 font-mono text-115 leading-[1.5] text-dim"
      >
        ?
      </button>
      <span
        aria-hidden
        className="absolute left-0 top-full z-10 mt-1 hidden w-72 rounded-xs border border-rule bg-bg px-3 py-2 font-mono text-115 font-normal tracking-normal leading-[1.6] text-dim group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
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

/**
 * The button that applies a filter row. It is built from the same class as the
 * inputs beside it, because a control that sits in a line of controls has to be
 * the same height as they are — six hand-written copies of this had drifted to
 * three different sizes.
 */
export function FilterButton({
  children,
  form,
}: {
  children: ReactNode;
  /** Set when the button lives outside the form it submits. */
  form?: string;
}) {
  return (
    <button
      type="submit"
      form={form}
      className={`${filterControlClass} flex-none cursor-pointer whitespace-nowrap font-medium`}
    >
      {children}
    </button>
  );
}

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
