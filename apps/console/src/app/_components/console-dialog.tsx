"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";

export function ConsoleDialog({
  ariaLabelledby,
  children,
  className,
  closeHref,
  initialFocus = "first-field",
  onRequestClose,
  triggerId,
}: {
  ariaLabelledby: string;
  children: ReactNode;
  className: string;
  closeHref: string;
  initialFocus?: "cancel" | "close" | "first-field";
  onRequestClose?: () => void;
  triggerId?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const requestClose = () => {
    if (onRequestClose) {
      onRequestClose();
    } else {
      router.push(closeHref);
    }
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    dialog.showModal();
    const selector =
      initialFocus === "first-field"
        ? '[data-dialog-initial-focus], input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled])'
        : initialFocus === "cancel"
          ? ".api-key-delete-cancel, .secondary-button"
          : ".secondary-button";
    dialog.querySelector<HTMLElement>(selector)?.focus();

    return () => {
      if (dialog.open) {
        dialog.close();
      }
      if (triggerId) {
        requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
      }
    };
  }, [initialFocus, triggerId]);

  return (
    <dialog
      aria-labelledby={ariaLabelledby}
      className={className}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        const target = event.target;
        const closeLink = target instanceof Element ? target.closest("a") : null;
        if (closeLink?.getAttribute("href") === closeHref) {
          event.preventDefault();
          requestClose();
        }
      }}
      onKeyDown={(event) => {
        const target = event.target;
        const closeLink = target instanceof Element ? target.closest("a") : null;
        if (event.key === "Enter" && closeLink?.getAttribute("href") === closeHref) {
          event.preventDefault();
          requestClose();
        }
      }}
      ref={dialogRef}
    >
      {children}
    </dialog>
  );
}
