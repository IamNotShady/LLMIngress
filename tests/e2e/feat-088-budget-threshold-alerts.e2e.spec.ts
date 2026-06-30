import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createBudgetThresholdAlertsJobHandler } from "@llmingress/db/worker-budget-threshold-alerts";
import { createPostgresJobRunner } from "@llmingress/db/worker-job-runner";
import { createNotificationDispatchJobHandler } from "@llmingress/db/worker-notification-dispatcher";
import { createPostgresPeriodicScheduler } from "@llmingress/db/worker-periodic-scheduler";
import { expect, test } from "@playwright/test";
import {
  createNotificationChannel,
  normalizeNotificationChannelFormInput,
} from "../../apps/console/src/server/notification-channels";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("scheduled budget threshold evaluator uses configurable threshold and emits webhook notifications near budget limit", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_budget_alerts_${randomUUID().replaceAll("-", "_")}`,
  });
  const webhook = await startFakeWebhookServer();
  const now = new Date("2026-06-16T00:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const ids = await seedBudgetAlertData(fixture);
    await createNotificationChannel({
      channel: normalizeNotificationChannelFormInput({
        channelType: "webhook",
        displayName: "Budget Webhook",
        webhookUrl: webhook.url,
      }),
      databaseUrl: fixture.databaseUrl,
    });

    const scheduler = createPostgresPeriodicScheduler({
      databaseUrl: fixture.databaseUrl,
      now: () => now,
      tasks: [
        {
          id: "budget-threshold-alerts",
          intervalMs: 15 * 60 * 1000,
          jobType: "budget_threshold_alerts",
          maxAttempts: 1,
          payload: {
            thresholdRatios: [0.75],
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
        budget_threshold_alerts: createBudgetThresholdAlertsJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
        notification_dispatch: createNotificationDispatchJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
      },
      now: () => now,
      workerId: "budget-alert-worker-088",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readBudgetAlertJob(fixture)).resolves.toMatchObject({
      result: {
        evaluatedBudgetCount: 2,
        queuedAlertCount: 1,
        thresholdRatios: [0.75],
      },
      status: "succeeded",
      trigger: "scheduled",
    });
    await expect(readNotificationEvents(fixture)).resolves.toEqual([
      {
        channel_type: "webhook",
        event_type: "budget_threshold",
        status: "queued",
      },
    ]);

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readNotificationEvents(fixture)).resolves.toEqual([
      {
        channel_type: "webhook",
        event_type: "budget_threshold",
        status: "sent",
      },
    ]);
    expect(webhook.requests).toHaveLength(1);
    expect(webhook.requests[0]).toMatchObject({
      eventType: "budget_threshold",
      payload: {
        agentId: ids.nearBudgetAgentId,
        agentApiKeyPrefix: "llmi_ba_near",
        alertKey: `budget_threshold:${ids.nearBudgetPeriodId}:0.75`,
        budgetLimitUsd: 100,
        thresholdRatio: 0.75,
        usageRatio: 0.82,
        usedCostUsd: 82,
      },
      subject: "Budget threshold warning",
    });

    const duplicateJobId = await insertScheduledBudgetAlertJob(fixture, {
      thresholdRatios: [0.75],
    });
    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readBudgetAlertJob(fixture, duplicateJobId)).resolves.toMatchObject({
      result: {
        evaluatedBudgetCount: 2,
        notificationEventCount: 0,
        queuedAlertCount: 0,
        skippedDuplicateAlertCount: 1,
      },
      status: "succeeded",
      trigger: "scheduled",
    });
    await expect(readNotificationEvents(fixture)).resolves.toHaveLength(1);
    expect(webhook.requests).toHaveLength(1);
  } finally {
    await webhook.stop();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type BudgetAlertSeedIds = {
  nearBudgetAgentId: string;
  nearBudgetPeriodId: string;
};

type BudgetAlertJobRow = {
  result: unknown;
  status: string;
  trigger: string;
};

type NotificationEventRow = {
  channel_type: string;
  event_type: string;
  status: string;
};

type FakeWebhookServer = {
  requests: Array<Record<string, unknown>>;
  stop: () => Promise<void>;
  url: string;
};

async function seedBudgetAlertData(fixture: Fixture): Promise<BudgetAlertSeedIds> {
  const ids = {
    agentId: randomUUID(),
    belowBudgetAgentApiKeyId: randomUUID(),
    belowBudgetPeriodId: randomUUID(),
    nearBudgetAgentApiKeyId: randomUUID(),
    nearBudgetPeriodId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'budget-alerts-fast', 'Budget Alerts Fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Budget Alerts Agent', 'coding', true)",
    [ids.agentId],
  );
  await insertAgentApiKey(fixture, {
    agentApiKeyId: ids.nearBudgetAgentApiKeyId,
    agentId: ids.agentId,
    keyHash: "sha256:v1:budget-alert-near-088",
    keyPrefix: "llmi_ba_near",
    virtualModelId: ids.virtualModelId,
  });
  await insertAgentApiKey(fixture, {
    agentApiKeyId: ids.belowBudgetAgentApiKeyId,
    agentId: ids.agentId,
    keyHash: "sha256:v1:budget-alert-below-088",
    keyPrefix: "llmi_ba_low",
    virtualModelId: ids.virtualModelId,
  });
  await fixture.query(
    `
      insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, enabled)
      values ($1, $2, 'budget', 'month', 100, 'usd', true),
             ($3, $4, 'budget', 'month', 100, 'usd', true)
    `,
    [randomUUID(), ids.nearBudgetAgentApiKeyId, randomUUID(), ids.belowBudgetAgentApiKeyId],
  );
  await insertBudgetPeriod(fixture, {
    agentApiKeyId: ids.nearBudgetAgentApiKeyId,
    budgetPeriodId: ids.nearBudgetPeriodId,
    costUsedUsd: 82,
  });
  await insertBudgetPeriod(fixture, {
    agentApiKeyId: ids.belowBudgetAgentApiKeyId,
    budgetPeriodId: ids.belowBudgetPeriodId,
    costUsedUsd: 50,
  });

  return {
    nearBudgetAgentId: ids.nearBudgetAgentApiKeyId,
    nearBudgetPeriodId: ids.nearBudgetPeriodId,
  };
}

async function insertAgentApiKey(
  fixture: Fixture,
  input: {
    agentApiKeyId: string;
    agentId: string;
    keyHash: string;
    keyPrefix: string;
    virtualModelId: string;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into agents (
        id,
        name,
        agent_type,
        key_prefix,
        key_hash,
        default_virtual_model_id,
        enabled
      )
      values ($1, 'Budget Alerts Agent', 'coding', $2, $3, $4, true)
    `,
    [input.agentApiKeyId, input.keyPrefix, input.keyHash, input.virtualModelId],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [input.agentApiKeyId, input.virtualModelId],
  );
}

async function insertBudgetPeriod(
  fixture: Fixture,
  input: {
    agentApiKeyId: string;
    budgetPeriodId: string;
    costUsedUsd: number;
  },
): Promise<void> {
  await fixture.query(
    `
      insert into budget_periods (
        id,
        agent_id,
        period_type,
        period_start,
        period_end,
        tokens_used,
        cost_used_usd,
        reserved_cost_usd,
        created_at,
        updated_at
      )
      values (
        $1,
        $2,
        'month',
        '2026-06-01T00:00:00.000Z'::timestamptz,
        '2026-07-01T00:00:00.000Z'::timestamptz,
        1000,
        $3,
        0,
        '2026-06-16T11:00:00.000Z'::timestamptz,
        '2026-06-16T11:00:00.000Z'::timestamptz
      )
    `,
    [input.budgetPeriodId, input.agentApiKeyId, input.costUsedUsd],
  );
}

async function readBudgetAlertJob(
  fixture: Fixture,
  jobId?: string,
): Promise<BudgetAlertJobRow | null> {
  const result = await fixture.query<BudgetAlertJobRow>(
    `
      select status, trigger, result
      from jobs
      where job_type = 'budget_threshold_alerts'
        and ($1::uuid is null or id = $1::uuid)
      order by updated_at desc, id desc
      limit 1
    `,
    [jobId ?? null],
  );
  return result.rows[0] ?? null;
}

async function insertScheduledBudgetAlertJob(
  fixture: Fixture,
  input: {
    thresholdRatios: number[];
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
        'budget_threshold_alerts',
        'pending',
        'scheduled',
        -5,
        $2::jsonb,
        '2026-06-16T00:00:00.000Z'::timestamptz,
        1
      )
    `,
    [jobId, JSON.stringify({ thresholdRatios: input.thresholdRatios })],
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
      order by notification_channels.channel_type
    `,
  );
  return result.rows;
}

async function startFakeWebhookServer(): Promise<FakeWebhookServer> {
  const requests: Array<Record<string, unknown>> = [];
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

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}
