import { gatewayPublicBaseUrl, readConsoleSetupMode } from "@llmingress/config";
import { readConsoleAuthState, sessionCookieName } from "@llmingress/db/console-auth";
import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import {
  formatGatewayConfigVersion,
  formatGatewayShellStatus,
  isGatewayRuntimeHealthy,
  listConsoleGatewayRuntimeStatuses,
} from "@llmingress/db/console-runtime";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { FirstRunSetup, Login, SetupLocked } from "../_components/auth-screens";
import { Sidebar } from "../_components/sidebar";
import { Topbar } from "../_components/topbar";

// Auth guard + persistent shell for every console module. When the console is
// not initialized or the visitor is signed out, the matching auth screen is
// rendered for any module URL (so deep links still land on setup/login).
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const authState = await readConsoleAuthState(cookieStore.get(sessionCookieName)?.value);

  if (authState === "setup") {
    const setupMode = readConsoleSetupMode();
    if (setupMode.kind === "locked") {
      return <SetupLocked />;
    }
    return <FirstRunSetup requiresSetupToken={setupMode.kind === "token_required"} />;
  }
  if (authState === "login") {
    return <Login />;
  }

  const [gateways, providerHealthSummaries] = await Promise.all([
    listConsoleGatewayRuntimeStatuses(),
    listConsoleProviderHealthSummaries(),
  ]);
  const gateway = gateways[0] ?? null;
  const gatewayStatusLabel = formatGatewayShellStatus({ gateway });
  const gatewayStatusHealthy = isGatewayRuntimeHealthy({ gateway });
  const gatewayConfigVersionLabel = formatGatewayConfigVersion(
    gateway?.appliedConfigVersion ?? null,
  );
  const providerHealthyCount = providerHealthSummaries.filter(
    (summary) => summary.status === "healthy",
  ).length;
  const providerUnhealthyCount = providerHealthSummaries.filter((summary) =>
    ["auth_failed", "network_error", "quota_limited", "unhealthy"].includes(summary.status),
  ).length;

  return (
    <div className="app-shell">
      <Sidebar
        gatewayConfigVersionLabel={gatewayConfigVersionLabel}
        gatewayStatusHealthy={gatewayStatusHealthy}
        gatewayStatusLabel={gatewayStatusLabel}
        gatewayUptimeLabel={gateway ? formatUptime(gateway.startedAt) : "Unknown"}
        gatewayUrlLabel={formatRuntimeAddress(getGatewayBaseUrl())}
        providerHealthyCount={providerHealthyCount}
        providerUnhealthyCount={providerUnhealthyCount}
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

function formatUptime(startedAt: Date): string {
  const totalMinutes = Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}
