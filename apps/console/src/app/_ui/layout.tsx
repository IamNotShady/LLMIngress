import type { ReactNode } from "react";

/** 1560px content container with the 32px gutters every module shares. */
export function PageShell({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div data-screen-label={label} className="mx-auto max-w-[1560px] px-8 pb-7">
      {children}
    </div>
  );
}

export function PageTitleRow({
  actions,
  meta,
  title,
}: {
  actions?: ReactNode;
  meta?: ReactNode;
  title: string;
}) {
  return (
    <div className="flex items-center gap-4 overflow-x-auto pt-[22px]">
      <h1 className="font-sans text-25 font-semibold tracking-[-.02em] text-ink">{title}</h1>
      {meta ? <span className="font-mono text-13 text-faint">{meta}</span> : null}
      {actions ? <div className="ml-auto flex gap-2">{actions}</div> : null}
    </div>
  );
}

/** Section heading — 15.5px sans, optionally with a trailing note and link. */
export function SectionTitle({
  children,
  className = "",
  note,
  trailing,
}: {
  children: ReactNode;
  className?: string;
  note?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div className={`flex items-baseline gap-[10px] overflow-x-auto ${className}`}>
      <span className="font-sans text-155 font-semibold text-ink">{children}</span>
      {note ? <span className="font-mono text-12 text-faint">{note}</span> : null}
      {trailing ? <span className="ml-auto flex-none">{trailing}</span> : null}
    </div>
  );
}

/** Definition row used by every detail grid: dim label left, value right. */
export function DetailRow({
  clip = false,
  label,
  value,
  valueClassName = "text-ink",
}: {
  clip?: boolean;
  label: string;
  value: ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="flex justify-between gap-3 border-b border-rule2 py-[7px] font-mono text-13">
      <span className="flex-none text-dim">{label}</span>
      <span className={`${valueClassName} ${clip ? "cell-clip" : ""}`}>{value}</span>
    </div>
  );
}

export function EmptyState({
  actions,
  body,
  title,
}: {
  actions?: ReactNode;
  body: string;
  title: string;
}) {
  return (
    <div className="mt-4 border-t border-hair py-14 text-center">
      <h2 className="font-sans text-17 font-semibold text-ink">{title}</h2>
      <p className="mx-auto mt-2 max-w-[560px] font-mono text-13 leading-[1.7] text-dim">{body}</p>
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

const skeletonWidths = [
  ["30%", "22%", "12%"],
  ["24%", "28%", "9%"],
  ["34%", "18%", "14%"],
  ["27%", "25%", "11%"],
  ["31%", "20%", "13%"],
  ["22%", "30%", "10%"],
];

export function LoadingRows({ note }: { note: string }) {
  return (
    <div className="mt-4 border-t border-hair">
      {skeletonWidths.map((widths) => (
        <div
          key={widths.join()}
          className="flex items-center gap-[14px] border-b border-rule2 py-[13px]"
        >
          <div className="h-[11px] rounded-xs bg-track" style={{ width: widths[0] }} />
          <div className="h-[11px] rounded-xs bg-track" style={{ width: widths[1] }} />
          <div className="ml-auto h-[11px] rounded-xs bg-track" style={{ width: widths[2] }} />
        </div>
      ))}
      <div className="py-3 font-mono text-125 text-faint">{note}</div>
    </div>
  );
}
