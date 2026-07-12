// Auth screens shown by the dashboard layout when the console is not yet
// initialized (setup) or the visitor is not signed in (login). Markup mirrors
// the original inline forms so existing auth flows/tests keep working.

import { ConsoleMutationForm } from "./console-mutation-form";
import { FlatIcon } from "./flat-icon";

export function FirstRunSetup({ requiresSetupToken = false }: { requiresSetupToken?: boolean }) {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="setup-title">
        <p className="eyebrow">LLMIngress</p>
        <h1 id="setup-title">First run setup</h1>
        <p className="page-description">Create the administrator password to secure the console.</p>
        <ConsoleMutationForm
          action="/api/auth/setup"
          className="form"
          fallbackError="Failed to create admin."
        >
          <label htmlFor="setup-password">Admin password</label>
          <input
            id="setup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
          {requiresSetupToken ? (
            <>
              <label htmlFor="setup-token">Setup token</label>
              <input
                id="setup-token"
                name="setupToken"
                type="password"
                autoComplete="one-time-code"
                minLength={32}
                required
              />
            </>
          ) : null}
          <button type="submit">
            <FlatIcon name="lock" />
            <span>Create admin</span>
          </button>
        </ConsoleMutationForm>
      </section>
    </main>
  );
}

export function SetupLocked() {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="setup-locked-title">
        <p className="eyebrow">LLMIngress</p>
        <h1 id="setup-locked-title">Setup locked</h1>
        <p className="page-description">
          This Console is listening beyond loopback. Configure CONSOLE_SETUP_TOKEN with a URL-safe
          random value of at least 32 characters before creating the first administrator.
        </p>
      </section>
    </main>
  );
}

export function Login() {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="login-title">
        <p className="eyebrow">LLMIngress</p>
        <h1 id="login-title">Sign in</h1>
        <ConsoleMutationForm
          action="/api/auth/login"
          className="form"
          fallbackError="Login failed."
        >
          <label htmlFor="login-password">Admin password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <button type="submit">
            <FlatIcon name="unlock" />
            <span>Sign in</span>
          </button>
        </ConsoleMutationForm>
      </section>
    </main>
  );
}
