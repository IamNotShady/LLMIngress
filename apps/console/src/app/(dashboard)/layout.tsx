import { gatewayPublicBaseUrl, loadBootstrapRuntimeConfig } from "@llmingress/config";
import { countConsoleActivities } from "@llmingress/db/console-activity";
import { readConsoleAuthState, sessionCookieName } from "@llmingress/db/console-auth";
import { listConsoleProviderHealthSummaries } from "@llmingress/db/console-provider-health";
import { getConsoleRuntimeStatus } from "@llmingress/db/console-runtime-status";
import { loadEncryptionKey } from "@llmingress/security/encryption-key";
import { cookies } from "next/headers";
import { type ReactNode, Suspense } from "react";
import { FirstRunSetup, Login } from "../_ui/auth";
import { ConsoleFooter, consoleStatusLine } from "../_ui/footer";
import { Masthead } from "../_ui/masthead";
import { ToastHost } from "../_ui/toast";

// Auth guard + persistent shell for every console module. When the console is
// not initialized or the visitor is signed out, the matching auth screen is
// rendered for any module URL (so deep links still land on setup/login).
export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const cookieStore = await cookies();
  const authState = await readConsoleAuthState(cookieStore.get(sessionCookieName)?.value);
  const runtime = await getConsoleRuntimeStatus();
  const statusFacts = {
    encryptionReady: isEncryptionReady(),
    runtime,
    version: process.env.LLMINGRESS_VERSION?.trim() || "dev",
  };

  if (authState === "setup") {
    return <FirstRunSetup statusLine={consoleStatusLine(statusFacts)} />;
  }
  if (authState === "login") {
    return <Login statusLine={consoleStatusLine(statusFacts)} />;
  }

  const [healthSummaries, failedRequestCount] = await Promise.all([
    listConsoleProviderHealthSummaries(),
    countConsoleActivities({
      filters: { status: "failed", from: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    }),
  ]);

  return (
    <div className="min-h-screen bg-bg pb-[42px] text-ink">
      <Masthead
        gatewayAddress={formatRuntimeAddress(gatewayPublicBaseUrl())}
        unhealthyConnectionCount={
          // provider_health_summary only stores rows that are not healthy.
          healthSummaries.filter((summary) => summary.status === "unhealthy").length
        }
        failedRequestCount={failedRequestCount}
      />
      {children}
      <Suspense fallback={null}>
        <ToastHost />
      </Suspense>
      <ConsoleFooter {...statusFacts} />
    </div>
  );
}

function isEncryptionReady(): boolean {
  try {
    loadEncryptionKey(loadBootstrapRuntimeConfig().encryptionKeySource);
    return true;
  } catch {
    return false;
  }
}

function formatRuntimeAddress(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}
