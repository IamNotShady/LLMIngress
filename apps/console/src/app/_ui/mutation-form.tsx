"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { announceToast, type ConsoleToast } from "./toast";

/**
 * Posts a console action and keeps its failure on screen. A plain form post
 * would replace the page with the API's JSON error body; here the request asks
 * for JSON, and a refusal — a provider still used by a route, a name that is
 * already taken — is rendered where the operator was working.
 */
/** The path a followed redirect landed on, or null if it stayed where it was. */
function redirectTarget(response: Response): string | null {
  if (!response.redirected) {
    return null;
  }
  try {
    const url = new URL(response.url);
    const here = `${window.location.pathname}${window.location.search}`;
    const there = `${url.pathname}${url.search}`;
    return there === here ? null : there;
  } catch {
    return null;
  }
}

export function MutationForm({
  action,
  children,
  className,
  fallbackError,
  formId,
  invalidFieldOnError,
  onSuccessHref,
}: {
  action: string;
  children: ReactNode;
  className?: string;
  fallbackError: string;
  /** Set when something outside the form submits it — see the device poller. */
  formId?: string;
  /**
   * Field the refusal is usually about — a name collision, a malformed value.
   * It is marked aria-invalid so the message and the box to fix are connected
   * for anyone who cannot see the banner above the form.
   */
  invalidFieldOnError?: string;
  onSuccessHref?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Which field was refused is the server's answer to give: a refusal carries
  // details.field, and marking the one this form happens to lead with puts the
  // ring around a value nobody complained about.
  const markField = (form: HTMLFormElement, invalid: boolean, refusedField?: string) => {
    for (const name of new Set([invalidFieldOnError, refusedField].filter(Boolean))) {
      const field = form.elements.namedItem(name as string);
      if (field instanceof HTMLElement) {
        field.setAttribute("aria-invalid", invalid ? "true" : "false");
      }
    }
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(null);
    markField(form, false);
    try {
      const response = await fetch(action, {
        body: new FormData(form),
        headers: { accept: "application/json" },
        method: "POST",
        redirect: "follow",
      });
      if (response.ok || response.redirected) {
        const answer = response.redirected
          ? null
          : ((await response.json().catch(() => null)) as {
              redirectTo?: string;
              toast?: ConsoleToast;
            } | null);
        if (answer?.toast) {
          announceToast(answer.toast);
        }
        // Where to land, in order of authority: what the caller asked for, what
        // the action's answer names, then where it redirected to. Actions that
        // only report — a queued probe, a refresh — name nothing, and the URL
        // the operator is looking at stays exactly as it was.
        const landing = onSuccessHref ?? answer?.redirectTo ?? redirectTarget(response);
        if (landing) {
          router.push(landing);
        }
        router.refresh();
        return;
      }
      const payload = (await response.json().catch(() => null)) as {
        details?: { field?: unknown };
        error?: string;
      } | null;
      setError(payload?.error ?? fallbackError);
      const refused = payload?.details?.field;
      markField(form, true, typeof refused === "string" ? refused : undefined);
    } catch {
      setError(fallbackError);
      markField(form, true);
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      id={formId}
      action={action}
      method="post"
      onSubmit={onSubmit}
      className={`min-w-0 ${className ?? ""}`}
    >
      {error ? (
        <p
          role="alert"
          className="mb-3 max-w-full break-words rounded-xs border border-ambbd bg-ambbg px-[10px] py-2 font-mono text-13 text-redtx [overflow-wrap:anywhere]"
        >
          {error}
        </p>
      ) : null}
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
    </form>
  );
}
