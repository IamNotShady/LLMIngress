import { cookies } from "next/headers";
import { getConsoleDatabaseUrl, readConsoleAuthState, sessionCookieName } from "../server/auth";

export default async function Home() {
  const cookieStore = await cookies();
  const authState = await readConsoleAuthState(
    getConsoleDatabaseUrl(),
    cookieStore.get(sessionCookieName)?.value,
  );

  if (authState === "setup") {
    return (
      <main className="auth-page">
        <section className="auth-panel" aria-labelledby="setup-title">
          <p className="eyebrow">LLMIngress</p>
          <h1 id="setup-title">First run setup</h1>
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

  if (authState === "login") {
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

  return (
    <main className="console-page">
      <header className="topbar">
        <div>
          <p className="eyebrow">LLMIngress</p>
          <h1>Dashboard</h1>
        </div>
        <form action="/api/auth/logout" method="post">
          <button className="secondary-button" type="submit">
            Sign out
          </button>
        </form>
      </header>
      <section className="status-band" aria-label="Console status">
        <p>Signed in as admin</p>
      </section>
    </main>
  );
}
