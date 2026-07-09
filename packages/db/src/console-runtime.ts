import { PostgresClient } from "@llmingress/db/client";
import {
  getMigrationStatusFromDatabase,
  type MigrationStatusSummary,
  shippedSqlMigrations,
} from "@llmingress/db/migration-status";

export type ConsoleGatewayRuntimeStatus = {
  appliedConfigVersion: number | null;
  gatewayInstanceId: string;
  heartbeatAt: Date | null;
  lastReloadAt: Date | null;
  lastReloadError: string | null;
  lastReloadStatus: string | null;
  startedAt: Date;
  status: string;
  targetConfigVersion: number | null;
  updatedAt: Date;
};

export type ConsoleRuntimeError = {
  createdAt: Date;
  errorCode: string;
  errorMessage: string;
  processId: string | null;
  processType: string;
  severity: string;
};

export type ConsoleRuntimeSnapshot = {
  errors: ConsoleRuntimeError[];
  gateways: ConsoleGatewayRuntimeStatus[];
  migrations: MigrationStatusSummary;
};

type GatewayRuntimeRow = {
  applied_config_version: number | null;
  gateway_instance_id: string;
  heartbeat_at: Date | null;
  last_reload_at: Date | null;
  last_reload_error: string | null;
  last_reload_status: string | null;
  started_at: Date;
  status: string;
  target_config_version: number | null;
  updated_at: Date;
};

type RuntimeErrorRow = {
  created_at: Date;
  error_code: string;
  error_message: string;
  process_id: string | null;
  process_type: string;
  severity: string;
};

export async function getConsoleRuntimeSnapshot(
  databaseUrl?: string,
): Promise<ConsoleRuntimeSnapshot> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const gateways = await queryConsoleGatewayRuntimeStatuses(client);
    const errorResult = await client.query<RuntimeErrorRow>(
      `
        select process_type,
               process_id,
               severity,
               error_code,
               error_message,
               created_at
        from runtime_errors
        order by created_at desc
        limit 10
      `,
    );

    const migrations = await getMigrationStatusFromDatabase({
      databaseUrl,
      migrations: shippedSqlMigrations,
    });

    return {
      errors: errorResult.rows.map(rowToRuntimeError),
      gateways,
      migrations,
    };
  } finally {
    await client.end();
  }
}

export async function listConsoleGatewayRuntimeStatuses(
  databaseUrl?: string,
): Promise<ConsoleGatewayRuntimeStatus[]> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await queryConsoleGatewayRuntimeStatuses(client);
  } finally {
    await client.end();
  }
}

export function formatGatewayConfigVersion(version: number | null): string {
  return version === null ? "No config" : String(version);
}

export function formatGatewayHeartbeatStatus(input: {
  heartbeatAt: Date | null;
  now?: Date;
  staleAfterMs?: number;
}): string {
  if (input.heartbeatAt === null) {
    return "Missing";
  }

  const now = input.now ?? new Date();
  const staleAfterMs = input.staleAfterMs ?? 60_000;
  const ageMs = now.getTime() - input.heartbeatAt.getTime();

  return ageMs <= staleAfterMs ? "Healthy" : "Stale";
}

export function formatGatewayHeartbeatSummary(input: {
  gateway: ConsoleGatewayRuntimeStatus | null;
  now?: Date;
  staleAfterMs?: number;
}): string {
  if (!input.gateway) {
    return "No gateway heartbeat recorded";
  }
  const status = formatGatewayHeartbeatStatus({
    heartbeatAt: input.gateway.heartbeatAt,
    now: input.now,
    staleAfterMs: input.staleAfterMs,
  }).toLowerCase();
  return `Heartbeat ${status}`;
}

export function formatGatewayShellStatus(input: {
  gateway: ConsoleGatewayRuntimeStatus | null;
  now?: Date;
  staleAfterMs?: number;
}): string {
  if (!input.gateway) {
    return "Gateway unknown";
  }

  const heartbeatStatus = formatGatewayHeartbeatStatus({
    heartbeatAt: input.gateway.heartbeatAt,
    now: input.now,
    staleAfterMs: input.staleAfterMs,
  });
  if (heartbeatStatus !== "Healthy") {
    return "Gateway stale";
  }
  if (input.gateway.status === "ready") {
    return "Gateway ready";
  }
  return `Gateway ${input.gateway.status}`;
}

export function isGatewayRuntimeHealthy(input: {
  gateway: ConsoleGatewayRuntimeStatus | null;
  now?: Date;
  staleAfterMs?: number;
}): boolean {
  return (
    input.gateway !== null &&
    input.gateway.status === "ready" &&
    formatGatewayHeartbeatStatus({
      heartbeatAt: input.gateway.heartbeatAt,
      now: input.now,
      staleAfterMs: input.staleAfterMs,
    }) === "Healthy"
  );
}

export function formatRuntimeReloadResult(input: {
  lastReloadAt: Date | null;
  lastReloadError: string | null;
  lastReloadStatus: string | null;
}): string {
  if (input.lastReloadStatus === null) {
    return "Reload status unavailable";
  }

  const timestamp = input.lastReloadAt ? ` at ${input.lastReloadAt.toISOString()}` : "";
  if (input.lastReloadStatus === "failed" && input.lastReloadError) {
    return `Reload failed${timestamp}: ${input.lastReloadError}`;
  }

  return `Reload ${input.lastReloadStatus}${timestamp}`;
}

export function formatRuntimeErrorEntry(input: ConsoleRuntimeError): string {
  const processLabel = input.processId
    ? `${input.processType}/${input.processId}`
    : input.processType;
  return `${input.severity} ${processLabel}: ${input.errorCode} - ${input.errorMessage} at ${input.createdAt.toISOString()}`;
}

async function queryConsoleGatewayRuntimeStatuses(
  client: PostgresClient,
): Promise<ConsoleGatewayRuntimeStatus[]> {
  const result = await client.query<GatewayRuntimeRow>(
    `
      select gateway_instance_id,
             status,
             applied_config_version,
             target_config_version,
             last_reload_status,
             last_reload_error,
             last_reload_at,
             heartbeat_at,
             started_at,
             updated_at
      from gateway_runtime_status
      order by heartbeat_at desc,
               updated_at desc
      limit 5
    `,
  );
  return result.rows.map(rowToGatewayRuntimeStatus);
}

function rowToGatewayRuntimeStatus(row: GatewayRuntimeRow): ConsoleGatewayRuntimeStatus {
  return {
    appliedConfigVersion: row.applied_config_version,
    gatewayInstanceId: row.gateway_instance_id,
    heartbeatAt: row.heartbeat_at,
    lastReloadAt: row.last_reload_at,
    lastReloadError: row.last_reload_error,
    lastReloadStatus: row.last_reload_status,
    startedAt: row.started_at,
    status: row.status,
    targetConfigVersion: row.target_config_version,
    updatedAt: row.updated_at,
  };
}

function rowToRuntimeError(row: RuntimeErrorRow): ConsoleRuntimeError {
  return {
    createdAt: row.created_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    processId: row.process_id,
    processType: row.process_type,
    severity: row.severity,
  };
}
