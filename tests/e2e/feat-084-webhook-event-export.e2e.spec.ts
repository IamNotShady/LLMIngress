import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { expect, test } from "@playwright/test";
import { createPostgresJobRunner } from "../../apps/worker/src/job-runner";
import { createWebhookEventExportJobHandler } from "../../apps/worker/src/webhook-export";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("webhook event export sends request fallback and error events separately from alerts", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_webhook_export_${randomUUID().replaceAll("-", "_")}`,
  });
  const webhook = await startFakeWebhookServer();
  const jobId = randomUUID();
  const now = new Date("2026-01-01T00:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const requestId = await seedWebhookExportRequestData(fixture);
    await insertWebhookExportJob(fixture, {
      jobId,
      requestIds: [requestId],
      webhookUrl: `${webhook.url}?token=sk-webhook-url-secret`,
    });

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        webhook_export: createWebhookEventExportJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
      },
      workerId: "webhook-export-worker-084",
    });

    await expect(runner.runOnce()).resolves.toBe(true);

    expect(webhook.requests.map((request) => request.eventType)).toEqual([
      "request",
      "fallback",
      "error",
    ]);
    expect(webhook.requests[0]).toMatchObject({
      eventType: "request",
      requestId,
      request: {
        agentApiKeyPrefix: "llmi_webhook84",
        model: "webhook-fast",
        routeReason: {
          authorization: "[REDACTED]",
        },
        status: "failed",
      },
    });
    expect(webhook.requests[1]).toMatchObject({
      eventType: "fallback",
      fallback: {
        attemptOrder: 1,
        errorCode: "provider_request_failed",
        errorMessage: "fallback failed with [REDACTED]",
      },
      requestId,
    });
    expect(webhook.requests[2]).toMatchObject({
      error: {
        code: "provider_request_failed",
        message: "provider failed with Bearer [REDACTED]",
      },
      eventType: "error",
      requestId,
    });
    expect(JSON.stringify(webhook.requests)).not.toContain("sk-webhook");

    await expect(readWebhookDeliveries(fixture)).resolves.toEqual([
      { event_type: "request", response_status: 204, status: "sent" },
      { event_type: "fallback", response_status: 204, status: "sent" },
      { event_type: "error", response_status: 204, status: "sent" },
    ]);
    await expect(readNotificationEventCount(fixture)).resolves.toBe(0);
    await expect(readNotificationDeliveryCount(fixture)).resolves.toBe(0);
    await expect(readJobResult(fixture, jobId)).resolves.toMatchObject({
      result: {
        delivered: 3,
        failed: 0,
        webhookExportType: "request_fallback_error_events",
      },
      status: "succeeded",
    });
    await expect(readStoredWebhookUrls(fixture)).resolves.toEqual([
      `${webhook.url}?redacted`,
      `${webhook.url}?redacted`,
      `${webhook.url}?redacted`,
    ]);
  } finally {
    await webhook.stop();
    await fixture.dispose();
  }
});

test("webhook event export sends request fallback and error events separately from alerts without duplicating sent events on retry", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_webhook_export_retry_${randomUUID().replaceAll("-", "_")}`,
  });
  const webhook = await startFakeWebhookServer({
    failFirstFallback: true,
  });
  const jobId = randomUUID();
  const now = new Date("2026-01-01T00:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const requestId = await seedWebhookExportRequestData(fixture);
    await insertWebhookExportJob(fixture, {
      jobId,
      requestIds: [requestId],
      webhookUrl: webhook.url,
    });

    const runner = createPostgresJobRunner({
      databaseUrl: fixture.databaseUrl,
      handlers: {
        webhook_export: createWebhookEventExportJobHandler({
          databaseUrl: fixture.databaseUrl,
          now: () => now,
        }),
      },
      retryBackoffMs: () => 0,
      workerId: "webhook-export-retry-worker-084",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    await expect(readJobStatus(fixture, jobId)).resolves.toBe("pending");

    await expect
      .poll(() => runner.runOnce(), {
        intervals: [10, 25, 50, 100],
        message: "webhook export retry job becomes claimable",
        timeout: 1_000,
      })
      .toBe(true);
    await expect(readJobStatus(fixture, jobId)).resolves.toBe("succeeded");

    expect(webhook.requests.map((request) => request.eventType)).toEqual([
      "request",
      "fallback",
      "error",
      "fallback",
    ]);
    await expect(readWebhookDeliveries(fixture)).resolves.toEqual([
      { event_type: "request", response_status: 204, status: "sent" },
      { event_type: "fallback", response_status: 500, status: "failed" },
      { event_type: "error", response_status: 204, status: "sent" },
      { event_type: "fallback", response_status: 204, status: "sent" },
    ]);
    await expect(readNotificationEventCount(fixture)).resolves.toBe(0);
  } finally {
    await webhook.stop();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type FakeWebhookServer = {
  requests: Array<Record<string, unknown>>;
  stop: () => Promise<void>;
  url: string;
};

type WebhookDeliveryRow = {
  event_type: string;
  response_status: number | null;
  status: string;
};

type JobRow = {
  result: unknown;
  status: string;
};

async function seedWebhookExportRequestData(fixture: Fixture): Promise<string> {
  const ids = {
    activityId: randomUUID(),
    agentApiKeyId: randomUUID(),
    agentId: randomUUID(),
    fallbackEventId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    virtualModelId: randomUUID(),
  };
  const requestId = "req_webhook_export_084";

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Webhook Export OpenAI', 'https://openai.example/v1', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, availability)
      values ($1, $2, 'gpt-4.1-mini', 'GPT 4.1 Mini', 'available')
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'webhook-fast', 'Webhook Fast', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Webhook Agent', 'coding', true)",
    [ids.agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = 'llmi_webhook84', key_hash = 'sha256:v1:webhook-secret-hash', default_virtual_model_id = $3, enabled = true, updated_at = now() where id = $2
    `,
    [ids.agentApiKeyId, ids.agentId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into request_activity (
        id,
        request_id,
        agent_id,
        virtual_model_id,
        provider_id,
        provider_model_id,
        agent_key_prefix,
        protocol,
        model,
        stream,
        route_reason,
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
        $1, $2, $3, $4, $5, $6, 'llmi_webhook84', 'chat_completions',
        'webhook-fast', false,
        $7::jsonb,
        $8::jsonb,
        'failed',
        'provider_request_failed',
        'provider failed with Bearer sk-webhook-error-secret',
        502,
        1234,
        '2026-01-01T00:00:00.000Z'::timestamptz,
        '2026-01-01T00:00:02.000Z'::timestamptz,
        '2026-01-01T00:00:00.000Z'::timestamptz
      )
    `,
    [
      ids.activityId,
      requestId,
      ids.agentApiKeyId,
      ids.virtualModelId,
      ids.providerId,
      ids.providerModelId,
      JSON.stringify({
        authorization: "Bearer sk-webhook-route-secret",
        selected: "fallback",
      }),
      JSON.stringify([{ authorization: "Bearer sk-webhook-attempt-secret" }]),
    ],
  );
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
        failed_before_first_byte,
        created_at
      )
      values (
        $1, $2, $3, 1, 'failed', 'provider_request_failed',
        'fallback failed with sk-webhook-fallback-secret', true,
        '2026-01-01T00:00:01.000Z'::timestamptz
      )
    `,
    [ids.fallbackEventId, ids.activityId, ids.providerModelId],
  );

  return requestId;
}

async function insertWebhookExportJob(
  fixture: Fixture,
  input: { jobId: string; requestIds: string[]; webhookUrl: string },
): Promise<void> {
  await fixture.query(
    `
      insert into jobs (id, job_type, status, trigger, payload, max_attempts)
      values ($1, 'webhook_export', 'pending', 'manual', $2::jsonb, 2)
    `,
    [
      input.jobId,
      JSON.stringify({
        requestIds: input.requestIds,
        webhookUrl: input.webhookUrl,
      }),
    ],
  );
}

async function readWebhookDeliveries(fixture: Fixture): Promise<WebhookDeliveryRow[]> {
  const result = await fixture.query<WebhookDeliveryRow>(
    `
      select event_type, status, response_status
      from webhook_deliveries
      order by created_at, event_type
    `,
  );
  return result.rows;
}

async function readStoredWebhookUrls(fixture: Fixture): Promise<string[]> {
  const result = await fixture.query<{ webhook_url: string }>(
    `
      select webhook_url
      from webhook_deliveries
      order by created_at, event_type
    `,
  );
  return result.rows.map((row) => row.webhook_url);
}

async function readNotificationEventCount(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: string }>("select count(*) from notification_events");
  return Number(result.rows[0]?.count ?? "0");
}

async function readNotificationDeliveryCount(fixture: Fixture): Promise<number> {
  const result = await fixture.query<{ count: string }>(
    "select count(*) from notification_deliveries",
  );
  return Number(result.rows[0]?.count ?? "0");
}

async function readJobResult(fixture: Fixture, jobId: string): Promise<JobRow | null> {
  const result = await fixture.query<JobRow>("select status, result from jobs where id = $1", [
    jobId,
  ]);
  return result.rows[0] ?? null;
}

async function readJobStatus(fixture: Fixture, jobId: string): Promise<string | null> {
  const result = await fixture.query<{ status: string }>("select status from jobs where id = $1", [
    jobId,
  ]);
  return result.rows[0]?.status ?? null;
}

async function startFakeWebhookServer(
  options: { failFirstFallback?: boolean } = {},
): Promise<FakeWebhookServer> {
  const requests: Array<Record<string, unknown>> = [];
  let failedFallback = false;
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readRequestJson(request);
    requests.push(body);
    if (options.failFirstFallback && body.eventType === "fallback" && !failedFallback) {
      failedFallback = true;
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "temporary fallback failure" }));
      return;
    }
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
    url: `http://127.0.0.1:${address.port}/events`,
  };
}

async function readRequestJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}
