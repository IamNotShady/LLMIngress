import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { expect, test } from "@playwright/test";
import { createConfigPublisher } from "../../packages/db/src/config-versions";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("gateway starts from latest snapshot applies notified config and reconcile catches missed version", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_reload_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const publisher = createConfigPublisher({ databaseUrl: fixture.databaseUrl });

    await publishProvider(publisher, "openai", "OpenAI");

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
      reconcileIntervalMs: 10_000,
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await expect.poll(async () => (await readHealth(baseUrl))?.configVersion ?? -1).toBe(1);
      await expect.poll(async () => (await readHealth(baseUrl))?.providerCount ?? -1).toBe(1);

      await publishProvider(publisher, "anthropic", "Anthropic");
      await expect.poll(async () => (await readHealth(baseUrl))?.configVersion ?? -1).toBe(2);
      await expect.poll(async () => (await readHealth(baseUrl))?.providerCount ?? -1).toBe(2);
    } finally {
      await stopGatewayProcess(gateway);
    }

    const reconcileOnlyGateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      enableNotifications: false,
      port: await getFreePort(),
      reconcileIntervalMs: 50,
    });

    try {
      const baseUrl = `http://127.0.0.1:${reconcileOnlyGateway.port}`;
      await expect.poll(async () => (await readHealth(baseUrl))?.configVersion ?? -1).toBe(2);

      await publishProvider(publisher, "openrouter", "OpenRouter");
      await expect.poll(async () => (await readHealth(baseUrl))?.configVersion ?? -1).toBe(3);
      await expect.poll(async () => (await readHealth(baseUrl))?.providerCount ?? -1).toBe(3);
    } finally {
      await stopGatewayProcess(reconcileOnlyGateway);
    }
  } finally {
    await fixture.dispose();
  }
});

type ConfigPublisher = ReturnType<typeof createConfigPublisher>;

type GatewayProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

async function publishProvider(
  publisher: ConfigPublisher,
  providerKey: string,
  displayName: string,
) {
  const providerId = randomUUID();
  await publisher.publish({
    source: "console",
    description: `Create ${displayName}`,
    changes: [{ table: "providers", recordId: providerId }],
    write: async (client) => {
      await client.query(
        "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, $2, $3, $4, $5)",
        [providerId, "api_key", providerKey, displayName, true],
      );
    },
  });
}

async function getHealth(baseUrl: string): Promise<{
  configVersion: number;
  providerCount: number;
}> {
  const response = await fetch(`${baseUrl}/health`);
  expect(response.status).toBe(200);
  return response.json();
}

async function readHealth(baseUrl: string): Promise<{
  configVersion?: number;
  providerCount?: number;
} | null> {
  try {
    return await getHealth(baseUrl);
  } catch {
    return null;
  }
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

function startGatewayProcess(options: {
  databaseUrl: string;
  enableNotifications?: boolean;
  port: number;
  reconcileIntervalMs: number;
}): GatewayProcess {
  const child = spawn("pnpm", ["--filter", "@llmingress/gateway", "exec", "tsx", "src/main.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      GATEWAY_CONFIG_NOTIFICATIONS: options.enableNotifications === false ? "false" : "true",
      GATEWAY_CONFIG_RECONCILE_INTERVAL_MS: String(options.reconcileIntervalMs),
      GATEWAY_PORT: String(options.port),
      MASTER_KEY: "test-master-key",
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
