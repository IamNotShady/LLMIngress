"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";

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

  const markField = (form: HTMLFormElement, invalid: boolean) => {
    if (!invalidFieldOnError) {
      return;
    }
    const field = form.elements.namedItem(invalidFieldOnError);
    if (field instanceof HTMLElement) {
      field.setAttribute("aria-invalid", invalid ? "true" : "false");
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
        // Where to land, in order of authority: what the caller asked for, what
        // the action's answer names, then where it redirected to. Several
        // actions land somewhere carrying state the operator now needs — an
        // authorization url, a toast, the key they just saved — and refreshing
        // in place would lose it.
        const answer = response.redirected
          ? null
          : ((await response.json().catch(() => null)) as { redirectTo?: string } | null);
        const landing = onSuccessHref ?? answer?.redirectTo ?? redirectTarget(response);
        if (landing) {
          router.push(landing);
        }
        router.refresh();
        return;
      }
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(payload?.error ?? fallbackError);
      markField(form, true);
    } catch {
      setError(fallbackError);
      markField(form, true);
    } finally {
      setPending(false);
    }
  };

  return (
    <form id={formId} action={action} method="post" onSubmit={onSubmit} className={className}>
      {error ? (
        <p
          role="alert"
          className="mb-3 rounded-xs border border-ambbd bg-ambbg px-[10px] py-2 font-mono text-13 text-redtx"
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
