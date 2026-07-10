import { PostgresClient } from "@llmingress/db/client";
import { notificationChannelTypes } from "@llmingress/domain";
import { JobHandlerError } from "./worker-job-runner.ts";

export async function countEnabledNotificationChannels(databaseUrl?: string): Promise<number> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ count: string }>(
      "select count(*)::text as count from notification_channels where enabled = true and channel_type = any($1::text[])",
      [[...notificationChannelTypes]],
    );
    return Number(result.rows[0]?.count ?? 0);
  } finally {
    await client.end();
  }
}

export async function notificationAlertAlreadyQueued(input: {
  alertKey: string;
  databaseUrl?: string;
  eventType: string;
}): Promise<boolean> {
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const result = await client.query<{ exists: boolean }>(
      `
        select exists (
          select 1
          from notification_events
          where event_type = $1
            and payload ->> 'alertKey' = $2
        ) as exists
      `,
      [input.eventType, input.alertKey],
    );
    return result.rows[0]?.exists ?? false;
  } finally {
    await client.end();
  }
}

export function readPositiveIntegerEnv(
  value: string | undefined,
  defaultValue: number,
  name: string,
): number {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function readPositiveIntegerPayload(input: {
  errorCode: string;
  label: string;
  name: string;
  value: unknown;
}): number {
  if (typeof input.value !== "number" || !Number.isInteger(input.value) || input.value <= 0) {
    throw new JobHandlerError(
      input.errorCode,
      `${input.label} payload ${input.name} must be a positive integer.`,
    );
  }
  return input.value;
}

export function readObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}
