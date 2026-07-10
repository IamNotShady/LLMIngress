import { randomUUID } from "node:crypto";
import { PostgresClient } from "@llmingress/db/client";
import { type NotificationChannelType, notificationChannelTypes } from "@llmingress/domain";
import { JOB_CREATED_CHANNEL, type JobHandler } from "./worker-job-runner.ts";
import { sendWorkerWebhookRequest } from "./worker-webhook-transport.ts";

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
  notificationLeaseMs?: number;
  now?: () => Date;
  retryBackoffMs?: (input: { attemptNumber: number; eventId: string }) => number;
  transports?: Partial<Record<NotificationChannelType, NotificationTransport>>;
};

export type NotificationDeliveryTransportInput = {
  channelConfig: unknown;
  channelType: NotificationChannelType;
  payload: NotificationDeliveryPayload;
  signal?: AbortSignal;
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

type ContinuationNotificationEventRow = {
  id: string;
  run_after: Date | string;
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
const defaultNotificationLeaseMs = 30_000;

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
  const notificationLeaseMs = options.notificationLeaseMs ?? defaultNotificationLeaseMs;
  const retryBackoffMs = options.retryBackoffMs ?? defaultRetryBackoffMs;
  const transports: Record<NotificationChannelType, NotificationTransport> = {
    webhook: options.transports?.webhook ?? options.deliverWebhook ?? defaultDeliverWebhook,
  };

  return async (job) => {
    const claimedAt = now();
    const jobEventIds =
      readNotificationJobEventIds(job.payload) ??
      (await readLegacyDueNotificationEventIds({
        databaseUrl: options.databaseUrl,
        limit: maxBatchSize,
        now: claimedAt,
      }));
    const events = await claimDueNotificationEvents({
      databaseUrl: options.databaseUrl,
      eventIds: jobEventIds,
      limit: maxBatchSize,
      now: claimedAt,
      owner: job.workerId,
      leaseMs: notificationLeaseMs,
    });
    const summary = {
      failed: 0,
      processed: 0,
      retrying: 0,
      sent: 0,
      trigger: job.trigger,
    };

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
        signal: job.signal,
        transports,
      });
      const completedAt = now();
      const retryAt = resolveRetryAt({
        completedAt,
        event,
        result,
        retryBackoffMs,
      });

      const recorded = await recordNotificationDelivery({
        completedAt,
        databaseUrl: options.databaseUrl,
        event,
        owner: job.workerId,
        result,
        retryAt,
      });

      if (!recorded) {
        continue;
      }

      if (result.status === "sent") {
        summary.sent += 1;
      } else if (retryAt) {
        summary.retrying += 1;
      } else {
        summary.failed += 1;
      }
    }

    const continuation = await readNotificationContinuation({
      databaseUrl: options.databaseUrl,
      eventIds: jobEventIds,
      now: now(),
    });
    if (continuation) {
      await withClient(options.databaseUrl, async (client) => {
        await enqueueNotificationDispatchJob(client, {
          eventIds: continuation.eventIds,
          jobId: randomUUID(),
          runAfter: continuation.runAfter,
          source: "notification_continuation",
        });
      });
    }

    return summary;
  };
}

function readNotificationJobEventIds(payload: unknown): string[] | null {
  const object = readObject(payload);
  if (!Array.isArray(object.eventIds)) {
    return null;
  }

  const eventIds = object.eventIds.filter((value): value is string => typeof value === "string");
  return eventIds.length > 0 ? [...new Set(eventIds)] : [];
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
    source: "notification_continuation" | "notification_queue" | "notification_retry";
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
  eventIds: string[];
  limit: number;
  leaseMs: number;
  now: Date;
  owner: string;
}): Promise<ClaimedNotificationEvent[]> {
  if (input.eventIds.length === 0) {
    return [];
  }

  return withClient(input.databaseUrl, async (client) => {
    await client.query("begin");

    try {
      await recoverExpiredNotificationDeliveries(client, input.now);
      const result = await client.query<ClaimedNotificationEventRow>(
        `
          with due as (
            select notification_events.id
            from notification_events
            join notification_channels on notification_channels.id = notification_events.channel_id
            where notification_channels.enabled = true
              and notification_channels.channel_type = any($3::text[])
              and notification_events.id = any($4::uuid[])
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
                delivery_owner = $5,
                delivery_expires_at = $1::timestamptz + ($6::integer * interval '1 millisecond'),
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
        [
          input.now.toISOString(),
          input.limit,
          [...notificationChannelTypes],
          input.eventIds,
          input.owner,
          input.leaseMs,
        ],
      );
      await client.query("commit");
      return result.rows.map(rowToClaimedNotificationEvent);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  });
}

async function recoverExpiredNotificationDeliveries(
  client: PostgresClient,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const expired = await client.query<{ attempt_count: number; id: string; max_attempts: number }>(
    `
      select id::text, attempt_count, max_attempts
      from notification_events
      where status = 'sending'
        and (delivery_expires_at is null or delivery_expires_at <= $1::timestamptz)
      order by delivery_expires_at nulls first, updated_at, id
      limit 100
      for update skip locked
    `,
    [nowIso],
  );

  if (expired.rows.length === 0) {
    return;
  }

  const retryEventIds = expired.rows
    .filter((event) => event.attempt_count < event.max_attempts)
    .map((event) => event.id);
  const failedEventIds = expired.rows
    .filter((event) => event.attempt_count >= event.max_attempts)
    .map((event) => event.id);

  if (retryEventIds.length > 0) {
    await client.query(
      `
        update notification_events
        set status = 'retrying',
            next_attempt_at = $2::timestamptz,
            last_error_code = 'notification_lease_expired',
            last_error_message = 'Notification delivery lease expired before completion.',
            delivery_owner = null,
            delivery_expires_at = null,
            updated_at = $2::timestamptz
        where id = any($1::uuid[])
      `,
      [retryEventIds, nowIso],
    );
  }

  if (failedEventIds.length > 0) {
    await client.query(
      `
        update notification_events
        set status = 'failed',
            last_error_code = 'notification_lease_expired',
            last_error_message = 'Notification delivery lease expired before completion.',
            delivery_owner = null,
            delivery_expires_at = null,
            updated_at = $2::timestamptz
        where id = any($1::uuid[])
      `,
      [failedEventIds, nowIso],
    );
  }
}

async function readLegacyDueNotificationEventIds(input: {
  databaseUrl?: string;
  limit: number;
  now: Date;
}): Promise<string[]> {
  return withClient(input.databaseUrl, async (client) => {
    const result = await client.query<{ id: string }>(
      `
        select notification_events.id::text as id
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
      `,
      [input.now.toISOString(), input.limit, [...notificationChannelTypes]],
    );
    return result.rows.map((row) => row.id);
  });
}

async function readNotificationContinuation(input: {
  databaseUrl?: string;
  eventIds: string[];
  now: Date;
}): Promise<{ eventIds: string[]; runAfter: Date } | null> {
  if (input.eventIds.length === 0) {
    return null;
  }

  return withClient(input.databaseUrl, async (client) => {
    const result = await client.query<ContinuationNotificationEventRow>(
      `
        select id::text,
               case
                 when status in ('queued', 'retrying') then next_attempt_at
                 when status = 'sending' then coalesce(delivery_expires_at, $2::timestamptz)
                 else $2::timestamptz
               end as run_after
        from notification_events
        where id = any($1::uuid[])
          and status in ('queued', 'retrying', 'sending')
        order by array_position($1::uuid[], id)
      `,
      [input.eventIds, input.now.toISOString()],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return {
      eventIds: result.rows.map((row) => row.id),
      runAfter: result.rows
        .map((row) => new Date(row.run_after))
        .reduce((earliest, value) => (value < earliest ? value : earliest)),
    };
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
  owner: string;
  result: NotificationDeliveryResult;
  retryAt: Date | null;
}): Promise<boolean> {
  return await withClient(input.databaseUrl, async (client) => {
    const result = await client.query(
      `
        update notification_events
        set status = $2,
            next_attempt_at = coalesce($3::timestamptz, next_attempt_at),
            sent_at = case when $2 = 'sent' then $4::timestamptz else sent_at end,
            last_error_code = $5,
            last_error_message = $6,
            delivery_owner = null,
            delivery_expires_at = null,
            updated_at = $4::timestamptz
        where id = $1
          and status = 'sending'
          and delivery_owner = $7
          and attempt_count = $8
      `,
      [
        input.event.id,
        readNextEventStatus(input.result, input.retryAt),
        input.retryAt?.toISOString() ?? null,
        input.completedAt.toISOString(),
        input.result.status === "failed" ? input.result.errorCode : null,
        input.result.status === "failed" ? input.result.errorMessage : null,
        input.owner,
        input.event.attemptNumber,
      ],
    );
    return result.rowCount === 1;
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
  signal?: AbortSignal;
  transports: Record<NotificationChannelType, NotificationTransport>;
}): Promise<NotificationDeliveryResult> {
  try {
    const transport = input.transports[input.event.channelType];
    return await transport({
      channelConfig: input.event.channelConfig,
      channelType: input.event.channelType,
      payload: input.payload,
      signal: input.signal,
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

  return sendWorkerWebhookRequest({
    body: input.payload,
    idempotencyKey: input.payload.eventId,
    signal: input.signal,
    url,
  });
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
