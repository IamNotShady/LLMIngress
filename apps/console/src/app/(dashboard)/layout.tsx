import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { getConsoleDatabaseUrl, readConsoleAuthState, sessionCookieName } from "../../server/auth";
import { FirstRunSetup, Login } from "../_components/auth-screens";
import { Sidebar } from "../_components/sidebar";
import { Topbar } from "../_components/topbar";

// Auth guard + persistent shell for every console module. When the console is
// not initialized or the visitor is signed out, the matching auth screen is
// rendered for any module URL (so deep links still land on setup/login).
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const databaseUrl = getConsoleDatabaseUrl();
  const authState = await readConsoleAuthState(
    databaseUrl,
    cookieStore.get(sessionCookieName)?.value,
  );

  if (authState === "setup") {
    return <FirstRunSetup />;
  }
  if (authState === "login") {
    return <Login />;
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Topbar />
        {children}
      </div>
    </div>
  );
}
