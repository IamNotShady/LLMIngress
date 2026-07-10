import { randomUUID } from "node:crypto";
import { PostgresClient } from "@llmingress/db/client";
import { type NotificationChannelType, notificationChannelTypes } from "@llmingress/domain";
import { JOB_CREATED_CHANNEL, type JobHandler } from "./worker-job-runner.ts";

export type { NotificationChannelType };
export { notificationChannelTypes };

export type NotificationTransport = (
  input: NotificationDeliveryTransportInput,
) => Promise<NotificationDeliveryResult>;

export type NotificationDeliveryPayload = {
  body: string;
  eventId: string;
  eventType: string;
  payload: unknown;
  subject: string;
};

export type QueueNotificationEventInput = {
  channelIds?: string[];
  databaseUrl?: string;
  event: {
    body: string;
    eventType: string;
    maxAttempts?: number;
    payload?: unknown;
    subject: string;
  };
  now?: () => Date;
};

export type QueueNotificationEventResult = {
  eventIds: string[];
  jobId: string;
};

export type NotificationDispatchJobHandlerOptions = {
  databaseUrl?: string;
  deliverWebhook?: NotificationTransport;
  maxBatchSize?: number;
  now?: () => Date;
  retryBackoffMs?: (input: { attemptNumber: number; eventId: string }) => number;
  transports?: Partial<Record<NotificationChannelType, NotificationTransport>>;
};

export type NotificationDeliveryTransportInput = {
  channelConfig: unknown;
  channelType: NotificationChannelType;
  payload: NotificationDeliveryPayload;
};

export type NotificationDeliveryResult =
  | {
      responseBody?: string | null;
      responseStatus?: number | null;
      status: "sent";
    }
  | {
      errorCode: string;
      errorMessage: string;
      responseBody?: string | null;
      responseStatus?: number | null;
      status: "failed";
    };

type NotificationChannelRow = {
  channel_type: NotificationChannelType;
  id: string;
};

type ClaimedNotificationEventRow = {
  attempt_number: number;
  body: string;
  channel_config: unknown;
  channel_id: string;
  channel_type: NotificationChannelType;
  event_type: string;
  id: string;
  max_attempts: number;
  payload: unknown;
  subject: string;
};

type ClaimedNotificationEvent = {
  attemptNumber: number;
  body: string;
  channelConfig: unknown;
  channelId: string;
  channelType: NotificationChannelType;
  eventType: string;
  id: string;
  maxAttempts: number;
  payload: unknown;
  subject: string;
};

const defaultMaxBatchSize = 50;

export async function queueNotificationEvent(
  input: QueueNotificationEventInput,
): Promise<QueueNotificationEventResult> {
  const now = input.now?.() ?? new Date();
  const event = normalizeNotificationEventInput(input.event);
  const jobId = randomUUID();
  const eventIds: string[] = [];

  await withClient(input.databaseUrl, async (client) => {
    await client.query("begin");

    try {
      const channels = await readEnabledNotificationChannels(client, input.channelIds);
      if (channels.length === 0) {
        throw new Error("At least one enabled notification channel is required.");
      }

      for (const channel of channels) {
        const eventId = randomUUID();
        eventIds.push(eventId);
        await client.query(
          `
            insert into notification_events (
              id,
              channel_id,
              event_type,
              subject,
              body,
              payload,
              status,
              max_attempts,
              next_attempt_at,
              created_at,
              updated_at
            )
            values (
              $1, $2, $3, $4, $5, $6::jsonb, 'queued', $7,
              $8::timestamptz, $8::timestamptz, $8::timestamptz
            )
          `,
          [
            eventId,
            channel.id,
            event.eventType,
            event.subject,
            event.body,
            stringifyJson(event.payload),
            event.maxAttempts,
            now.toISOString(),
          ],
        );
      }

      await enqueueNotificationDispatchJob(client, {
        eventIds,
        jobId,
        runAfter: now,
        source: "notification_queue",
      });
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });

  return { eventIds, jobId };
}

export function createNotificationDispatchJobHandler(
  options: NotificationDispatchJobHandlerOptions,
): JobHandler {
  const now = options.now ?? (() => new Date());
  const maxBatchSize = options.maxBatchSize ?? defaultMaxBatchSize;
  const retryBackoffMs = options.retryBackoffMs ?? defaultRetryBackoffMs;
  const transports: Record<NotificationChannelType, NotificationTransport> = {
    webhook: options.transports?.webhook ?? options.deliverWebhook ?? defaultDeliverWebhook,
  };

  return async (job) => {
    const events = await claimDueNotificationEvents({
      databaseUrl: options.databaseUrl,
      limit: maxBatchSize,
      now: now(),
    });
    const summary = {
      failed: 0,
      processed: 0,
      retrying: 0,
      sent: 0,
      trigger: job.trigger,
    };
    const retryEventIds: string[] = [];
    let retryRunAfter: Date | null = null;

    for (const event of events) {
      summary.processed += 1;
      const payload: NotificationDeliveryPayload = {
        body: event.body,
        eventId: event.id,
        eventType: event.eventType,
        payload: event.payload,
        subject: event.subject,
      };
      const result = await deliverNotification({
        event,
        payload,
        transports,
      });
      const completedAt = now();
      const retryAt = resolveRetryAt({
        completedAt,
        event,
        result,
        retryBackoffMs,
      });

      await recordNotificationDelivery({
        completedAt,
        databaseUrl: options.databaseUrl,
        event,
        result,
        retryAt,
      });

      if (result.status === "sent") {
        summary.sent += 1;
      } else if (retryAt) {
        summary.retrying += 1;
        retryEventIds.push(event.id);
        if (!retryRunAfter || retryAt < retryRunAfter) {
          retryRunAfter = retryAt;
        }
      } else {
        summary.failed += 1;
      }
    }

    if (retryRunAfter) {
      await withClient(options.databaseUrl, async (client) => {
        await enqueueNotificationDispatchJob(client, {
          eventIds: retryEventIds,
          jobId: randomUUID(),
          runAfter: retryRunAfter,
          source: "notification_retry",
        });
      });
    }

    return summary;
  };
}

function normalizeNotificationEventInput(input: QueueNotificationEventInput["event"]) {
  const eventType = normalizeRequiredText(input.eventType, "Notification event type");
  const subject = normalizeRequiredText(input.subject, "Notification subject");
  const body = normalizeRequiredText(input.body, "Notification body");
  const maxAttempts = input.maxAttempts ?? 3;

  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("Notification maxAttempts must be a positive integer.");
  }

  return {
    body,
    eventType,
    maxAttempts,
    payload: input.payload ?? {},
    subject,
  };
}

async function readEnabledNotificationChannels(
  client: PostgresClient,
  channelIds: string[] | undefined,
): Promise<NotificationChannelRow[]> {
  if (channelIds && channelIds.length > 0) {
    const result = await client.query<NotificationChannelRow>(
      `
        select id::text, channel_type
        from notification_channels
        where enabled = true
          and channel_type = any($1::text[])
          and id = any($2::uuid[])
        order by channel_type, display_name
      `,
      [[...notificationChannelTypes], channelIds],
    );
    return result.rows;
  }

  const result = await client.query<NotificationChannelRow>(
    `
      select id::text, channel_type
      from notification_channels
      where enabled = true
        and channel_type = any($1::text[])
      order by channel_type, display_name
    `,
    [[...notificationChannelTypes]],
  );
  return result.rows;
}

async function enqueueNotificationDispatchJob(
  client: PostgresClient,
  input: {
    eventIds: string[];
    jobId: string;
    runAfter: Date;
    source: "notification_queue" | "notification_retry";
  },
): Promise<void> {
  await client.query(
    `
      insert into jobs (
        id,
        job_type,
        status,
        trigger,
        payload,
        max_attempts,
        run_after
      )
      values ($1, 'notification_dispatch', 'pending', 'system', $2::jsonb, 3, $3::timestamptz)
    `,
    [
      input.jobId,
      stringifyJson({ eventIds: input.eventIds, source: input.source }),
      input.runAfter.toISOString(),
    ],
  );
  await client.query("select pg_notify($1, $2)", [
    JOB_CREATED_CHANNEL,
    stringifyJson({ jobId: input.jobId }),
  ]);
}

async function claimDueNotificationEvents(input: {
  databaseUrl?: string;
  limit: number;
  now: Date;
}): Promise<ClaimedNotificationEvent[]> {
  return withClient(input.databaseUrl, async (client) => {
    const result = await client.query<ClaimedNotificationEventRow>(
      `
        with due as (
          select notification_events.id
          from notification_events
          join notification_channels on notification_channels.id = notification_events.channel_id
          where notification_channels.enabled = true
            and notification_channels.channel_type = any($3::text[])
            and notification_events.status in ('queued', 'retrying')
            and notification_events.next_attempt_at <= $1::timestamptz
          order by notification_events.next_attempt_at,
                   notification_events.created_at,
                   notification_events.id
          limit $2
          for update of notification_events skip locked
        ),
        updated as (
          update notification_events
          set status = 'sending',
              attempt_count = attempt_count + 1,
              updated_at = $1::timestamptz
          from due
          where notification_events.id = due.id
          returning notification_events.id::text,
                    notification_events.channel_id::text,
                    notification_events.event_type,
                    notification_events.subject,
                    notification_events.body,
                    notification_events.payload,
                    notification_events.attempt_count as attempt_number,
                    notification_events.max_attempts
        )
        select updated.id,
               updated.channel_id,
               updated.event_type,
               updated.subject,
               updated.body,
               updated.payload,
               updated.attempt_number,
               updated.max_attempts,
               notification_channels.channel_type,
               notification_channels.config as channel_config
        from updated
        join notification_channels on notification_channels.id = updated.channel_id::uuid
        order by notification_channels.channel_type, updated.id
      `,
      [input.now.toISOString(), input.limit, [...notificationChannelTypes]],
    );
    return result.rows.map(rowToClaimedNotificationEvent);
  });
}

function rowToClaimedNotificationEvent(row: ClaimedNotificationEventRow): ClaimedNotificationEvent {
  return {
    attemptNumber: row.attempt_number,
    body: row.body,
    channelConfig: row.channel_config,
    channelId: row.channel_id,
    channelType: row.channel_type,
    eventType: row.event_type,
    id: row.id,
    maxAttempts: row.max_attempts,
    payload: row.payload,
    subject: row.subject,
  };
}

async function recordNotificationDelivery(input: {
  completedAt: Date;
  databaseUrl?: string;
  event: ClaimedNotificationEvent;
  result: NotificationDeliveryResult;
  retryAt: Date | null;
}): Promise<void> {
  await withClient(input.databaseUrl, async (client) => {
    await client.query(
      `
        update notification_events
        set status = $2,
            next_attempt_at = coalesce($3::timestamptz, next_attempt_at),
            sent_at = case when $2 = 'sent' then $4::timestamptz else sent_at end,
            last_error_code = $5,
            last_error_message = $6,
            updated_at = $4::timestamptz
        where id = $1
      `,
      [
        input.event.id,
        readNextEventStatus(input.result, input.retryAt),
        input.retryAt?.toISOString() ?? null,
        input.completedAt.toISOString(),
        input.result.status === "failed" ? input.result.errorCode : null,
        input.result.status === "failed" ? input.result.errorMessage : null,
      ],
    );
  });
}

function readNextEventStatus(
  result: NotificationDeliveryResult,
  retryAt: Date | null,
): "failed" | "retrying" | "sent" {
  if (result.status === "sent") {
    return "sent";
  }
  return retryAt ? "retrying" : "failed";
}

function resolveRetryAt(input: {
  completedAt: Date;
  event: ClaimedNotificationEvent;
  result: NotificationDeliveryResult;
  retryBackoffMs: (input: { attemptNumber: number; eventId: string }) => number;
}): Date | null {
  if (input.result.status === "sent" || input.event.attemptNumber >= input.event.maxAttempts) {
    return null;
  }

  const delayMs = Math.max(
    0,
    input.retryBackoffMs({
      attemptNumber: input.event.attemptNumber,
      eventId: input.event.id,
    }),
  );
  return new Date(input.completedAt.getTime() + delayMs);
}

function defaultRetryBackoffMs(input: { attemptNumber: number }): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(0, input.attemptNumber - 1));
}

async function deliverNotification(input: {
  event: ClaimedNotificationEvent;
  payload: NotificationDeliveryPayload;
  transports: Record<NotificationChannelType, NotificationTransport>;
}): Promise<NotificationDeliveryResult> {
  try {
    const transport = input.transports[input.event.channelType];
    return await transport({
      channelConfig: input.event.channelConfig,
      channelType: input.event.channelType,
      payload: input.payload,
    });
  } catch (error) {
    return {
      errorCode: "notification_transport_failed",
      errorMessage: error instanceof Error ? error.message : "Notification transport failed.",
      responseStatus: null,
      status: "failed",
    };
  }
}

async function defaultDeliverWebhook(
  input: NotificationDeliveryTransportInput,
): Promise<NotificationDeliveryResult> {
  const url = readWebhookUrl(input.channelConfig);
  if (!url) {
    return {
      errorCode: "webhook_invalid_config",
      errorMessage: "Webhook channel is missing a valid URL.",
      responseStatus: null,
      status: "failed",
    };
  }

  try {
    const response = await fetch(url, {
      body: JSON.stringify(input.payload),
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
    const responseBody = truncateResponseBody(await response.text());

    if (response.ok) {
      return {
        responseBody,
        responseStatus: response.status,
        status: "sent",
      };
    }

    return {
      errorCode: "webhook_http_error",
      errorMessage: `Webhook returned HTTP ${response.status}.`,
      responseBody,
      responseStatus: response.status,
      status: "failed",
    };
  } catch (error) {
    return {
      errorCode: "webhook_request_failed",
      errorMessage: error instanceof Error ? error.message : "Webhook request failed.",
      responseStatus: null,
      status: "failed",
    };
  }
}

function readWebhookUrl(config: unknown): string | null {
  const object = readObject(config);
  return typeof object.url === "string" ? object.url : null;
}

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeRequiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function truncateResponseBody(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  return value.slice(0, 2_000);
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? {});
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
