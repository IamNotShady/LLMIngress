"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

type DialogWidth = 460 | 480 | 520 | 600 | 720 | 900 | 980;

/**
 * Opens a native modal so the browser owns the parts that are easy to get
 * wrong: focus moves into it, Tab cannot leave it, Escape closes it, and focus
 * returns to whatever opened it. Closing is a navigation, because the open
 * state lives in the URL — that is what makes every dialog server-rendered
 * with the selected object's values.
 */
function useModalDialog(closeHref: string) {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    // Whatever was focused when the dialog rendered is what opened it — the
    // row, the ✕-less action link — and is where focus belongs afterwards.
    opener.current = document.activeElement as HTMLElement | null;
    if (!element.open) {
      element.showModal();
      // showModal focuses the first tabbable node, which is the close control.
      // A dialog opens for what it is about, so the first field takes focus.
      element.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    }
    return () => {
      element.close();
      opener.current?.focus?.();
    };
  }, []);

  const close = () => router.push(closeHref);

  return {
    /** Escape: the element stays open until the URL that holds it changes. */
    onCancel: (event: React.SyntheticEvent<HTMLDialogElement>) => {
      event.preventDefault();
      close();
    },
    /**
     * A click on the backdrop area outside the panel closes it too. Escape
     * does the same from the keyboard, so this needs no key handler of its own.
     */
    onClick: (event: React.MouseEvent<HTMLDialogElement>) => {
      if (event.target === ref.current) {
        close();
      }
    },
    onCloseClick: close,
    ref,
  };
}

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
  const modal = useModalDialog(closeHref);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard equivalent, and the browser handles it on a native modal.
    <dialog
      ref={modal.ref}
      onCancel={modal.onCancel}
      onClick={modal.onClick}
      aria-label={title}
      className="fixed inset-0 m-0 size-full max-h-none max-w-none bg-transparent p-0 text-ink"
    >
      <div
        style={{ width }}
        className={`mx-auto mt-16 max-h-[84vh] max-w-[calc(100vw-64px)] overflow-auto bg-bg px-[26px] py-[22px] ${
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
          <button
            type="button"
            onClick={modal.onCloseClick}
            aria-label="Close"
            className="ml-auto cursor-pointer border-0 bg-transparent font-mono text-17 font-medium text-dim"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </dialog>
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
  const modal = useModalDialog(closeHref);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard equivalent, and the browser handles it on a native modal.
    <dialog
      ref={modal.ref}
      onCancel={modal.onCancel}
      onClick={modal.onClick}
      aria-label={title}
      className="fixed inset-0 m-0 size-full max-h-none max-w-none bg-transparent p-0 text-ink"
    >
      <aside className="ml-auto h-full w-[520px] max-w-[calc(100vw-24px)] overflow-auto border-l border-hair bg-bg px-6 py-5 shadow-drawer">
        <div className="flex items-center gap-[10px]">
          <div className="min-w-0">
            <div className="font-sans text-17 font-semibold text-ink">{title}</div>
            {subtitle ? (
              <div className="mt-[2px] font-mono text-12 text-faint">{subtitle}</div>
            ) : null}
          </div>
          {trailing ? <span className="ml-auto flex-none">{trailing}</span> : null}
          <button
            type="button"
            onClick={modal.onCloseClick}
            aria-label="Close"
            className={`cursor-pointer border-0 bg-transparent font-mono text-17 font-medium text-dim ${
              trailing ? "ml-3" : "ml-auto"
            }`}
          >
            ✕
          </button>
        </div>
        {children}
      </aside>
    </dialog>
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
