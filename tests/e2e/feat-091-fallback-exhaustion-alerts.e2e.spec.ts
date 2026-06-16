import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import {
  createNotificationChannel,
  normalizeNotificationChannelFormInput,
} from "../../apps/console/src/server/notification-channels";
import { createFallbackExhaustionAlertsJobHandler } from "../../apps/worker/src/fallback-exhaustion-alerts";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createNotificationDispatchJobHandler } from "../../apps/worker/src/notification-dispatcher";
import { createPostgresPeriodicScheduler } from "../../apps/worker/src/periodic-scheduler";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("scheduled fallback exhaustion evaluator detects exhausted chains and notifies with activity context", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_fallback_exhaustion_${randomUUID().replaceAll("-", "_")}`,
  });
  const webhook = await startFakeWebhookServer();
  const now = new Date("2026-06-16T00:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const ids = await seedFallbackExhaustionData(fixture);
    await createNotificationChannel({
      channel: normalizeNotificationChannelFormInput({
        channelType: "email",
        displayName: "Fallback Email",
        emailFrom: "alerts@llmingress.local",
        emailTo: "owner@example.com",
      }),
      databaseUrl: fixture.databaseUrl,
    });
    await createNotificationChannel({
      channel: normalizeNotificationChannelFormInput({
        channelType: "webhook",
        displayName: "Fallback Webhook",
        webhookUrl: webhook.url,
      }),
      databaseUrl: fixture.databaseUrl,
    });

    const scheduler = createPostgresPeriodicScheduler({
      databaseUrl: fixture.databaseUrl,
      now: () => now,
      tasks: [
        {
          id: "fallback-exhaustion-alerts",
          intervalMs: 5 * 60 * 1000,
          jobType: "fallback_exhaustion_alerts",
          maxAttempts: 1,
          payload: { windowMs: 15 * 60 * 1000 },
          priority: -5,
          startAt: new Date("2026-06-16T00:00:00.000Z"),
        },
      ],
    });
    await expect(scheduler.runOnce()).resolves.toEqual({
      createdJobs: 1,
      deduplicatedJobs: 0,
      skippedTasks: 0,
    });

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        fallback_exhaustion_alerts: createFallbackExhaustionAlertsJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
        notification_dispatch: createNotificationDispatchJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
      },
      now: () => now,
      workerId: "fallback-exhaustion-alert-worker-091",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readFallbackExhaustionAlertJob(fixture)).resolves.toMatchObject({
      result: {
        evaluatedFailedRequestCount: 2,
        notificationEventCount: 2,
        queuedAlertCount: 1,
        windowMs: 15 * 60 * 1000,
      },
      status: "succeeded",
      trigger: "scheduled",
    });
    await expect(readNotificationEvents(fixture)).resolves.toEqual([
      { channel_type: "email", event_type: "fallback_exhaustion", status: "queued" },
      { channel_type: "webhook", event_type: "fallback_exhaustion", status: "queued" },
    ]);

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readNotificationEvents(fixture)).resolves.toEqual([
      { channel_type: "email", event_type: "fallback_exhaustion", status: "sent" },
      { channel_type: "webhook", event_type: "fallback_exhaustion", status: "sent" },
    ]);
    expect(webhook.requests).toHaveLength(1);
    expect(webhook.requests[0]).toMatchObject({
      eventType: "fallback_exhaustion",
      payload: {
        activityId: ids.exhaustedActivityId,
        fallbackEventCount: 2,
        requestId: "req_fallback_exhausted_091",
        status: "failed",
      },
      subject: "Fallback exhaustion warning",
    });
    expect(JSON.stringify(webhook.requests[0])).not.toContain("sk-");
  } finally {
    await webhook.stop();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type FallbackExhaustionSeedIds = {
  exhaustedActivityId: string;
};

type FallbackExhaustionAlertJobRow = {
  result: unknown;
  status: string;
  trigger: string;
};

type NotificationEventRow = {
  channel_type: string;
  event_type: string;
  status: string;
};

type WebhookRequest = {
  eventType?: string;
  payload?: Record<string, unknown>;
  subject?: string;
  [key: string]: unknown;
};

type FakeWebhookServer = {
  requests: WebhookRequest[];
  stop: () => Promise<void>;
  url: string;
};

async function seedFallbackExhaustionData(fixture: Fixture): Promise<FallbackExhaustionSeedIds> {
  const ids = {
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    exhaustedActivityId: randomUUID(),
    failedNoFallbackActivityId: randomUUID(),
    failedProviderId: randomUUID(),
    failedProviderModelId: randomUUID(),
    secondProviderId: randomUUID(),
    secondProviderModelId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'fallback-failed-one', 'Fallback Failed One', 'https://fallback-one.example/v1', true),
             ($2, 'api_key', 'fallback-failed-two', 'Fallback Failed Two', 'https://fallback-two.example/v1', true)
    `,
    [ids.failedProviderId, ids.secondProviderId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'fallback-failed-one-model', 'Fallback Failed One Model', 'available'),
             ($3, $4, 'fallback-failed-two-model', 'Fallback Failed Two Model', 'available')
    `,
    [
      ids.failedProviderModelId,
      ids.failedProviderId,
      ids.secondProviderModelId,
      ids.secondProviderId,
    ],
  );
  await fixture.query(
    "insert into virtual_models (id, name, display_name, enabled) values ($1, 'fallback-alerts-fast', 'Fallback Alerts Fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Fallback Alerts Agent', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      insert into agent_api_keys (id, agent_id, key_prefix, key_hash, default_virtual_model_id, enabled)
      values ($1, $2, 'llmi_fb_091', 'sha256:v1:fallback-alert-091', $3, true)
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );
  await insertFailedActivity(fixture, {
    activityId: ids.exhaustedActivityId,
    agentApiKeyId: ids.agentApiKeyId,
    fallbackAttempts: [
      {
        attemptOrder: 1,
        errorCode: "provider_request_failed",
        providerModelId: ids.failedProviderModelId,
      },
      {
        attemptOrder: 2,
        errorCode: "provider_request_failed",
        providerModelId: ids.secondProviderModelId,
      },
    ],
    requestId: "req_fallback_exhausted_091",
    virtualModelId: ids.virtualModelId,
  });
  await insertFailedActivity(fixture, {
    activityId: ids.failedNoFallbackActivityId,
    agentApiKeyId: ids.agentApiKeyId,
    fallbackAttempts: [],
    requestId: "req_provider_failed_no_fallback_091",
    virtualModelId: ids.virtualModelId,
  });
  await insertFallbackEvent(fixture, {
    activityId: ids.exhaustedActivityId,
    attemptOrder: 1,
    providerModelId: ids.failedProviderModelId,
  });
  await insertFallbackEvent(fixture, {
    activityId: ids.exhaustedActivityId,
    attemptOrder: 2,
    providerModelId: ids.secondProviderModelId,
  });

  return { exhaustedActivityId: ids.exhaustedActivityId };
}

async function insertFailedActivity(
  fixture: Fixture,
  input: {
    activityId: string;
    agentApiKeyId: string;
    fallbackAttempts: unknown[];
    requestId: string;
    virtualModelId: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_api_key_id,
        virtual_model_id,
        agent_api_key_prefix,
        protocol,
        model,
        stream,
        fallback_attempts,
        status,
        error_code,
        error_message,
        http_status,
        latency_ms,
        started_at,
        completed_at,
        created_at
      )
      values (
        $1,
        $2,
        $3,
        $4,
        'llmi_fb_091',
        'chat_completions',
        'fallback-alerts-fast',
        false,
        $5::jsonb,
        'failed',
        'provider_request_failed',
        'All fallback candidates failed.',
        502,
        10,
        '2026-06-15T23:59:00.000Z'::timestamptz,
        '2026-06-15T23:59:01.000Z'::timestamptz,
        '2026-06-15T23:59:00.000Z'::timestamptz
      )
    `,
    [
      input.activityId,
      input.requestId,
      input.agentApiKeyId,
      input.virtualModelId,
      JSON.stringify(input.fallbackAttempts),
    ],
  );
}

async function insertFallbackEvent(
  fixture: Fixture,
  input: {
    activityId: string;
    attemptOrder: number;
    providerModelId: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into fallback_events (
        id,
        request_activity_id,
        provider_model_id,
        attempt_order,
        status,
        error_code,
        error_message,
        failed_before_first_byte
      )
      values ($1, $2, $3, $4, 'failed', 'provider_request_failed', 'Provider failed.', true)
    `,
    [randomUUID(), input.activityId, input.providerModelId, input.attemptOrder],
  );
}

async function readFallbackExhaustionAlertJob(
  fixture: Fixture,
): Promise<FallbackExhaustionAlertJobRow | null> {
  const result = await fixture.query<FallbackExhaustionAlertJobRow>(
    `
      select status, trigger, result
      from jobs
      where job_type = 'fallback_exhaustion_alerts'
      order by updated_at desc, id desc
      limit 1
    `,
  );
  return result.rows[0] ?? null;
}

async function readNotificationEvents(fixture: Fixture): Promise<NotificationEventRow[]> {
  const result = await fixture.query<NotificationEventRow>(
    `
      select notification_channels.channel_type,
             notification_events.event_type,
             notification_events.status
      from notification_events
      join notification_channels on notification_channels.id = notification_events.channel_id
      order by notification_channels.channel_type, notification_events.created_at
    `,
  );
  return result.rows;
}

async function startFakeWebhookServer(): Promise<FakeWebhookServer> {
  const requests: WebhookRequest[] = [];
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    requests.push(await readRequestJson(request));
    response.writeHead(204);
    response.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to allocate fake webhook port.");
  }

  return {
    requests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    url: `http://127.0.0.1:${address.port}/notify`,
  };
}

async function readRequestJson(request: IncomingMessage): Promise<WebhookRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as WebhookRequest;
}
