import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { buildGatewayAgentApiKeyHash } from "../../packages/gateway-runtime/src/gateway-auth";
import { getFreePort, signInFromFirstRun } from "../support/console-app";

const execFileAsync = promisify(execFile);

test("one release-bound command installs, no-ops, and repairs a real Docker instance", async ({
  page,
}) => {
  test.setTimeout(600_000);
  const suffix = Math.random().toString(36).slice(2, 10);
  const instance = `e2e-${suffix}`;
  const prefix = `llmingress-${instance}`;
  const imageTag = `llmingress-lifecycle-e2e:${suffix}`;
  const outputDirectory = await mkdtemp(join(tmpdir(), "llmingress-installer-e2e-"));
  const consolePort = await getFreePort();
  const gatewayPort = await getFreePort();

  try {
    await execFileAsync(
      "docker",
      [
        "build",
        "--target",
        "runtime",
        "--build-arg",
        "LLMINGRESS_VERSION=v1.0.0",
        "-t",
        imageTag,
        ".",
      ],
      { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 },
    );
    const imageId = (
      await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", imageTag])
    ).stdout.trim();
    await renderInstaller({ image: imageId, outputDirectory, version: "v1.0.0" });

    const installerArgs = [
      join(outputDirectory, "install.sh"),
      "--instance",
      instance,
      "--console-port",
      String(consolePort),
      "--gateway-port",
      String(gatewayPort),
    ];
    await execFileAsync("bash", installerArgs, { maxBuffer: 20 * 1024 * 1024 });

    const containers = ["postgres", "gateway", "console", "worker"].map(
      (role) => `${prefix}-${role}`,
    );
    const initialIds = await containerIds(containers);
    expect(Object.keys(initialIds)).toHaveLength(4);
    expect(await httpStatus(`http://127.0.0.1:${gatewayPort}/health/ready`)).toBe(200);
    expect(await httpStatus(`http://127.0.0.1:${consolePort}`)).toBe(200);

    const postgresVersion = await dockerExec(
      `${prefix}-postgres`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "llmingress",
      "-Atc",
      "show server_version",
    );
    expect(postgresVersion).toBe("18.4");
    const tableCount = await dockerExec(
      `${prefix}-postgres`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "llmingress",
      "-Atc",
      "select count(*) from information_schema.tables where table_schema='public' and table_type='BASE TABLE'",
    );
    expect(tableCount).toBe("24");

    const volumes = (
      await execFileAsync("docker", [
        "volume",
        "ls",
        "--filter",
        `label=io.llmingress.instance=${instance}`,
        "--format",
        "{{.Name}}",
      ])
    ).stdout
      .trim()
      .split(/\r?\n/);
    expect(volumes.sort()).toEqual(
      [`${prefix}-backups`, `${prefix}-config`, `${prefix}-postgres`].sort(),
    );

    for (const container of containers) {
      const environment = JSON.parse(
        (
          await execFileAsync("docker", [
            "container",
            "inspect",
            "--format",
            "{{json .Config.Env}}",
            container,
          ])
        ).stdout,
      ) as string[];
      expect(environment.some((value) => value.startsWith("POSTGRES_PASSWORD="))).toBe(false);
      expect(environment.some((value) => value.startsWith("MASTER_KEY="))).toBe(false);
      if (container !== `${prefix}-postgres`) {
        expect(environment).toContain("MASTER_KEY_FILE=/run/llmingress/master-key");
        await dockerExec(
          container,
          "sh",
          "-c",
          'test "$MASTER_KEY_FILE" = /run/llmingress/master-key && test -r "$MASTER_KEY_FILE"',
        );
      }
    }

    const consoleUrl = `http://127.0.0.1:${consolePort}`;
    await signInFromFirstRun(page, consoleUrl);
    await expect(
      page.getByText(`Gateway URL 127.0.0.1:${gatewayPort}`, { exact: true }),
    ).toBeVisible();

    const agentApiKey = `llmi_docker_${suffix}_agent_key`;
    await startDockerFakeProvider(prefix, imageId);
    await seedDockerGatewayRoute(prefix, agentApiKey);
    await execFileAsync("docker", ["restart", `${prefix}-gateway`]);
    await expect
      .poll(() => httpStatus(`http://127.0.0.1:${gatewayPort}/health/ready`).catch(() => 0), {
        timeout: 60_000,
      })
      .toBe(200);
    await expectDockerGatewayRoute(gatewayPort, agentApiKey);

    await execFileAsync("bash", installerArgs, { maxBuffer: 20 * 1024 * 1024 });
    expect(await containerIds(containers)).toEqual(initialIds);

    await execFileAsync("docker", ["rm", "-f", `${prefix}-worker`]);
    await execFileAsync("bash", installerArgs, { maxBuffer: 20 * 1024 * 1024 });
    expect((await containerIds(containers))[`${prefix}-worker`]).toBeTruthy();
    expect(await httpStatus(`http://127.0.0.1:${gatewayPort}/health/ready`)).toBe(200);

    await renderInstaller({ image: imageId, outputDirectory, version: "v1.1.0" });
    await execFileAsync("bash", installerArgs, { maxBuffer: 20 * 1024 * 1024 });
    expect(await readInstalledVersion(prefix)).toBe("v1.1.0");
    expect(
      await dockerExec(
        `${prefix}-postgres`,
        "psql",
        "-U",
        "postgres",
        "-d",
        "llmingress",
        "-Atc",
        "select display_name from providers where provider_key = 'ollama'",
      ),
    ).toBe("Docker Fake Provider");
    await page.reload();
    await expect(
      page.getByText(`Gateway URL 127.0.0.1:${gatewayPort}`, { exact: true }),
    ).toBeVisible();
    await expectDockerGatewayRoute(gatewayPort, agentApiKey);

    await renderInstaller({ image: imageId, outputDirectory, version: "v0.9.0" });
    await expect(
      execFileAsync("bash", installerArgs, { maxBuffer: 20 * 1024 * 1024 }),
    ).rejects.toThrow(/downgrade/i);

    const conflictInstance = `conflict-${suffix}`;
    const conflictPrefix = `llmingress-${conflictInstance}`;
    await execFileAsync("docker", ["volume", "create", `${conflictPrefix}-config`]);
    const conflictArgs = installerArguments(
      outputDirectory,
      conflictInstance,
      await getFreePort(),
      await getFreePort(),
    );
    await expect(
      execFileAsync("bash", conflictArgs, { maxBuffer: 20 * 1024 * 1024 }),
    ).rejects.toThrow(/not managed by LLMIngress/i);
    await cleanupInstance(conflictPrefix);
  } finally {
    await cleanupInstance(prefix);
    await execFileAsync("docker", ["image", "rm", "-f", imageTag]).catch(() => undefined);
    await rm(outputDirectory, { force: true, recursive: true });
  }
});

test("version upgrades preserve data and an unhealthy target restores the old release", async () => {
  test.setTimeout(900_000);
  const suffix = Math.random().toString(36).slice(2, 10);
  const instance = `upgrade-${suffix}`;
  const prefix = `llmingress-${instance}`;
  const imageTag = `llmingress-lifecycle-upgrade:${suffix}`;
  const failingImageTag = `llmingress-lifecycle-failing:${suffix}`;
  const outputDirectory = await mkdtemp(join(tmpdir(), "llmingress-upgrade-e2e-"));
  const consolePort = await getFreePort();
  const gatewayPort = await getFreePort();

  try {
    const imageId = await buildRuntimeImage(imageTag, "v1.0.0");
    const failingImageId = await buildFixtureImage(failingImageTag, imageTag, "fail-gateway");
    await renderInstaller({ image: failingImageId, outputDirectory, version: "v1.0.0" });
    const args = installerArguments(outputDirectory, instance, consolePort, gatewayPort);
    await expect(
      execFileAsync("bash", args, { maxBuffer: 20 * 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 1 });

    await renderInstaller({ image: imageId, outputDirectory, version: "v1.0.0" });
    await execFileAsync("bash", args, { maxBuffer: 20 * 1024 * 1024 });
    await dockerExec(
      `${prefix}-postgres`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "llmingress",
      "-c",
      "create table lifecycle_probe (value text not null); insert into lifecycle_probe values ('preserved')",
    );

    await renderInstaller({ image: imageId, outputDirectory, version: "v1.1.0" });
    await execFileAsync("bash", args, { maxBuffer: 20 * 1024 * 1024 });
    expect(
      await dockerExec(
        `${prefix}-postgres`,
        "psql",
        "-U",
        "postgres",
        "-d",
        "llmingress",
        "-Atc",
        "select value from lifecycle_probe",
      ),
    ).toBe("preserved");

    await renderInstaller({ image: failingImageId, outputDirectory, version: "v1.2.0" });
    await expect(
      execFileAsync("bash", args, { maxBuffer: 20 * 1024 * 1024 }),
    ).rejects.toMatchObject({ code: 1 });

    expect(await readInstalledVersion(prefix)).toBe("v1.1.0");
    expect(
      await dockerExec(
        `${prefix}-postgres`,
        "psql",
        "-U",
        "postgres",
        "-d",
        "llmingress",
        "-Atc",
        "select value from lifecycle_probe",
      ),
    ).toBe("preserved");
    expect(await httpStatus(`http://127.0.0.1:${gatewayPort}/health/ready`)).toBe(200);

    for (let patch = 2; patch <= 7; patch += 1) {
      await renderInstaller({ image: imageId, outputDirectory, version: `v1.${patch}.0` });
      await execFileAsync("bash", [...args, "--backup-retention", "5"], {
        maxBuffer: 20 * 1024 * 1024,
      });
    }
    expect(await countBackups(prefix)).toBe(5);
  } finally {
    await cleanupInstance(prefix);
    await execFileAsync("docker", ["image", "rm", "-f", failingImageTag]).catch(() => undefined);
    await execFileAsync("docker", ["image", "rm", "-f", imageTag]).catch(() => undefined);
    await rm(outputDirectory, { force: true, recursive: true });
  }
});

test("an interrupted migration transaction is restored before the next command proceeds", async () => {
  test.setTimeout(900_000);
  const suffix = Math.random().toString(36).slice(2, 10);
  const instance = `interrupt-${suffix}`;
  const prefix = `llmingress-${instance}`;
  const imageTag = `llmingress-lifecycle-interrupt-base:${suffix}`;
  const slowImageTag = `llmingress-lifecycle-interrupt-slow:${suffix}`;
  const stableDirectory = await mkdtemp(join(tmpdir(), "llmingress-interrupt-stable-"));
  const targetDirectory = await mkdtemp(join(tmpdir(), "llmingress-interrupt-target-"));
  const consolePort = await getFreePort();
  const gatewayPort = await getFreePort();

  try {
    const imageId = await buildRuntimeImage(imageTag, "v2.0.0");
    await renderInstaller({ image: imageId, outputDirectory: stableDirectory, version: "v2.0.0" });
    const stableArgs = installerArguments(stableDirectory, instance, consolePort, gatewayPort);
    await execFileAsync("bash", stableArgs, { maxBuffer: 20 * 1024 * 1024 });
    await dockerExec(
      `${prefix}-postgres`,
      "psql",
      "-U",
      "postgres",
      "-d",
      "llmingress",
      "-c",
      "create table lifecycle_interrupt_probe (value text not null); insert into lifecycle_interrupt_probe values ('before')",
    );

    const slowImageId = await buildFixtureImage(slowImageTag, imageTag, "slow-migrate");
    await renderInstaller({
      image: slowImageId,
      outputDirectory: targetDirectory,
      version: "v2.1.0",
    });
    const targetArgs = installerArguments(targetDirectory, instance, consolePort, gatewayPort);
    const upgrade = spawn("bash", targetArgs, { stdio: "ignore" });

    await expect.poll(() => transactionExists(prefix), { timeout: 120_000 }).toBe(true);
    upgrade.kill("SIGKILL");
    await new Promise<void>((resolve) => upgrade.once("exit", () => resolve()));

    await execFileAsync("bash", stableArgs, { maxBuffer: 20 * 1024 * 1024 });
    expect(await readInstalledVersion(prefix)).toBe("v2.0.0");
    expect(await transactionExists(prefix)).toBe(false);
    expect(
      await dockerExec(
        `${prefix}-postgres`,
        "psql",
        "-U",
        "postgres",
        "-d",
        "llmingress",
        "-Atc",
        "select value from lifecycle_interrupt_probe",
      ),
    ).toBe("before");
    expect(await httpStatus(`http://127.0.0.1:${gatewayPort}/health/ready`)).toBe(200);
  } finally {
    await cleanupInstance(prefix);
    await execFileAsync("docker", ["image", "rm", "-f", slowImageTag]).catch(() => undefined);
    await execFileAsync("docker", ["image", "rm", "-f", imageTag]).catch(() => undefined);
    await rm(stableDirectory, { force: true, recursive: true });
    await rm(targetDirectory, { force: true, recursive: true });
  }
});

async function renderInstaller(input: {
  image: string;
  outputDirectory: string;
  version: string;
}): Promise<void> {
  await execFileAsync(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/render-release-assets.ts",
      "--version",
      input.version,
      "--app-image",
      input.image,
      "--postgres-image",
      "postgres:18.4-alpine",
      "--output-directory",
      input.outputDirectory,
      "--allow-local-images",
    ],
    { cwd: process.cwd() },
  );
}

function installerArguments(
  outputDirectory: string,
  instance: string,
  consolePort: number,
  gatewayPort: number,
): string[] {
  return [
    join(outputDirectory, "install.sh"),
    "--instance",
    instance,
    "--console-port",
    String(consolePort),
    "--gateway-port",
    String(gatewayPort),
  ];
}

async function buildRuntimeImage(imageTag: string, version: string): Promise<string> {
  await execFileAsync(
    "docker",
    [
      "build",
      "--target",
      "runtime",
      "--build-arg",
      `LLMINGRESS_VERSION=${version}`,
      "-t",
      imageTag,
      ".",
    ],
    { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 },
  );
  return (
    await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", imageTag])
  ).stdout.trim();
}

async function buildFixtureImage(
  imageTag: string,
  baseImage: string,
  fixtureMode: string,
): Promise<string> {
  await execFileAsync(
    "docker",
    [
      "build",
      "--build-arg",
      `BASE_IMAGE=${baseImage}`,
      "--build-arg",
      `FIXTURE_MODE=${fixtureMode}`,
      "-t",
      imageTag,
      "tests/fixtures/docker-lifecycle",
    ],
    { cwd: process.cwd(), maxBuffer: 20 * 1024 * 1024 },
  );
  return (
    await execFileAsync("docker", ["image", "inspect", "--format", "{{.Id}}", imageTag])
  ).stdout.trim();
}

async function containerIds(containers: string[]): Promise<Record<string, string>> {
  return Object.fromEntries(
    await Promise.all(
      containers.map(async (container) => {
        const id = (
          await execFileAsync("docker", ["container", "inspect", "--format", "{{.Id}}", container])
        ).stdout.trim();
        return [container, id];
      }),
    ),
  );
}

async function dockerExec(container: string, ...args: string[]): Promise<string> {
  return (await execFileAsync("docker", ["exec", container, ...args])).stdout.trim();
}

async function startDockerFakeProvider(prefix: string, image: string): Promise<void> {
  const responseBody = JSON.stringify({
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        message: { content: "docker route ok", role: "assistant" },
      },
    ],
    created: 1,
    id: "chatcmpl-docker-lifecycle",
    model: "fake-model",
    object: "chat.completion",
    usage: { completion_tokens: 3, prompt_tokens: 2, total_tokens: 5 },
  });
  const server = [
    'const http = require("node:http");',
    "http.createServer(async (request, response) => {",
    "  for await (const chunk of request) void chunk;",
    '  response.writeHead(200, { "content-type": "application/json" });',
    `  response.end(${JSON.stringify(responseBody)});`,
    '}).listen(8080, "0.0.0.0");',
  ].join("\n");
  await execFileAsync("docker", [
    "run",
    "-d",
    "--name",
    `${prefix}-fake-provider`,
    "--network",
    `${prefix}-network`,
    "--entrypoint",
    "node",
    image,
    "-e",
    server,
  ]);
}

async function seedDockerGatewayRoute(prefix: string, agentApiKey: string): Promise<void> {
  const agentId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();
  const sql = `
    insert into agents (id, name, key_prefix, key_hash, enabled)
    values ('${agentId}', 'Docker Test Agent', '${agentApiKey.slice(0, 12)}', '${buildGatewayAgentApiKeyHash(agentApiKey)}', true);
    insert into providers (
      id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled
    ) values (
      '${providerId}', 'local', 'ollama', 'ollama', 'Docker Fake Provider',
      'http://${prefix}-fake-provider:8080/v1', true
    );
    insert into provider_models (
      id, provider_id, model_id, display_name, input_modalities, output_modalities,
      context_window, max_output_tokens, supports_streaming, supports_function_calling,
      supports_reasoning, availability
    ) values (
      '${providerModelId}', '${providerId}', 'fake-model', 'Fake Model', array['text']::text[],
      array['text']::text[], 128000, 8192, true, true, false, 'available'
    );
    insert into virtual_models (id, name, description, enabled)
    values ('${virtualModelId}', 'docker-fixture-vm', 'Docker fixture VM', true);
    update agents set default_virtual_model_id = '${virtualModelId}' where id = '${agentId}';
    insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
    values ('${routePolicyId}', '${virtualModelId}', 'fixed', 'chat_completions');
    insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
    values ('${randomUUID()}', '${routePolicyId}', '${providerModelId}', 1);
    insert into agent_virtual_models (agent_id, virtual_model_id)
    values ('${agentId}', '${virtualModelId}');
    insert into config_versions (version, source, description)
    select coalesce(max(version), 0) + 1, 'console', 'Docker lifecycle route fixture'
    from config_versions;
  `;
  await dockerExec(
    `${prefix}-postgres`,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "postgres",
    "-d",
    "llmingress",
    "-c",
    sql,
  );
}

async function expectDockerGatewayRoute(gatewayPort: number, agentApiKey: string): Promise<void> {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: "ping", role: "user" }],
      model: "docker-fixture-vm",
      stream: false,
    }),
    headers: {
      authorization: `Bearer ${agentApiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  expect(response.status, await response.text()).toBe(200);
}

async function httpStatus(url: string): Promise<number> {
  const response = await fetch(url);
  await response.body?.cancel();
  return response.status;
}

async function readInstalledVersion(prefix: string): Promise<string> {
  const state = await readConfigFile(prefix, "install-state.env");
  return /^INSTALLED_VERSION=(.+)$/m.exec(state)?.[1] ?? "";
}

async function countBackups(prefix: string): Promise<number> {
  const result = await execFileAsync("docker", [
    "run",
    "--rm",
    "--user",
    "0",
    "--entrypoint",
    "sh",
    "-v",
    `${prefix}-backups:/backups:ro`,
    "postgres:18.4-alpine",
    "-c",
    "find /backups -type f -name '*.dump' | wc -l",
  ]);
  return Number(result.stdout.trim());
}

async function transactionExists(prefix: string): Promise<boolean> {
  try {
    await execFileAsync("docker", [
      "run",
      "--rm",
      "--user",
      "0",
      "--entrypoint",
      "sh",
      "-v",
      `${prefix}-config:/state:ro`,
      "postgres:18.4-alpine",
      "-c",
      "test -f /state/transaction/journal.env",
    ]);
    return true;
  } catch {
    return false;
  }
}

async function readConfigFile(prefix: string, filename: string): Promise<string> {
  return (
    await execFileAsync("docker", [
      "run",
      "--rm",
      "--user",
      "0",
      "--entrypoint",
      "cat",
      "-v",
      `${prefix}-config:/state:ro`,
      "postgres:18.4-alpine",
      `/state/${filename}`,
    ])
  ).stdout;
}

async function cleanupInstance(prefix: string): Promise<void> {
  for (const role of ["fake-provider", "migrate", "worker", "console", "gateway", "postgres"]) {
    await execFileAsync("docker", ["rm", "-f", `${prefix}-${role}`]).catch(() => undefined);
  }
  await execFileAsync("docker", ["network", "rm", `${prefix}-network`]).catch(() => undefined);
  for (const volume of ["backups", "config", "postgres"]) {
    await execFileAsync("docker", ["volume", "rm", "-f", `${prefix}-${volume}`]).catch(
      () => undefined,
    );
  }
}
