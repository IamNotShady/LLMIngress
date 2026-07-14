import { gatewayPublicBaseUrl } from "@llmingress/config";
import { readConsoleAuthState, sessionCookieName } from "@llmingress/db/console-auth";
import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { FirstRunSetup, Login } from "../_components/auth-screens";
import { Sidebar } from "../_components/sidebar";
import { Topbar } from "../_components/topbar";
import { countProviderAggregateHealthStatuses } from "../_lib/provider-health";

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

  const providerHealthSummaries = await listConsoleProviderHealthSummaries();
  const providerHealthCounts = countProviderAggregateHealthStatuses(providerHealthSummaries);

  return (
    <div className="app-shell">
      <Sidebar
        gatewayUrlLabel={formatRuntimeAddress(getGatewayBaseUrl())}
        providerHealthyCount={providerHealthCounts.healthy}
        providerUnhealthyCount={providerHealthCounts.unhealthy}
      />
      <div className="app-main">
        <Topbar />
        {children}
      </div>
    </div>
  );
}

function getGatewayBaseUrl(): string {
  return gatewayPublicBaseUrl();
}

function formatRuntimeAddress(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
