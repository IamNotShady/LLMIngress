import { randomUUID } from "node:crypto";
import { PostgresClient } from "@llmingress/db/health";

export type GatewayRuntimeStatusEvent =
  | { type: "startup"; appliedConfigVersion: number; startedAt: Date }
  | { type: "heartbeat"; appliedConfigVersion: number }
  | { type: "reload-succeeded"; appliedConfigVersion: number; targetConfigVersion: number }
  | { type: "reload-failed"; targetConfigVersion: number | null; error: string };

export type RecordGatewayRuntimeStatus = (event: GatewayRuntimeStatusEvent) => Promise<void>;

export const noopRuntimeStatusRecorder: RecordGatewayRuntimeStatus = async () => {};

export function createGatewayRuntimeStatusRecorder(options: {
  databaseUrl?: string;
  gatewayInstanceId: string;
}): RecordGatewayRuntimeStatus {
  return async (event) => {
    const client = new PostgresClient({ connectionString: options.databaseUrl });
    await client.connect();

    try {
      await writeRuntimeStatusEvent(client, options.gatewayInstanceId, event);
    } finally {
      await client.end();
    }
  };
}

async function writeRuntimeStatusEvent(
  client: PostgresClient,
  gatewayInstanceId: string,
  event: GatewayRuntimeStatusEvent,
): Promise<void> {
  switch (event.type) {
    case "startup":
      await client.query(
        `
          insert into gateway_runtime_status (
            id, gateway_instance_id, status, applied_config_version, target_config_version,
            last_reload_status, last_reload_at, heartbeat_at, started_at, updated_at
          )
          values ($1, $2, 'ready', $3, $3, 'succeeded', now(), now(), $4, now())
          on conflict (gateway_instance_id) do update set
            status = 'ready',
            applied_config_version = excluded.applied_config_version,
            target_config_version = excluded.target_config_version,
            last_reload_status = excluded.last_reload_status,
            last_reload_error = null,
            last_reload_at = excluded.last_reload_at,
            heartbeat_at = excluded.heartbeat_at,
            started_at = excluded.started_at,
            updated_at = excluded.updated_at
        `,
        [
          randomUUID(),
          gatewayInstanceId,
          toForeignKeyVersion(event.appliedConfigVersion),
          event.startedAt.toISOString(),
        ],
      );
      return;
    case "heartbeat":
      // started_at is only set on the initial insert; the conflict path never overwrites it.
      await client.query(
        `
          insert into gateway_runtime_status (
            id, gateway_instance_id, status, applied_config_version, heartbeat_at, started_at, updated_at
          )
          values ($1, $2, 'ready', $3, now(), now(), now())
          on conflict (gateway_instance_id) do update set
            status = 'ready',
            applied_config_version = excluded.applied_config_version,
            heartbeat_at = excluded.heartbeat_at,
            updated_at = excluded.updated_at
        `,
        [randomUUID(), gatewayInstanceId, toForeignKeyVersion(event.appliedConfigVersion)],
      );
      return;
    case "reload-succeeded":
      await client.query(
        `
          insert into gateway_runtime_status (
            id, gateway_instance_id, status, applied_config_version, target_config_version,
            last_reload_status, last_reload_at, heartbeat_at, started_at, updated_at
          )
          values ($1, $2, 'ready', $3, $4, 'succeeded', now(), now(), now(), now())
          on conflict (gateway_instance_id) do update set
            status = 'ready',
            applied_config_version = excluded.applied_config_version,
            target_config_version = excluded.target_config_version,
            last_reload_status = excluded.last_reload_status,
            last_reload_error = null,
            last_reload_at = excluded.last_reload_at,
            heartbeat_at = excluded.heartbeat_at,
            updated_at = excluded.updated_at
        `,
        [
          randomUUID(),
          gatewayInstanceId,
          toForeignKeyVersion(event.appliedConfigVersion),
          toForeignKeyVersion(event.targetConfigVersion),
        ],
      );
      return;
    case "reload-failed":
      // Leave applied/target config version untouched: the target version may not exist in
      // config_versions yet, and writing it would violate the foreign key.
      await client.query(
        `
          insert into gateway_runtime_status (
            id, gateway_instance_id, status, applied_config_version, target_config_version,
            last_reload_status, last_reload_error, last_reload_at, heartbeat_at, started_at, updated_at
          )
          values ($1, $2, 'degraded', null, null, 'failed', $3, now(), now(), now(), now())
          on conflict (gateway_instance_id) do update set
            status = 'degraded',
            last_reload_status = 'failed',
            last_reload_error = excluded.last_reload_error,
            last_reload_at = excluded.last_reload_at,
            heartbeat_at = excluded.heartbeat_at,
            updated_at = excluded.updated_at
        `,
        [randomUUID(), gatewayInstanceId, event.error],
      );
      return;
  }
}

function toForeignKeyVersion(version: number): number | null {
  // config version 0 is the empty snapshot sentinel and has no config_versions row.
  return version > 0 ? version : null;
}
