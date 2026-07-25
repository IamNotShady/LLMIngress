import Link from "next/link";
import type { ReactNode } from "react";

type DialogWidth = 460 | 480 | 520 | 600 | 720 | 900 | 980;

/**
 * Modal dialog. Open state lives in the URL, so every dialog is server-rendered
 * with the selected object's values and closing is a plain navigation.
 */
export function Dialog({
  children,
  closeHref,
  danger = false,
  tag,
  title,
  titleNote,
  width,
}: {
  children: ReactNode;
  closeHref: string;
  danger?: boolean;
  tag?: string;
  title: string;
  titleNote?: ReactNode;
  width: DialogWidth;
}) {
  return (
    <>
      <Link
        href={closeHref}
        aria-label="Close dialog"
        className="fixed inset-0 z-70 bg-[rgba(20,17,12,.35)]"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width }}
        className={`fixed left-1/2 top-16 z-71 max-h-[84vh] max-w-[calc(100vw-64px)] -translate-x-1/2 overflow-auto bg-bg px-[26px] py-[22px] ${
          danger ? "border border-red shadow-danger" : "border border-hair shadow-dialog"
        }`}
      >
        <div className="flex items-center gap-[10px]">
          <span className="font-sans text-18 font-semibold text-ink">{title}</span>
          {tag ? (
            <span className="rounded-xs border border-ambbd bg-ambbg px-2 py-[2px] font-mono text-12 text-redtx">
              {tag}
            </span>
          ) : null}
          {titleNote ? <span className="font-mono text-12 text-faint">{titleNote}</span> : null}
          <Link
            href={closeHref}
            aria-label="Close"
            className="ml-auto font-mono text-17 font-medium text-dim"
          >
            ✕
          </Link>
        </div>
        {children}
      </div>
    </>
  );
}

/** 520px right-hand drawer with a translucent scrim. */
export function Drawer({
  children,
  closeHref,
  subtitle,
  title,
  trailing,
}: {
  children: ReactNode;
  closeHref: string;
  subtitle?: ReactNode;
  title: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      <Link
        href={closeHref}
        aria-label="Close drawer"
        className="fixed inset-0 z-60 bg-[rgba(20,24,30,.35)]"
      />
      <aside
        aria-label={title}
        className="fixed inset-y-0 right-0 z-61 w-[520px] overflow-auto border-l border-hair bg-bg px-6 py-5 shadow-drawer"
      >
        <div className="flex items-center gap-[10px]">
          <div className="min-w-0">
            <div className="font-sans text-17 font-semibold text-ink">{title}</div>
            {subtitle ? (
              <div className="mt-[2px] font-mono text-12 text-faint">{subtitle}</div>
            ) : null}
          </div>
          {trailing ? <span className="ml-auto flex-none">{trailing}</span> : null}
          <Link
            href={closeHref}
            aria-label="Close"
            className={`font-mono text-17 font-medium text-dim ${trailing ? "ml-3" : "ml-auto"}`}
          >
            ✕
          </Link>
        </div>
        {children}
      </aside>
    </>
  );
}

/** Impact list shown inside every destructive confirm. */
export function DialogImpact({ children }: { children: ReactNode }) {
  return <div className="mt-[14px] border-t border-hair">{children}</div>;
}

export function DialogBody({ children }: { children: ReactNode }) {
  return <p className="mt-[14px] font-mono text-13 leading-[1.6] text-ink">{children}</p>;
}

export function DialogNote({ children }: { children: ReactNode }) {
  return <p className="mt-[10px] font-mono text-12 leading-[1.6] text-faint">{children}</p>;
}

export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-[18px] flex flex-wrap items-center gap-2">{children}</div>;
}
