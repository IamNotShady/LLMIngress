"use client";

import { useRouter } from "next/navigation";
import {
  type FormEventHandler,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type ConsoleErrorPayload,
  type ConsoleMutationFailure,
  toConsoleMutationFailure,
} from "./console-mutation-failure";

export function ConsoleMutationError({
  errorPresentation = "inline",
  failure,
  formRef,
  onDismiss = ignoreDismiss,
}: {
  errorPresentation?: "inline" | "toast";
  failure: ConsoleMutationFailure | null;
  formRef: RefObject<HTMLFormElement | null>;
  onDismiss?: () => void;
}) {
  const errorId = useId();
  const [fieldErrorTarget, setFieldErrorTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const form = formRef.current;
    if (!failure?.field || !form) {
      setFieldErrorTarget(null);
      return;
    }

    const field = findFormField(form, failure.field);
    if (!field) {
      setFieldErrorTarget(null);
      return;
    }

    const target = document.createElement("div");
    target.className = "console-mutation-field-error-target";
    const container = field.closest<HTMLElement>(".console-field, fieldset") ?? field.parentElement;
    if (container && container !== form) {
      container.append(target);
    } else {
      field.insertAdjacentElement("afterend", target);
    }
    const previousDescribedBy = field.getAttribute("aria-describedby");
    field.setAttribute("aria-invalid", "true");
    field.setAttribute(
      "aria-describedby",
      [previousDescribedBy, errorId].filter(Boolean).join(" "),
    );
    field.classList.add("is-invalid");
    setFieldErrorTarget(target);

    return () => {
      field.removeAttribute("aria-invalid");
      field.classList.remove("is-invalid");
      if (previousDescribedBy) {
        field.setAttribute("aria-describedby", previousDescribedBy);
      } else {
        field.removeAttribute("aria-describedby");
      }
      target.remove();
    };
  }, [errorId, failure, formRef]);

  if (!failure) {
    return null;
  }
  if (fieldErrorTarget) {
    return createPortal(
      <p className="field-error is-visible" id={errorId} role="alert">
        {failure.message}
      </p>,
      fieldErrorTarget,
    );
  }
  if (errorPresentation === "toast") {
    // Toast failures only exist after client-side interaction, but guard the
    // document read so server rendering can never touch a browser global.
    if (typeof document === "undefined") {
      return null;
    }
    return createPortal(
      <ConsoleMutationToast message={failure.message} onDismiss={onDismiss} tone="error" />,
      document.body,
    );
  }
  return (
    <p className="form-error" role="alert">
      {failure.message}
    </p>
  );
}

function ignoreDismiss() {}

export function ConsoleMutationForm({
  action,
  children,
  className,
  errorPresentation = "inline",
  fallbackError = "Console operation failed.",
  id,
  successHref,
  successMessage,
  successRefreshDelayMs,
}: {
  action: string;
  children: ReactNode;
  className?: string;
  errorPresentation?: "inline" | "toast";
  fallbackError?: string;
  id?: string;
  successHref?: string;
  successMessage?: string;
  successRefreshDelayMs?: number;
}) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [failure, setFailure] = useState<ConsoleMutationFailure | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!failure || failure.field || errorPresentation !== "toast") {
      return;
    }

    const timeout = window.setTimeout(() => setFailure(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [errorPresentation, failure]);

  useEffect(() => {
    if (!success) {
      return;
    }

    const timeout = window.setTimeout(() => setSuccess(null), 5_000);
    return () => window.clearTimeout(timeout);
  }, [success]);

  const submit: FormEventHandler<HTMLFormElement> = async (event) => {
    event.preventDefault();
    setFailure(null);
    setSuccess(null);
    setSubmitting(true);
    try {
      const form = event.currentTarget;
      const response = await fetch(action, {
        body: new FormData(form),
        credentials: "same-origin",
        headers: { accept: "application/json" },
        method: "POST",
      });
      if (!response.ok) {
        setFailure(toConsoleMutationFailure(await readErrorPayload(response), fallbackError));
        return;
      }
      if (successHref) {
        router.replace(successHref);
        return;
      }
      if (response.redirected) {
        window.location.assign(response.url);
        return;
      }
      if (successMessage) {
        setSuccess(successMessage);
      }
      if (successRefreshDelayMs && successRefreshDelayMs > 0) {
        window.setTimeout(() => router.refresh(), successRefreshDelayMs);
      } else {
        router.refresh();
      }
    } catch {
      setFailure({ message: fallbackError });
    } finally {
      setSubmitting(false);
    }
  };

  const clearFieldError: FormEventHandler<HTMLFormElement> = (event) => {
    const target = event.target;
    if (
      failure?.field &&
      (target instanceof HTMLInputElement ||
        target instanceof HTMLSelectElement ||
        target instanceof HTMLTextAreaElement) &&
      target.name === failure.field
    ) {
      setFailure(null);
    }
  };

  return (
    <form
      action={action}
      aria-busy={submitting}
      className={className}
      id={id}
      method="post"
      onInput={clearFieldError}
      onSubmit={submit}
      ref={formRef}
    >
      {children}
      <ConsoleMutationError
        errorPresentation={errorPresentation}
        failure={failure}
        formRef={formRef}
        onDismiss={() => setFailure(null)}
      />
      {success && typeof document !== "undefined"
        ? createPortal(
            <ConsoleMutationToast
              message={success}
              onDismiss={() => setSuccess(null)}
              tone="success"
            />,
            document.body,
          )
        : null}
    </form>
  );
}

export function ConsoleMutationToast({
  message,
  tone,
  onDismiss,
}: {
  message: string;
  tone: "error" | "success";
  onDismiss: () => void;
}) {
  const toastRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const toast = toastRef.current;
    if (!toast || typeof toast.showPopover !== "function") {
      return;
    }

    toast.showPopover();
    return () => {
      if (toast.matches(":popover-open")) {
        toast.hidePopover();
      }
    };
  }, []);

  const toneClass = tone === "success" ? " console-mutation-toast--success" : "";
  return (
    <div
      className={`console-mutation-toast${toneClass}`}
      popover="manual"
      ref={toastRef}
      role={tone === "success" ? "status" : "alert"}
    >
      <span>{message}</span>
      <button
        aria-label={tone === "success" ? "Dismiss message" : "Dismiss error"}
        onClick={onDismiss}
        type="button"
      >
        &times;
      </button>
    </div>
  );
}

async function readErrorPayload(response: Response): Promise<ConsoleErrorPayload> {
  try {
    return (await response.json()) as ConsoleErrorPayload;
  } catch {
    return {};
  }
}

function findFormField(form: HTMLFormElement, name: string): HTMLElement | null {
  const item = form.elements.namedItem(name);
  if (item instanceof HTMLElement) {
    return item;
  }
  if (item instanceof RadioNodeList) {
    const first = item.item(0);
    return first instanceof HTMLElement ? first : null;
  }
  return null;
}
