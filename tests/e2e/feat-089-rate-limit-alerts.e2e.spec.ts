import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import {
  createNotificationChannel,
  normalizeNotificationChannelFormInput,
} from "../../apps/console/src/server/notification-channels";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createNotificationDispatchJobHandler } from "../../apps/worker/src/notification-dispatcher";
import { createPostgresPeriodicScheduler } from "../../apps/worker/src/periodic-scheduler";
import { createRateLimitAlertsJobHandler } from "../../apps/worker/src/rate-limit-alerts";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("scheduled rate limit evaluator uses configurable window threshold detects repeated rpm tpm blocks and notifies", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_rate_limit_alerts_${randomUUID().replaceAll("-", "_")}`,
  });
  const webhook = await startFakeWebhookServer();
  const now = new Date("2026-06-16T00:00:00.000Z");
  let evaluatorNow = now;

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const ids = await seedRateLimitAlertData(fixture);
    await createNotificationChannel({
      channel: normalizeNotificationChannelFormInput({
        channelType: "webhook",
        displayName: "Rate Limit Webhook",
        webhookUrl: webhook.url,
      }),
      databaseUrl: fixture.databaseUrl,
    });

    const scheduler = createPostgresPeriodicScheduler({
      databaseUrl: fixture.databaseUrl,
      now: () => now,
      tasks: [
        {
          id: "rate-limit-alerts",
          intervalMs: 5 * 60 * 1000,
          jobType: "rate_limit_alerts",
          maxAttempts: 1,
          payload: {
            thresholdCount: 3,
            windowMs: 15 * 60 * 1000,
          },
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
          now: () => evaluatorNow,
        }),
        rate_limit_alerts: createRateLimitAlertsJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => evaluatorNow,
        }),
      },
      now: () => now,
      workerId: "rate-limit-alert-worker-089",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readRateLimitAlertJob(fixture)).resolves.toMatchObject({
      result: {
        evaluatedBlockCount: 6,
        notificationEventCount: 2,
        queuedAlertCount: 2,
        thresholdCount: 3,
        windowMs: 15 * 60 * 1000,
      },
      status: "succeeded",
      trigger: "scheduled",
    });
    await expect(readNotificationEvents(fixture)).resolves.toEqual([
      { channel_type: "webhook", event_type: "rate_limit_high_frequency", status: "queued" },
      { channel_type: "webhook", event_type: "rate_limit_high_frequency", status: "queued" },
    ]);

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readNotificationEvents(fixture)).resolves.toEqual([
      { channel_type: "webhook", event_type: "rate_limit_high_frequency", status: "sent" },
      { channel_type: "webhook", event_type: "rate_limit_high_frequency", status: "sent" },
    ]);
    expect(webhook.requests.map((request) => request.payload?.limitType).sort()).toEqual([
      "rpm",
      "tpm",
    ]);
    expect(webhook.requests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "rate_limit_high_frequency",
          payload: expect.objectContaining({
            agentId: ids.agentId,
            agentApiKeyPrefix: "llmi_rl_089",
            blockCount: 3,
            limitType: "rpm",
            thresholdCount: 3,
            windowMs: 15 * 60 * 1000,
          }),
          subject: "Rate limit high-frequency warning",
        }),
        expect.objectContaining({
          eventType: "rate_limit_high_frequency",
          payload: expect.objectContaining({
            agentId: ids.agentId,
            agentApiKeyPrefix: "llmi_rl_089",
            blockCount: 3,
            limitType: "tpm",
            thresholdCount: 3,
            windowMs: 15 * 60 * 1000,
          }),
          subject: "Rate limit high-frequency warning",
        }),
      ]),
    );
    await expect(runner.runOnce()).resolves.toBe(true);
    expect(webhook.requests).toHaveLength(2);

    evaluatorNow = new Date("2026-06-16T00:05:00.000Z");
    const duplicateJobId = await insertScheduledRateLimitAlertJob(fixture, {
      thresholdCount: 3,
      windowMs: 15 * 60 * 1000,
    });
    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readRateLimitAlertJob(fixture, duplicateJobId)).resolves.toMatchObject({
      result: {
        notificationEventCount: 0,
        queuedAlertCount: 0,
        skippedDuplicateAlertCount: 2,
      },
      status: "succeeded",
      trigger: "scheduled",
    });
    await expect(readNotificationEvents(fixture)).resolves.toHaveLength(2);
    expect(webhook.requests).toHaveLength(2);
  } finally {
    await webhook.stop();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type RateLimitAlertSeedIds = {
  agentId: string;
};

type RateLimitAlertJobRow = {
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
    limitType?: string;
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

async function seedRateLimitAlertData(fixture: Fixture): Promise<RateLimitAlertSeedIds> {
  const ids = {
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'rate-limit-alerts-fast', 'Rate Limit Alerts Fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Rate Limit Alerts Agent', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_rl_089', key_hash = 'sha256:v1:rate-limit-alert-089', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [ids.agentApiKeyId, ids.virtualModelId],
  );

  for (const [index, limitType] of [
    "rpm",
    "rpm",
    "rpm",
    "tpm",
    "tpm",
    "tpm",
    "rpm",
    "tpm",
  ].entries()) {
    await insertRateLimitBlockedActivity(fixture, {
      agentApiKeyId: ids.agentApiKeyId,
      completedAt: index < 6 ? `2026-06-15T23:5${index}:00.000Z` : "2026-06-15T23:30:00.000Z",
      limitType,
      requestId: `req_rate_limit_alert_${limitType}_${index}_089`,
      virtualModelId: ids.virtualModelId,
    });
  }

  return { agentId: ids.agentApiKeyId };
}

async function insertRateLimitBlockedActivity(
  fixture: Fixture,
  input: {
    agentApiKeyId: string;
    completedAt: string;
    limitType: string;
    requestId: string;
    virtualModelId: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
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
        'llmi_rl_089',
        'chat_completions',
        'rate-limit-alerts-fast',
        false,
        'failed',
        'rate_limit_exceeded',
        $5,
        429,
        1,
        $6::timestamptz - interval '1 second',
        $6::timestamptz,
        $6::timestamptz
      )
    `,
    [
      randomUUID(),
      input.requestId,
      input.agentApiKeyId,
      input.virtualModelId,
      `Agent API key exceeded its ${input.limitType.toUpperCase()} limit.`,
      input.completedAt,
    ],
  );
}

async function readRateLimitAlertJob(
  fixture: Fixture,
  jobId?: string,
): Promise<RateLimitAlertJobRow | null> {
  const result = await fixture.query<RateLimitAlertJobRow>(
    `
      select status, trigger, result
      from jobs
      where job_type = 'rate_limit_alerts'
        and ($1::uuid is null or id = $1::uuid)
      order by updated_at desc, id desc
      limit 1
    `,
    [jobId ?? null],
  );
  return result.rows[0] ?? null;
}

async function insertScheduledRateLimitAlertJob(
  fixture: Fixture,
  input: {
    thresholdCount: number;
    windowMs: number;
  },
): Promise<string> {
  const jobId = randomUUID();
  await fixture.query(
    `
      insert into jobs (
        id,
        job_type,
        status,
        trigger,
        priority,
        payload,
        run_after,
        max_attempts
      )
      values (
        $1,
        'rate_limit_alerts',
        'pending',
        'scheduled',
        -5,
        $2::jsonb,
        '2026-06-16T00:00:00.000Z'::timestamptz,
        1
      )
    `,
    [
      jobId,
      JSON.stringify({
        thresholdCount: input.thresholdCount,
        windowMs: input.windowMs,
      }),
    ],
  );
  return jobId;
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
  const requests: FakeWebhookServer["requests"] = [];
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
