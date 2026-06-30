import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { createPostgresJobRunner, JobHandlerError } from "../../apps/worker/src/job-runner";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-tracing-093";
const agentApiKey = "llmi_trace_gateway_key_093";

test("opentelemetry traces include request job provider model status without prompt key content", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_otel_tracing_${randomUUID().replaceAll("-", "_")}`,
  });
  const collector = await createFakeOtelCollector();
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedTracingGatewayRoute(fixture, {
      providerBaseUrl: `${provider.url}/v1?mode=error`,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      otlpEndpoint: collector.url,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [
            { content: "secret prompt content sk-fake-provider-tracing-093", role: "user" },
          ],
          model: "trace-coding",
          stream: false,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_otel_trace_093",
        },
        method: "POST",
      });
      expect(response.status).toBe(502);
    } finally {
      await stopGatewayProcess(gateway);
    }

    await runFailingTracedWorkerJob(fixture, collector.url);

    await expect
      .poll(() => flattenCollectedSpans(collector.payloads).map((span) => span.name), {
        timeout: 5_000,
      })
      .toEqual(
        expect.arrayContaining([
          "llmingress.gateway.request",
          "llmingress.provider.request",
          "llmingress.worker.job",
        ]),
      );

    const spans = flattenCollectedSpans(collector.payloads);
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attributes: expect.objectContaining({
            "error.code": "provider_request_failed",
            "llmingress.model": "gpt-4.1-mini",
            "llmingress.provider": "fake-openai",
            "llmingress.status": "failed",
            "request.id": "req_otel_trace_093",
          }),
          name: "llmingress.gateway.request",
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({
            "error.code": "fake_provider_error",
            "llmingress.model": "gpt-4.1-mini",
            "llmingress.provider": "fake-openai",
            "llmingress.status": "failed",
            "request.id": "req_otel_trace_093",
          }),
          name: "llmingress.provider.request",
        }),
        expect.objectContaining({
          attributes: expect.objectContaining({
            "error.code": "job_trace_failed_093",
            "job.id": expect.any(String),
            "job.type": "model_refresh",
            "llmingress.status": "failed",
          }),
          name: "llmingress.worker.job",
        }),
      ]),
    );

    const serialized = JSON.stringify(collector.payloads);
    expect(serialized).not.toContain("secret prompt content");
    expect(serialized).not.toContain(providerApiKey);
    expect(serialized).not.toContain(agentApiKey);
    expect(serialized).not.toContain("sk-job-secret-093");
  } finally {
    await collector.close();
    await provider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

type GatewayProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

type FakeOtelCollector = {
  close: () => Promise<void>;
  payloads: unknown[];
  url: string;
};

type FlattenedSpan = {
  attributes: Record<string, unknown>;
  name: string;
};

async function seedTracingGatewayRoute(
  fixture: Fixture,
  input: { providerBaseUrl: string },
): Promise<void> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'fake-openai', 'Fake OpenAI', $2, true)
    `,
    [providerId, input.providerBaseUrl],
  );
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
      values ($1, $2, $3, $4, $5)
    `,
    [
      randomUUID(),
      providerId,
      providerApiKey.slice(0, 8),
      JSON.stringify(encrypted),
      encrypted.keyId,
    ],
  );
  await fixture.query(
    `
      insert into provider_models (
        id,
        provider_id,
        model_id,
        display_name,
        context_window,
        supports_streaming,
        supports_tools,
        availability
      )
      values ($1, $2, 'gpt-4.1-mini', 'GPT 4.1 Mini', 128000, true, true, 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'trace-coding', 'Trace Coding', true)",
    [virtualModelId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order
      )
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Trace Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(agentApiKey),
      virtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2)
    `,
    [agentApiKeyId, virtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Tracing config')",
  );
}

async function runFailingTracedWorkerJob(fixture: Fixture, otlpEndpoint: string): Promise<void> {
  const previousEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const previousExporter = process.env.OTEL_TRACES_EXPORTER;
  const jobId = randomUUID();
  const runner = createPostgresJobRunner({
    databaseUrl: fixture.databaseUrl,
    handlers: {
      model_refresh: async () => {
        throw new JobHandlerError(
          "job_trace_failed_093",
          "worker failure must not leak sk-job-secret-093",
        );
      },
    },
    workerId: "worker-trace-093",
  });

  try {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = otlpEndpoint;
    process.env.OTEL_TRACES_EXPORTER = "otlp";
    await fixture.query(
      `
        insert into jobs (id, job_type, status, trigger, payload, max_attempts)
        values ($1, 'model_refresh', 'pending', 'manual', '{"apiKey":"sk-job-secret-093"}'::jsonb, 1)
      `,
      [jobId],
    );
    await runner.runOnce();
  } finally {
    await runner.stop();
    restoreEnv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", previousEndpoint);
    restoreEnv("OTEL_TRACES_EXPORTER", previousExporter);
  }
}

async function createFakeOtelCollector(): Promise<FakeOtelCollector> {
  const payloads: unknown[] = [];
  const server = createServer(async (request, response) => {
    const body = await readRequestBody(request);
    payloads.push(JSON.parse(body));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start fake OTLP collector.");
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    payloads,
    url: `http://127.0.0.1:${address.port}/v1/traces`,
  };
}

function flattenCollectedSpans(payloads: unknown[]): FlattenedSpan[] {
  const spans: FlattenedSpan[] = [];
  for (const payload of payloads) {
    if (!isRecord(payload) || !Array.isArray(payload.resourceSpans)) {
      continue;
    }
    for (const resourceSpan of payload.resourceSpans) {
      if (!isRecord(resourceSpan) || !Array.isArray(resourceSpan.scopeSpans)) {
        continue;
      }
      for (const scopeSpan of resourceSpan.scopeSpans) {
        if (!isRecord(scopeSpan) || !Array.isArray(scopeSpan.spans)) {
          continue;
        }
        for (const span of scopeSpan.spans) {
          if (!isRecord(span) || typeof span.name !== "string") {
            continue;
          }
          spans.push({
            attributes: readOtelAttributes(span.attributes),
            name: span.name,
          });
        }
      }
    }
  }
  return spans;
}

function readOtelAttributes(attributes: unknown): Record<string, unknown> {
  if (!Array.isArray(attributes)) {
    return {};
  }

  const result: Record<string, unknown> = {};
  for (const attribute of attributes) {
    if (!isRecord(attribute) || typeof attribute.key !== "string" || !isRecord(attribute.value)) {
      continue;
    }
    result[attribute.key] =
      attribute.value.stringValue ??
      attribute.value.intValue ??
      attribute.value.doubleValue ??
      attribute.value.boolValue ??
      null;
  }
  return result;
}

function startGatewayProcess(options: {
  databaseUrl: string;
  otlpEndpoint: string;
  port: number;
}): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_NOTIFICATIONS: "false",
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: "0",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: options.otlpEndpoint,
      OTEL_TRACES_EXPORTER: "otlp",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const gateway: GatewayProcess = {
    child,
    port: options.port,
    stderr: [],
    stdout: [],
  };
  child.stderr.on("data", (chunk) => gateway.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => gateway.stdout.push(String(chunk)));
  return gateway;
}

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) {
    return;
  }

  gateway.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    gateway.child.once("exit", () => resolve());
    setTimeout(() => {
      if (gateway.child.exitCode === null) {
        gateway.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}

async function waitForGateway(baseUrl: string, gateway: GatewayProcess): Promise<void> {
  await expect
    .poll(
      async () => {
        if (gateway.child.exitCode !== null) {
          return `exited:${gateway.child.exitCode}`;
        }

        try {
          const response = await fetch(`${baseUrl}/health`);
          return response.status;
        } catch {
          return "not-ready";
        }
      },
      {
        message: `Gateway did not start.\nstdout=${gateway.stdout.join("")}\nstderr=${gateway.stderr.join("")}`,
        timeout: 15_000,
      },
    )
    .toBe(200);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate TCP port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
