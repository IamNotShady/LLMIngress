import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createNotificationChannel,
  normalizeNotificationChannelFormInput,
} from "@llmingress/db/console-notification-channels";
import { createPostgresJobRunner } from "@llmingress/db/worker-job-runner";
import { createNotificationDispatchJobHandler } from "@llmingress/db/worker-notification-dispatcher";
import { createPostgresPeriodicScheduler } from "@llmingress/db/worker-periodic-scheduler";
import { createProviderFailureAlertsJobHandler } from "@llmingress/db/worker-provider-failure-alerts";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("scheduled provider failure evaluator detects consecutive health failures and notifies", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_failure_alerts_${randomUUID().replaceAll("-", "_")}`,
  });
  const webhook = await startFakeWebhookServer();
  const now = new Date("2026-06-16T00:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const ids = await seedProviderFailureAlertData(fixture);
    await createNotificationChannel({
      channel: normalizeNotificationChannelFormInput({
        channelType: "webhook",
        displayName: "Provider Failure Webhook",
        webhookUrl: webhook.url,
      }),
      databaseUrl: fixture.databaseUrl,
    });

    const scheduler = createPostgresPeriodicScheduler({
      databaseUrl: fixture.databaseUrl,
      now: () => now,
      tasks: [
        {
          id: "provider-failure-alerts",
          intervalMs: 5 * 60 * 1000,
          jobType: "provider_failure_alerts",
          maxAttempts: 1,
          payload: { thresholdCount: 3 },
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
        notification_dispatch: createNotificationDispatchJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
        provider_failure_alerts: createProviderFailureAlertsJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
      },
      now: () => now,
      workerId: "provider-failure-alert-worker-090",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readProviderFailureAlertJob(fixture)).resolves.toMatchObject({
      result: {
        evaluatedSummaryCount: 3,
        notificationEventCount: 2,
        queuedAlertCount: 2,
        thresholdCount: 3,
      },
      status: "succeeded",
      trigger: "scheduled",
    });
    await expect(readNotificationEvents(fixture)).resolves.toEqual([
      { channel_type: "webhook", event_type: "provider_failure", status: "queued" },
      { channel_type: "webhook", event_type: "provider_failure", status: "queued" },
    ]);

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readNotificationEvents(fixture)).resolves.toEqual([
      { channel_type: "webhook", event_type: "provider_failure", status: "sent" },
      { channel_type: "webhook", event_type: "provider_failure", status: "sent" },
    ]);
    expect(webhook.requests.map((request) => request.payload?.scope).sort()).toEqual([
      "model",
      "provider",
    ]);
    expect(webhook.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "provider_failure",
          payload: expect.objectContaining({
            consecutiveFailures: 3,
            providerId: ids.providerLevelProviderId,
            scope: "provider",
            thresholdCount: 3,
          }),
          subject: "Provider failure warning",
        }),
        expect.objectContaining({
          eventType: "provider_failure",
          payload: expect.objectContaining({
            consecutiveFailures: 4,
            providerId: ids.modelLevelProviderId,
            providerModelId: ids.modelLevelProviderModelId,
            scope: "model",
            thresholdCount: 3,
          }),
          subject: "Provider failure warning",
        }),
      ]),
    );
  } finally {
    await webhook.stop();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type ProviderFailureAlertSeedIds = {
  modelLevelProviderId: string;
  modelLevelProviderModelId: string;
  providerLevelProviderId: string;
};

type ProviderFailureAlertJobRow = {
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
  payload?: {
    scope?: string;
    [key: string]: unknown;
  };
  subject?: string;
  [key: string]: unknown;
};

type FakeWebhookServer = {
  requests: WebhookRequest[];
  stop: () => Promise<void>;
  url: string;
};

async function seedProviderFailureAlertData(
  fixture: Fixture,
): Promise<ProviderFailureAlertSeedIds> {
  const ids = {
    belowThresholdProviderId: randomUUID(),
    modelLevelProviderId: randomUUID(),
    modelLevelProviderModelId: randomUUID(),
    providerLevelProviderId: randomUUID(),
  };

  await insertProvider(fixture, {
    providerId: ids.providerLevelProviderId,
    providerKey: "provider-alert-provider",
  });
  await insertProvider(fixture, {
    providerId: ids.modelLevelProviderId,
    providerKey: "provider-alert-model-provider",
  });
  await insertProvider(fixture, {
    providerId: ids.belowThresholdProviderId,
    providerKey: "provider-alert-below-provider",
  });
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'provider-alert-model', 'Provider Alert Model', 'available')
    `,
    [ids.modelLevelProviderModelId, ids.modelLevelProviderId],
  );
  await insertProviderHealthSummary(fixture, {
    consecutiveFailures: 3,
    providerId: ids.providerLevelProviderId,
    providerModelId: null,
    status: "unhealthy",
    summaryId: randomUUID(),
  });
  await insertProviderHealthSummary(fixture, {
    consecutiveFailures: 4,
    providerId: ids.modelLevelProviderId,
    providerModelId: ids.modelLevelProviderModelId,
    status: "unhealthy",
    summaryId: randomUUID(),
  });
  await insertProviderHealthSummary(fixture, {
    consecutiveFailures: 2,
    providerId: ids.belowThresholdProviderId,
    providerModelId: null,
    status: "auth_failed",
    summaryId: randomUUID(),
  });

  return {
    modelLevelProviderId: ids.modelLevelProviderId,
    modelLevelProviderModelId: ids.modelLevelProviderModelId,
    providerLevelProviderId: ids.providerLevelProviderId,
  };
}

async function insertProvider(
  fixture: Fixture,
  input: {
    providerId: string;
    providerKey: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', $2, $2, 'https://provider-alerts.example/v1', true)
    `,
    [input.providerId, input.providerKey],
  );
}

async function insertProviderHealthSummary(
  fixture: Fixture,
  input: {
    consecutiveFailures: number;
    providerId: string;
    providerModelId: string | null;
    status: string;
    summaryId: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into provider_health_summary (
        id,
        provider_id,
        provider_model_id,
        status,
        consecutive_failures,
        last_failure_at,
        updated_at
      )
      values (
        $1,
        $2,
        $3,
        $4,
        $5,
        '2026-06-16T00:00:00.000Z'::timestamptz,
        '2026-06-16T00:00:00.000Z'::timestamptz
      )
    `,
    [
      input.summaryId,
      input.providerId,
      input.providerModelId,
      input.status,
      input.consecutiveFailures,
    ],
  );
}

async function readProviderFailureAlertJob(
  fixture: Fixture,
): Promise<ProviderFailureAlertJobRow | null> {
  const result = await fixture.query<ProviderFailureAlertJobRow>(
    `
      select status, trigger, result
      from jobs
      where job_type = 'provider_failure_alerts'
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
