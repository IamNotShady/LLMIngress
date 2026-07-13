import { PostgresClient } from "@llmingress/db/client";
import type { GatewayConfigRuntime } from "./gateway-config-reload.ts";

export type GatewayHealthStatus = "degraded" | "ok" | "unavailable";

export type GatewayHealthResponse = {
  body: {
    configLoadedAt: string | null;
    configVersion: number | null;
    service: "gateway";
    status: GatewayHealthStatus;
  };
  statusCode: 200 | 503;
};

type GatewayHealthConfigRuntime = Pick<GatewayConfigRuntime, "getReadinessStatus" | "getSnapshot">;

export async function readGatewayHealthStatus(input: {
  checkDatabase?: () => Promise<boolean>;
  configRuntime?: GatewayHealthConfigRuntime;
  databaseUrl?: string;
  timeoutMs?: number;
}): Promise<GatewayHealthResponse> {
  const readiness = input.configRuntime?.getReadinessStatus();
  const snapshot = input.configRuntime?.getSnapshot();
  const databaseReady = await (
    input.checkDatabase ?? (() => checkPostgresReadiness(input.databaseUrl, input.timeoutMs))
  )();
  const configReady = readiness?.hasLoadedSnapshot === true;
  const status: GatewayHealthStatus =
    !databaseReady || !configReady ? "unavailable" : readiness.lastReloadFailed ? "degraded" : "ok";

  return {
    body: {
      configLoadedAt: configReady && snapshot ? snapshot.loadedAt.toISOString() : null,
      configVersion: configReady && snapshot ? snapshot.version : null,
      service: "gateway",
      status,
    },
    statusCode: status === "unavailable" ? 503 : 200,
  };
}

async function checkPostgresReadiness(
  databaseUrl: string | undefined,
  timeoutMs = 1_000,
): Promise<boolean> {
  const client = new PostgresClient({
    ...(databaseUrl ? { connectionString: databaseUrl } : {}),
    connectionTimeoutMillis: timeoutMs,
    query_timeout: timeoutMs,
    statement_timeout: timeoutMs,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}
