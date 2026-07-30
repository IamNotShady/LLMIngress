"use client";

import type { ReactNode } from "react";
import { useRef, useState } from "react";

// Auth screens carry no navigation and no fixed footer — the console is not
// usable yet, so the only chrome is the brand line and the same runtime status
// string the footer shows once you are in.

const INPUT_CLASS =
  "block h-10 w-full box-border rounded-sm border border-btnbd bg-btnbg px-[10px] font-mono text-135 text-ink";
const LABEL_CLASS = "block font-mono text-11 font-medium tracking-[.08em] text-dim";
const SUBMIT_CLASS =
  "mt-6 block h-10 w-full cursor-pointer rounded-sm bg-seg font-mono text-135 font-medium text-segfg disabled:cursor-not-allowed disabled:opacity-50";

function AuthFrame({ children, statusLine }: { children: ReactNode; statusLine: string }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-bg px-8">
      <div className="flex items-baseline gap-[9px]">
        <span className="font-sans text-25 font-semibold tracking-[-.02em] text-ink">
          LLMIngress
        </span>
        <span className="font-mono text-11 tracking-[.14em] text-dim">CONSOLE</span>
      </div>
      <section className="mt-7 w-[420px] max-w-full rounded-sm border border-hair p-7">
        {children}
      </section>
      <p className="mt-5 font-mono text-11 text-faint">{statusLine}</p>
    </main>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="mb-3 rounded-xs border border-ambbd bg-ambbg px-[10px] py-2 font-mono text-13 text-redtx"
    >
      {message}
    </p>
  );
}

/** Submits as a normal form post but surfaces the API's error text in-panel. */
function useAuthSubmit(action: string, fallback: string) {
  const formRef = useRef<HTMLFormElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
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
        window.location.assign("/");
        return;
      }
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      setError(payload?.error ?? fallback);
    } catch {
      setError(fallback);
    } finally {
      setPending(false);
    }
  };

  return { error, formRef, onSubmit, pending };
}

export function Login({ statusLine }: { statusLine: string }) {
  const { error, formRef, onSubmit, pending } = useAuthSubmit("/api/auth/login", "Login failed.");

  return (
    <AuthFrame statusLine={statusLine}>
      <h1 className="font-sans text-17 font-semibold text-ink">Sign in</h1>
      <p className="mt-2 font-mono text-13 leading-[1.6] text-dim">
        Console access only — the gateway keeps serving traffic.
      </p>
      <form
        ref={formRef}
        action="/api/auth/login"
        method="post"
        onSubmit={onSubmit}
        className="mt-7"
      >
        {error ? <ErrorBanner message={error} /> : null}
        <label htmlFor="login-password" className={LABEL_CLASS}>
          PASSWORD
        </label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          // biome-ignore lint/a11y/noAutofocus: the panel exists only to take this password
          autoFocus
          required
          aria-label="Admin password"
          className={`${INPUT_CLASS} mt-[6px]`}
        />
        <button type="submit" disabled={pending} className={SUBMIT_CLASS}>
          Sign in
        </button>
      </form>
    </AuthFrame>
  );
}

export function FirstRunSetup({ statusLine }: { statusLine: string }) {
  const { error, formRef, onSubmit, pending } = useAuthSubmit(
    "/api/auth/setup",
    "Failed to create admin.",
  );
  const [mismatch, setMismatch] = useState(false);

  return (
    <AuthFrame statusLine={statusLine}>
      <h1 className="font-sans text-17 font-semibold text-ink">Create the console admin</h1>
      <p className="mt-2 font-mono text-13 leading-[1.6] text-dim">
        This password protects the console only. It is stored hashed and cannot be recovered.
      </p>
      <form
        ref={formRef}
        action="/api/auth/setup"
        method="post"
        className="mt-7"
        onSubmit={(event) => {
          const form = event.currentTarget;
          const password = new FormData(form).get("password");
          const confirmation = new FormData(form).get("passwordConfirmation");
          if (password !== confirmation) {
            event.preventDefault();
            setMismatch(true);
            return;
          }
          setMismatch(false);
          onSubmit(event);
        }}
      >
        {mismatch ? <ErrorBanner message="The two passwords do not match." /> : null}
        {error ? <ErrorBanner message={error} /> : null}
        <label htmlFor="setup-password" className={LABEL_CLASS}>
          PASSWORD
        </label>
        <input
          id="setup-password"
          name="password"
          type="password"
          autoComplete="new-password"
          // biome-ignore lint/a11y/noAutofocus: the panel exists only to take this password
          autoFocus
          minLength={8}
          required
          aria-label="Admin password"
          className={`${INPUT_CLASS} mt-[6px]`}
        />
        <p className="mt-2 font-mono text-[10.5px] text-faint">at least 8 characters</p>
        <label htmlFor="setup-password-confirmation" className={`${LABEL_CLASS} mt-5`}>
          CONFIRM PASSWORD
        </label>
        <input
          id="setup-password-confirmation"
          name="passwordConfirmation"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          aria-label="Confirm admin password"
          className={`${INPUT_CLASS} mt-[6px]`}
        />
        <p className="mt-2 font-mono text-[10.5px] text-faint">both entries must match</p>
        <button type="submit" disabled={pending} className={SUBMIT_CLASS}>
          Create admin &amp; continue
        </button>
        <p className="mt-3 font-mono text-125 leading-[1.6] text-dim">
          Next: connect a provider, create a virtual model, then issue an API key.
        </p>
      </form>
    </AuthFrame>
  );
}
