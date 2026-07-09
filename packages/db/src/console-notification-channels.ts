import { randomUUID } from "node:crypto";
import { PostgresClient, type PostgresQueryResultRow } from "@llmingress/db/client";
import { type NotificationChannelType, notificationChannelTypes } from "@llmingress/domain";

export type { NotificationChannelType };
export { notificationChannelTypes };

export type WebhookNotificationChannelConfig = {
  url: string;
};

export type NotificationChannelConfig = WebhookNotificationChannelConfig;

export type NotificationChannelFormInput = {
  channelType?: string | null;
  displayName?: string | null;
  enabled?: boolean | string | null;
  webhookUrl?: string | null;
};

export type NormalizedNotificationChannelFormInput = {
  channelType: NotificationChannelType;
  config: NotificationChannelConfig;
  displayName: string;
  enabled: boolean;
};

export type ConsoleNotificationChannel = NormalizedNotificationChannelFormInput & {
  createdAt: Date;
  id: string;
  updatedAt: Date;
};

type NotificationChannelRow = PostgresQueryResultRow & {
  channel_type: NotificationChannelType;
  config: unknown;
  created_at: Date;
  display_name: string;
  enabled: boolean;
  id: string;
  updated_at: Date;
};

export function normalizeNotificationChannelFormInput(
  input: NotificationChannelFormInput,
): NormalizedNotificationChannelFormInput {
  const channelType = normalizeChannelType(input.channelType);
  const displayName = normalizeRequiredText(input.displayName, "Notification channel name");
  const enabled = normalizeEnabled(input.enabled);

  return {
    channelType,
    config: channelConfigNormalizers[channelType](input),
    displayName,
    enabled,
  };
}

export async function listNotificationChannels(
  databaseUrl?: string,
): Promise<ConsoleNotificationChannel[]> {
  return withClient(databaseUrl, async (client) => {
    const result = await client.query<NotificationChannelRow>(
      `
        select id::text,
               channel_type,
               display_name,
               enabled,
               config,
               created_at,
               updated_at
        from notification_channels
        where channel_type = any($1::text[])
        order by channel_type, display_name
      `,
      [[...notificationChannelTypes]],
    );
    return result.rows.map(rowToConsoleNotificationChannel);
  });
}

export async function createNotificationChannel(input: {
  channel: NormalizedNotificationChannelFormInput;
  databaseUrl?: string;
}): Promise<ConsoleNotificationChannel> {
  const channelId = randomUUID();

  return withClient(input.databaseUrl, async (client) => {
    const result = await client.query<NotificationChannelRow>(
      `
        insert into notification_channels (
          id,
          channel_type,
          display_name,
          enabled,
          config
        )
        values ($1, $2, $3, $4, $5::jsonb)
        returning id::text,
                  channel_type,
                  display_name,
                  enabled,
                  config,
                  created_at,
                  updated_at
      `,
      [
        channelId,
        input.channel.channelType,
        input.channel.displayName,
        input.channel.enabled,
        JSON.stringify(input.channel.config),
      ],
    );
    return rowToConsoleNotificationChannel(requireRow(result.rows[0]));
  });
}

function rowToConsoleNotificationChannel(row: NotificationChannelRow): ConsoleNotificationChannel {
  return {
    channelType: row.channel_type,
    config: row.config as NotificationChannelConfig,
    createdAt: row.created_at,
    displayName: row.display_name,
    enabled: row.enabled,
    id: row.id,
    updatedAt: row.updated_at,
  };
}

const channelConfigNormalizers: Record<
  NotificationChannelType,
  (input: NotificationChannelFormInput) => NotificationChannelConfig
> = {
  webhook: (input) => ({ url: normalizeWebhookUrl(input.webhookUrl) }),
};

function normalizeChannelType(value: string | null | undefined): NotificationChannelType {
  const normalized = value?.trim().toLowerCase() ?? "";
  if ((notificationChannelTypes as readonly string[]).includes(normalized)) {
    return normalized as NotificationChannelType;
  }
  throw new Error(
    `Notification channel type must be one of: ${notificationChannelTypes.join(", ")}.`,
  );
}

function normalizeEnabled(value: boolean | string | null | undefined): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "false" || normalized === "0" || normalized === "off") {
      return false;
    }
  }
  return true;
}

function normalizeRequiredText(value: string | null | undefined, label: string): string {
  const text = value?.trim();
  if (!text) {
    throw new Error(`${label} is required.`);
  }
  return text;
}

function normalizeWebhookUrl(value: string | null | undefined): string {
  const rawUrl = normalizeRequiredText(value, "Webhook URL");
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Webhook URL must be a valid URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Webhook URL must use http or https.");
  }

  return url.toString();
}

function requireRow<T>(row: T | undefined): T {
  if (!row) {
    throw new Error("Notification channel was not saved.");
  }
  return row;
}

async function withClient<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresClient) => Promise<T>,
): Promise<T> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}
