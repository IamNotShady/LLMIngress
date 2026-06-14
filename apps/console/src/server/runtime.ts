import { Client, type QueryResultRow } from "pg";

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
};

type GatewayRuntimeRow = QueryResultRow & {
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

type RuntimeErrorRow = QueryResultRow & {
  created_at: Date;
  error_code: string;
  error_message: string;
  process_id: string | null;
  process_type: string;
  severity: string;
};

export async function getConsoleRuntimeSnapshot(
  databaseUrl: string,
): Promise<ConsoleRuntimeSnapshot> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    const [gatewayResult, errorResult] = await Promise.all([
      client.query<GatewayRuntimeRow>(
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
      ),
      client.query<RuntimeErrorRow>(
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
      ),
    ]);

    return {
      errors: errorResult.rows.map(rowToRuntimeError),
      gateways: gatewayResult.rows.map(rowToGatewayRuntimeStatus),
    };
  } finally {
    await client.end();
  }
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
