import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { readConsoleAuthState, sessionCookieName } from "../../server/auth";
import {
  formatGatewayConfigVersion,
  formatGatewayShellStatus,
  isGatewayRuntimeHealthy,
  listConsoleGatewayRuntimeStatuses,
} from "../../server/runtime";
import { FirstRunSetup, Login } from "../_components/auth-screens";
import { Sidebar } from "../_components/sidebar";
import { Topbar } from "../_components/topbar";

// Auth guard + persistent shell for every console module. When the console is
// not initialized or the visitor is signed out, the matching auth screen is
// rendered for any module URL (so deep links still land on setup/login).
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const authState = await readConsoleAuthState(cookieStore.get(sessionCookieName)?.value);

  if (authState === "setup") {
    return <FirstRunSetup />;
  }
  if (authState === "login") {
    return <Login />;
  }

  const gateway = (await listConsoleGatewayRuntimeStatuses())[0] ?? null;
  const gatewayStatusLabel = formatGatewayShellStatus({ gateway });
  const gatewayStatusHealthy = isGatewayRuntimeHealthy({ gateway });
  const gatewayConfigVersionLabel = formatGatewayConfigVersion(
    gateway?.appliedConfigVersion ?? null,
  );

  return (
    <div className="app-shell">
      <Sidebar
        gatewayConfigVersionLabel={gatewayConfigVersionLabel}
        gatewayStatusHealthy={gatewayStatusHealthy}
        gatewayStatusLabel={gatewayStatusLabel}
      />
      <div className="app-main">
        <Topbar
          gatewayStatusHealthy={gatewayStatusHealthy}
          gatewayStatusLabel={gatewayStatusLabel}
        />
        {children}
      </div>
    </div>
  );
}
