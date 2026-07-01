import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import {
  getConsoleActivityDetail,
  listConsoleActivities,
} from "../../apps/console/src/server/activity";
import { buildGatewayAgentApiKeyHash } from "../../packages/db/src/gateway-auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-activity-104";
const agentApiKey = "llmi_activity_detail_key_104";
const noLoggingAgentApiKey = "llmi_activity_no_logs_key_104";

test("activity filters details safe metadata and fallback timeline are persisted", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_activity_detail_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const requestIds = {
    chat: `req_activity_chat_${randomUUID()}`,
    embeddings: `req_activity_embeddings_${randomUUID()}`,
    messages: `req_activity_messages_${randomUUID()}`,
    noLogging: `req_activity_no_logs_${randomUUID()}`,
    responses: `req_activity_responses_${randomUUID()}`,
  };

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedActivityDetailGateway(fixture, {
      failedBaseUrl: `${provider.url}/v1?mode=first-byte-failure`,
      jsonBaseUrl: `${provider.url}/v1`,
      embeddingsBaseUrl: `${provider.url}/v1?mode=embeddings`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectChat(baseUrl, {
        apiKey: agentApiKey,
        model: seeded.chat.virtualModelName,
        requestId: requestIds.chat,
      });
      await expectResponses(baseUrl, {
        apiKey: agentApiKey,
        model: seeded.responses.virtualModelName,
        requestId: requestIds.responses,
      });
      await expectMessages(baseUrl, {
        apiKey: agentApiKey,
        model: seeded.messages.virtualModelName,
        requestId: requestIds.messages,
      });
      await expectEmbeddings(baseUrl, {
        apiKey: agentApiKey,
        model: seeded.embeddings.virtualModelName,
        requestId: requestIds.embeddings,
      });
      await expectChat(baseUrl, {
        apiKey: noLoggingAgentApiKey,
        model: seeded.chat.virtualModelName,
        requestId: requestIds.noLogging,
      });

      const chatDetail = await expectActivityDetail(fixture.databaseUrl, requestIds.chat);
      expect(chatDetail.activity).toMatchObject({
        protocol: "chat_completions",
        providerApiKeyPrefix: seeded.chat.successProviderApiKeyPrefix,
        providerModelId: seeded.chat.successProviderModelId,
        requestId: requestIds.chat,
        status: "succeeded",
      });
      expect(chatDetail.requestMetadata).toMatchObject({
        protocol: "chat_completions",
        stream: false,
        usesTools: false,
      });
      expect(chatDetail.responseMetadata).toMatchObject({
        providerRequestId: "fake-provider-response",
        status: "succeeded",
      });
      expect(chatDetail.fallbackEvents).toEqual([
        expect.objectContaining({
          failedBeforeFirstByte: true,
          providerApiKeyPrefix: seeded.chat.failedProviderApiKeyPrefix,
          providerModelId: seeded.chat.failedProviderModelId,
          status: "failed",
        }),
        expect.objectContaining({
          failedBeforeFirstByte: false,
          providerApiKeyPrefix: seeded.chat.successProviderApiKeyPrefix,
          providerModelId: seeded.chat.successProviderModelId,
          status: "succeeded",
        }),
      ]);

      for (const [name, requestId] of [
        ["responses", requestIds.responses],
        ["messages", requestIds.messages],
        ["embeddings", requestIds.embeddings],
      ] as const) {
        const detail = await expectActivityDetail(fixture.databaseUrl, requestId);
        const seededScenario = seeded[name];
        expect(detail.activity).toMatchObject({
          providerApiKeyPrefix: seededScenario.successProviderApiKeyPrefix,
          providerModelId: seededScenario.successProviderModelId,
          requestId,
          status: "succeeded",
        });
        expect(detail.fallbackEvents.map((event) => event.status)).toEqual(["failed", "succeeded"]);
      }

      const filteredMessages = await listConsoleActivities({
        databaseUrl: fixture.databaseUrl,
        filters: {
          protocol: "messages",
          requestId: requestIds.messages,
          status: "succeeded",
        },
        limit: 10,
        page: 1,
      });
      expect(filteredMessages.map((activity) => activity.requestId)).toEqual([requestIds.messages]);

      const noLoggingDetail = await expectActivityDetail(fixture.databaseUrl, requestIds.noLogging);
      expect(noLoggingDetail.requestMetadata).toEqual({});
      expect(noLoggingDetail.responseMetadata).toEqual({});

      const serializedDetails = JSON.stringify([
        chatDetail,
        await expectActivityDetail(fixture.databaseUrl, requestIds.responses),
        await expectActivityDetail(fixture.databaseUrl, requestIds.messages),
        await expectActivityDetail(fixture.databaseUrl, requestIds.embeddings),
      ]);
      expect(serializedDetails).not.toContain("sk-fake-provider");
      expect(serializedDetails).not.toContain("sk-prompt-secret");
      expect(serializedDetails).not.toContain("fake provider response");
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
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

type ProtocolScenario = {
  failedProviderApiKeyPrefix: string;
  failedProviderModelId: string;
  successProviderApiKeyPrefix: string;
  successProviderModelId: string;
  virtualModelName: string;
};

type SeededActivityDetailGateway = Record<
  "chat" | "embeddings" | "messages" | "responses",
  ProtocolScenario
>;

type GatewayExpectation = {
  apiKey: string;
  model: string;
  requestId: string;
};

async function seedActivityDetailGateway(
  fixture: Fixture,
  input: {
    embeddingsBaseUrl: string;
    failedBaseUrl: string;
    jsonBaseUrl: string;
  },
): Promise<SeededActivityDetailGateway> {
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const noLoggingAgentApiKeyId = randomUUID();
  const scenarios = {
    chat: {
      providerKey: "openai-chat",
      successBaseUrl: input.jsonBaseUrl,
      successModelId: "gpt-4.1-mini",
      virtualModelName: "activity-chat",
    },
    embeddings: {
      providerKey: "openai-embeddings",
      successBaseUrl: input.embeddingsBaseUrl,
      successModelId: "text-embedding-3-small",
      virtualModelName: "activity-embeddings",
    },
    messages: {
      providerKey: "anthropic-messages",
      successBaseUrl: input.jsonBaseUrl,
      successModelId: "claude-sonnet-4-5",
      virtualModelName: "activity-messages",
    },
    responses: {
      providerKey: "openai-responses",
      successBaseUrl: input.jsonBaseUrl,
      successModelId: "gpt-4.1-mini",
      virtualModelName: "activity-responses",
    },
  } as const;
  const seeded = {} as SeededActivityDetailGateway;

  await fixture.query(
    `
      insert into agents (id, name, agent_type, request_logging_enabled, enabled)
      values ($1, 'Activity Detail Agent', 'coding', true, true)
    `,
    [agentId],
  );

  for (const [name, scenario] of Object.entries(scenarios)) {
    const failedProviderId = randomUUID();
    const successProviderId = randomUUID();
    const failedProviderModelId = randomUUID();
    const successProviderModelId = randomUUID();
    const failedProviderApiKeyId = randomUUID();
    const successProviderApiKeyId = randomUUID();
    const virtualModelId = randomUUID();
    const routePolicyId = randomUUID();
    const failedPrefix = `${name}_bad104`;
    const successPrefix = `${name}_ok104`;

    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', $2, $3, $4, true),
               ($5, 'api_key', $6, $7, $8, true)
      `,
      [
        failedProviderId,
        `${scenario.providerKey}-failed-104`,
        `${name} Failed Provider 104`,
        input.failedBaseUrl,
        successProviderId,
        `${scenario.providerKey}-success-104`,
        `${name} Success Provider 104`,
        scenario.successBaseUrl,
      ],
    );
    await fixture.query(
      `
        insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id)
        values ($1, $2, $3, $4, $5),
               ($6, $7, $8, $4, $5)
      `,
      [
        failedProviderApiKeyId,
        failedProviderId,
        failedPrefix,
        JSON.stringify(encrypted),
        encrypted.keyId,
        successProviderApiKeyId,
        successProviderId,
        successPrefix,
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
          availability,
          manual_input_usd_per_million_tokens,
          manual_output_usd_per_million_tokens,
          manual_price_updated_at
        )
        values ($1, $2, $3, $4, 128000, true, true, 'available', 1, 2, now()),
               ($5, $6, $7, $8, 128000, true, true, 'available', 1, 2, now())
      `,
      [
        failedProviderModelId,
        failedProviderId,
        `${name}-failed-model-104`,
        `${name} Failed Model 104`,
        successProviderModelId,
        successProviderId,
        scenario.successModelId,
        `${name} Success Model 104`,
      ],
    );
    await fixture.query(
      "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
      [virtualModelId, scenario.virtualModelName, `${name} Activity 104`],
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
        values ($1, $2, $3, 1),
               ($4, $2, $5, 2)
      `,
      [randomUUID(), routePolicyId, failedProviderModelId, randomUUID(), successProviderModelId],
    );

    seeded[name as keyof SeededActivityDetailGateway] = {
      failedProviderApiKeyPrefix: failedPrefix,
      failedProviderModelId,
      successProviderApiKeyPrefix: successPrefix,
      successProviderModelId,
      virtualModelName: scenario.virtualModelName,
    };
  }

  await fixture.query(
    `
      update agents
      set id = $1,
          key_prefix = $3,
          key_hash = $4,
          default_virtual_model_id = $5,
          enabled = true,
          updated_at = now()
      where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      "act_detail104",
      buildGatewayAgentApiKeyHash(agentApiKey),
      await readVirtualModelId(fixture, seeded.chat.virtualModelName),
    ],
  );
  await fixture.query(
    `
      insert into agents (
        id,
        name,
        agent_type,
        request_logging_enabled,
        key_prefix,
        key_hash,
        default_virtual_model_id,
        enabled
      )
      values ($1, 'Activity No Logs Agent', 'coding', false, $2, $3, $4, true)
    `,
    [
      noLoggingAgentApiKeyId,
      "act_nolog104",
      buildGatewayAgentApiKeyHash(noLoggingAgentApiKey),
      await readVirtualModelId(fixture, seeded.chat.virtualModelName),
    ],
  );

  for (const scenario of Object.values(seeded)) {
    const virtualModelId = await readVirtualModelId(fixture, scenario.virtualModelName);
    await fixture.query(
      `
        insert into agent_virtual_models (agent_id, virtual_model_id)
        values ($1, $2),
               ($3, $2)
      `,
      [agentApiKeyId, virtualModelId, noLoggingAgentApiKeyId],
    );
  }
  await fixture.query(
    "insert into config_versions (version, source, description) values (104, 'console', 'Activity detail metadata config')",
  );

  return seeded;
}

async function readVirtualModelId(fixture: Fixture, name: string): Promise<string> {
  const result = await fixture.query<{ id: string }>(
    "select id::text from virtual_models where name = $1",
    [name],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Virtual model ${name} was not seeded.`);
  }
  return row.id;
}

async function expectChat(baseUrl: string, expectation: GatewayExpectation): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      max_tokens: 8,
      messages: [{ content: "hello sk-prompt-secret-104", role: "user" }],
      model: expectation.model,
      stream: false,
    }),
    headers: requestHeaders(expectation),
    method: "POST",
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    id: "fake-provider-response",
    object: "chat.completion",
  });
}

async function expectResponses(baseUrl: string, expectation: GatewayExpectation): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/responses`, {
    body: JSON.stringify({
      input: "hello responses sk-prompt-secret-104",
      model: expectation.model,
      stream: false,
    }),
    headers: requestHeaders(expectation),
    method: "POST",
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    id: "fake-provider-response",
    object: "response",
  });
}

async function expectMessages(baseUrl: string, expectation: GatewayExpectation): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/messages`, {
    body: JSON.stringify({
      max_tokens: 8,
      messages: [{ content: "hello messages sk-prompt-secret-104", role: "user" }],
      model: expectation.model,
      stream: false,
    }),
    headers: requestHeaders(expectation),
    method: "POST",
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    id: "fake-provider-message",
    type: "message",
  });
}

async function expectEmbeddings(baseUrl: string, expectation: GatewayExpectation): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/embeddings`, {
    body: JSON.stringify({
      input: ["hello embeddings sk-prompt-secret-104"],
      model: expectation.model,
    }),
    headers: requestHeaders(expectation),
    method: "POST",
  });
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    object: "list",
  });
}

function requestHeaders(expectation: GatewayExpectation): Record<string, string> {
  return {
    authorization: `Bearer ${expectation.apiKey}`,
    "content-type": "application/json",
    "x-request-id": expectation.requestId,
  };
}

async function expectActivityDetail(databaseUrl: string, requestId: string) {
  await expect
    .poll(() => getConsoleActivityDetail({ databaseUrl, requestId }), { timeout: 10_000 })
    .not.toBeNull();
  const detail = await getConsoleActivityDetail({ databaseUrl, requestId });
  if (!detail) {
    throw new Error(`Activity detail ${requestId} was not found.`);
  }
  return detail;
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
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

function startGatewayProcess(options: { databaseUrl: string; port: number }): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_NOTIFICATIONS: "false",
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: "0",
      GATEWAY_HOST: "127.0.0.1",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
      NODE_ENV: "test",
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

async function stopGatewayProcess(gateway: GatewayProcess): Promise<void> {
  if (gateway.child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      gateway.child.kill("SIGKILL");
      resolve();
    }, 5_000);
    gateway.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    gateway.child.kill("SIGTERM");
  });
}
