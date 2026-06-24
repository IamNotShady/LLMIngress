import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { createSecretEncryption } from "@llmingress/security/secret-encryption";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../apps/gateway/src/auth";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";

const masterKey = "test-master-key";
const providerApiKey = "sk-fake-provider-claude-code-052";

test("claude code messages request returns 200 and records anthropic model hit", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_claude_code_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const agentApiKey = "llmi_claude_code_key_052";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedClaudeCodeRoute(fixture, {
      agentApiKey,
      providerBaseUrl: `${provider.url}/v1`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/messages`, {
        body: JSON.stringify(buildClaudeCodeMessagesBody(seeded.virtualModelName)),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_claude_code_052",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        content: [{ text: "fake provider response", type: "text" }],
        id: "fake-provider-message",
        role: "assistant",
        type: "message",
      });

      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        bodyJson: {
          max_tokens: 1024,
          messages: buildClaudeCodeMessagesBody(seeded.virtualModelName).messages,
          model: "claude-sonnet-4-5",
          tool_choice: { type: "auto" },
          tools: buildClaudeCodeMessagesBody(seeded.virtualModelName).tools,
        },
        headers: {
          "anthropic-version": "2023-06-01",
          "x-api-key": providerApiKey,
        },
        method: "POST",
        path: "/v1/messages",
      });

      await expect
        .poll(() => readClaudeCodeActivity(fixture, "req_claude_code_052"))
        .toEqual({
          http_status: 200,
          model: seeded.virtualModelName,
          provider_id: seeded.providerId,
          provider_model_id: seeded.providerModelId,
          status: "succeeded",
          virtual_model_id: seeded.virtualModelId,
        });
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

test("claude code subscription messages use OAuth protocol for json and streaming", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_claude_code_oauth_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();
  const agentApiKey = "llmi_claude_code_oauth_key_052";
  const oauthToken = "oauth-claude-code-token-052";

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedClaudeCodeSubscriptionRoutes(fixture, {
      agentApiKey,
      jsonProviderBaseUrl: provider.url,
      oauthToken,
      streamProviderBaseUrl: `${provider.url}?mode=stream`,
    });
    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const jsonResponse = await fetch(`${baseUrl}/v1/messages`, {
        body: JSON.stringify(buildClaudeCodeMessagesBody(seeded.jsonVirtualModelName)),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_claude_code_oauth_json_052",
        },
        method: "POST",
      });
      expect(jsonResponse.status).toBe(200);

      const streamResponse = await fetch(`${baseUrl}/v1/messages`, {
        body: JSON.stringify({
          ...buildClaudeCodeMessagesBody(seeded.streamVirtualModelName),
          stream: true,
        }),
        headers: {
          authorization: `Bearer ${agentApiKey}`,
          "content-type": "application/json",
          "x-request-id": "req_claude_code_oauth_stream_052",
        },
        method: "POST",
      });
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");

      expect(provider.requests).toHaveLength(2);
      expect(provider.requests.map((request) => request.path)).toEqual([
        "/v1/messages",
        "/v1/messages",
      ]);
      for (const request of provider.requests) {
        expect(request.headers.authorization).toBe(`Bearer ${oauthToken}`);
        expect(request.headers["x-app"]).toBe("cli");
        expect(request.headers["x-api-key"]).toBeUndefined();
      }
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

type SeededClaudeCodeRoute = {
  providerId: string;
  providerModelId: string;
  virtualModelId: string;
  virtualModelName: string;
};

type SeededClaudeCodeSubscriptionRoutes = {
  jsonVirtualModelName: string;
  streamVirtualModelName: string;
};

type ClaudeCodeActivityRow = {
  http_status: number;
  model: string;
  provider_id: string | null;
  provider_model_id: string | null;
  status: string;
  virtual_model_id: string | null;
};

function buildClaudeCodeMessagesBody(model: string) {
  return {
    max_tokens: 1024,
    messages: [
      {
        content: [
          {
            text: "Inspect the current repository and summarize the entrypoints.",
            type: "text",
          },
        ],
        role: "user",
      },
      {
        content: [
          { text: "I will inspect the working directory.", type: "text" },
          {
            id: "toolu_feat_052",
            input: { command: "pwd" },
            name: "Bash",
            type: "tool_use",
          },
        ],
        role: "assistant",
      },
      {
        content: [
          {
            content: "/workspace/llmingress",
            tool_use_id: "toolu_feat_052",
            type: "tool_result",
          },
        ],
        role: "user",
      },
    ],
    model,
    system: "You are Claude Code running inside a repository.",
    tool_choice: { type: "auto" },
    tools: [
      {
        description: "Run a shell command.",
        input_schema: {
          properties: {
            command: { type: "string" },
          },
          required: ["command"],
          type: "object",
        },
        name: "Bash",
      },
    ],
  };
}

async function seedClaudeCodeRoute(
  fixture: Fixture,
  input: { agentApiKey: string; providerBaseUrl: string },
): Promise<SeededClaudeCodeRoute> {
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const virtualModelName = "claude-code";
  const encrypted = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
    providerApiKey,
  );

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'anthropic', 'Anthropic', $2, true)
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
      values ($1, $2, 'claude-sonnet-4-5', 'Claude Sonnet 4.5', 200000, true, true, 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description, enabled)
      values ($1, $2, 'Claude Code', true)
    `,
    [virtualModelId, virtualModelName],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy)
      values ($1, $2, 'fixed')
    `,
    [routePolicyId, virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), routePolicyId, providerModelId],
  );
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Claude Code', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      input.agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.agentApiKey),
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
    "insert into config_versions (version, source, description) values (1, 'console', 'Claude Code config')",
  );

  return { providerId, providerModelId, virtualModelId, virtualModelName };
}

async function seedClaudeCodeSubscriptionRoutes(
  fixture: Fixture,
  input: {
    agentApiKey: string;
    jsonProviderBaseUrl: string;
    oauthToken: string;
    streamProviderBaseUrl: string;
  },
): Promise<SeededClaudeCodeSubscriptionRoutes> {
  const agentId = randomUUID();
  const agentApiKeyId = randomUUID();
  const jsonVirtualModelId = await seedClaudeCodeSubscriptionRoute(fixture, {
    modelId: "claude-sonnet-json",
    providerBaseUrl: input.jsonProviderBaseUrl,
    virtualModelName: "claude-code-sub-json",
  });
  const streamVirtualModelId = await seedClaudeCodeSubscriptionRoute(fixture, {
    modelId: "claude-sonnet-stream",
    providerBaseUrl: input.streamProviderBaseUrl,
    virtualModelName: "claude-code-sub-stream",
  });

  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Claude Code OAuth', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `
      update agents set id = $1, key_prefix = $3, key_hash = $4, default_virtual_model_id = $5, enabled = true, updated_at = now() where id = $2
    `,
    [
      agentApiKeyId,
      agentId,
      input.agentApiKey.slice(0, 12),
      buildGatewayAgentApiKeyHash(input.agentApiKey),
      jsonVirtualModelId,
    ],
  );
  await fixture.query(
    `
      insert into agent_virtual_models (agent_id, virtual_model_id)
      values ($1, $2),
             ($1, $3)
    `,
    [agentApiKeyId, jsonVirtualModelId, streamVirtualModelId],
  );
  await fixture.query(
    "insert into config_versions (version, source, description) values (1, 'console', 'Claude Code OAuth config')",
  );

  async function seedClaudeCodeSubscriptionRoute(
    fixture: Fixture,
    route: { modelId: string; providerBaseUrl: string; virtualModelName: string },
  ): Promise<string> {
    const providerId = randomUUID();
    const providerModelId = randomUUID();
    const virtualModelId = randomUUID();
    const routePolicyId = randomUUID();
    const encryptedToken = createSecretEncryption({ kind: "inline", value: masterKey }).encrypt(
      JSON.stringify({
        accessToken: input.oauthToken,
        expiresAt: Date.now() + 3_600_000,
        refreshToken: "refresh-token",
        scopes: [],
        tokenType: "Bearer",
      }),
    );

    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'subscription', 'claude_code', 'Claude Code', $2, true)
      `,
      [providerId, route.providerBaseUrl],
    );
    await fixture.query(
      `
        insert into provider_oauth (
          id,
          provider_id,
          label,
          priority,
          enabled,
          encrypted_token,
          token_expires_at,
          completed_at
        )
        values ($1, $2, 'Claude Code OAuth', 100, true, $3, now() + interval '1 hour', now())
      `,
      [randomUUID(), providerId, JSON.stringify(encryptedToken)],
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
          synced_input_usd_per_million_tokens,
          synced_output_usd_per_million_tokens
        )
        values ($1, $2, $3, $3, 200000, true, true, 'available', 3.00, 15.00)
      `,
      [providerModelId, providerId, route.modelId],
    );
    await fixture.query(
      `
        insert into virtual_models (id, name, description, enabled)
        values ($1, $2, $2, true)
      `,
      [virtualModelId, route.virtualModelName],
    );
    await fixture.query(
      `
        insert into route_policies (id, virtual_model_id, strategy)
        values ($1, $2, 'fixed')
      `,
      [routePolicyId, virtualModelId],
    );
    await fixture.query(
      `
        insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
        values ($1, $2, $3, 1)
      `,
      [randomUUID(), routePolicyId, providerModelId],
    );

    return virtualModelId;
  }

  return {
    jsonVirtualModelName: "claude-code-sub-json",
    streamVirtualModelName: "claude-code-sub-stream",
  };
}

async function readClaudeCodeActivity(
  fixture: Fixture,
  requestId: string,
): Promise<ClaudeCodeActivityRow | null> {
  const result = await fixture.query<ClaudeCodeActivityRow>(
    `
      select status,
             http_status,
             model,
             provider_id::text,
             provider_model_id::text,
             virtual_model_id::text
      from request_activity
      where request_id = $1
    `,
    [requestId],
  );
  return result.rows[0] ?? null;
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
        message: `Gateway did not start.\nstdout=${gateway.stdout.join("")}\nstderr=${gateway.stderr.join("")}`,
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
