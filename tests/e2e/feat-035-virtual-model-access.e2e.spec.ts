import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-vm-access-035";

test("models list allowed names disallowed post returns 403 missing model uses default or returns 400", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_access_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const allowedKey = "llmi_allowed_gateway_vm_key_035";
  const noDefaultKey = "llmi_no_default_gateway_vm_key_035";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedVirtualModelAccess(fixture, {
      allowedKey,
      noDefaultKey,
      providerBaseUrl: `${provider.url}/v1`,
    });

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      await expectAllowedModels(baseUrl, allowedKey, ["coding-fast", "coding-strong"]);
      await expectGatewayPost(baseUrl, {
        apiKey: allowedKey,
        expectedCode: "virtual_model_not_allowed",
        model: "blocked-model",
        requestId: "req_blocked_035",
        status: 403,
      });
      await expectGatewayPost(baseUrl, {
        apiKey: allowedKey,
        requestId: "req_default_035",
        status: 200,
      });
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]?.bodyJson).toMatchObject({
        messages: [{ content: "hello", role: "user" }],
        model: "gpt-4.1-mini",
      });
      await expectGatewayPost(baseUrl, {
        apiKey: noDefaultKey,
        expectedCode: "missing_model",
        requestId: "req_missing_model_035",
        status: 400,
      });
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

type GatewayPostExpectation = {
  apiKey: string;
  expectedCode?: string;
  model?: string;
  requestId: string;
  status: 200 | 400 | 403;
};

async function seedVirtualModelAccess(
  fixture: Fixture,
  input: { allowedKey: string; noDefaultKey: string; providerBaseUrl: string },
): Promise<void> {
  const agentId = randomUUID();
  const allowedKeyId = randomUUID();
  const noDefaultKeyId = randomUUID();
  const fastVirtualModelId = randomUUID();
  const strongVirtualModelId = randomUUID();
  const blockedVirtualModelId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const routePolicyId = randomUUID();
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'fake-openai-vm-access', 'Fake OpenAI VM Access', $2, true)
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
    `
      insert into virtual_models (id, name, display_name, enabled)
      values ($1, 'coding-fast', 'Coding Fast', true),
             ($2, 'coding-strong', 'Coding Strong', true),
             ($3, 'blocked-model', 'Blocked Model', true)
    `,
    [fastVirtualModelId, strongVirtualModelId, blockedVirtualModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'VM Access Agent', 'coding', true)",
    [agentId],
  );
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
      allowedKeyId,
      agentId,
      input.allowedKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.allowedKey),
      fastVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agents (id, name, agent_type, key_prefix, key_hash, enabled)
      values ($1, 'VM Access No Default Agent', 'coding', $2, $3, true)
    `,
    [
      noDefaultKeyId,
      input.noDefaultKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.noDefaultKey),
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2),
             ($1, $3),
             ($4, $2)
    `,
    [allowedKeyId, fastVirtualModelId, strongVirtualModelId, noDefaultKeyId],
  );
  await fixture.query(
    "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'fixed')",
    [routePolicyId, fastVirtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (
        id,
        route_policy_id,
        provider_model_id,
        candidate_order,
        is_fallback
      )
      values ($1, $2, $3, 1, false)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Gateway VM access config')",
  );
}

async function expectAllowedModels(
  baseUrl: string,
  apiKey: string,
  expectedModelNames: string[],
): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: { authorization: `Bearer ${apiKey}`, "x-request-id": "req_models_035" },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({
    data: expectedModelNames.map((modelName) => ({
      id: modelName,
      object: "model",
    })),
    object: "list",
    requestId: "req_models_035",
  });
}

async function expectGatewayPost(
  baseUrl: string,
  expectation: GatewayPostExpectation,
): Promise<void> {
  const body: Record<string, unknown> = {
    messages: [{ content: "hello", role: "user" }],
  };
  if (expectation.model) {
    body.model = expectation.model;
  }

  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${expectation.apiKey}`,
      "content-type": "application/json",
      "x-request-id": expectation.requestId,
    },
    method: "POST",
  });
  expect(response.status).toBe(expectation.status);
  const responseBody = await response.json();

  if (expectation.status !== 200) {
    expect(responseBody).toEqual({
      error: {
        code: expectation.expectedCode,
        message: expect.any(String),
      },
      requestId: expectation.requestId,
    });
    return;
  }

  expect(responseBody).toMatchObject({
    id: "fake-provider-response",
    object: "chat.completion",
  });
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
        message: "Gateway did not start.",
        timeout: 15_000,
      },
    )
    .toBe(200);
}

function startGatewayProcess(options: { databaseUrl: string; port: number }): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_NOTIFICATIONS: "false",
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: "0",
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: masterKey,
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
