"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";

/**
 * Posts a console action and keeps its failure on screen. A plain form post
 * would replace the page with the API's JSON error body; here the request asks
 * for JSON, and a refusal — a provider still used by a route, a name that is
 * already taken — is rendered where the operator was working.
 */
export function MutationForm({
  action,
  children,
  className,
  fallbackError,
  onSuccessHref,
}: {
  action: string;
  children: ReactNode;
  className?: string;
  fallbackError: string;
  onSuccessHref?: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    setError(null);
    try {
      const response = await fetch(action, {
        body: new FormData(form),
        headers: { accept: "application/json" },
        method: "POST",
        redirect: "follow",
      });
      if (response.ok || response.redirected) {
        if (onSuccessHref) {
          router.push(onSuccessHref);
        }
        router.refresh();
        return;
      }
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(payload?.error ?? fallbackError);
    } catch {
      setError(fallbackError);
    } finally {
      setPending(false);
    }
  };

  return (
    <form action={action} method="post" onSubmit={onSubmit} className={className}>
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
