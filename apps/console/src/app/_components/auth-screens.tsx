// Auth screens shown by the dashboard layout when the console is not yet
// initialized (setup) or the visitor is not signed in (login). Markup mirrors
// the original inline forms so existing auth flows/tests keep working.

export function FirstRunSetup() {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="setup-title">
        <p className="eyebrow">LLMIngress</p>
        <h1 id="setup-title">First run setup</h1>
        <p className="page-description">Create the administrator password to secure the console.</p>
        <form className="form" action="/api/auth/setup" method="post">
          <label htmlFor="setup-password">Admin password</label>
          <input
            id="setup-password"
            name="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
          <button type="submit">Create admin</button>
        </form>
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
        <form className="form" action="/api/auth/login" method="post">
          <label htmlFor="login-password">Admin password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
          />
          <button type="submit">Sign in</button>
        </form>
      </section>
    </main>
  );
}
