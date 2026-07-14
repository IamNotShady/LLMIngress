import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("one-command Docker lifecycle", () => {
  it("ships a release-bound installer with managed resources and safe lifecycle operations", async () => {
    const installer = await readFile("scripts/docker/install.sh.template", "utf8");

    expect(installer).toContain("@@LLMINGRESS_VERSION@@");
    expect(installer).toContain("@@LLMINGRESS_IMAGE@@");
    expect(installer).toContain("@@POSTGRES_IMAGE@@");
    for (const option of [
      "--instance",
      "--bind-address",
      "--console-port",
      "--gateway-port",
      "--console-origin",
      "--gateway-url",
      "--backup-retention",
      "--help",
    ]) {
      expect(installer).toContain(option);
    }
    for (const resource of ["-postgres", "-config", "-backups", "-network"]) {
      expect(installer).toContain(resource);
    }
    expect(installer).toContain("io.llmingress.managed");
    expect(installer).toContain("flock");
    expect(installer).toContain("pg_dump");
    expect(installer).toContain("pg_restore");
    expect(installer).toContain("sha256sum");
    expect(installer).toContain("$filename.partial");
    expect(installer).toContain("unless-stopped");
    expect(installer).toContain("/health/ready");
    expect(installer).toContain("-e MASTER_KEY_FILE=/run/llmingress/master-key");
    expect(installer).toMatch(/console\)[\s\S]*-e "GATEWAY_URL=\$GATEWAY_URL"/);
    expect(installer.match(/-e "GATEWAY_URL=\$GATEWAY_URL"/g)).toHaveLength(1);
    expect(installer).not.toContain("GATEWAY_PUBLIC_BASE_URL");
    expect(installer).not.toMatch(/POSTGRES_PASSWORD=/);
    expect(installer).not.toMatch(/MASTER_KEY=/);
  });

  it("exposes the public Gateway URL only to the Compose Console service", async () => {
    const compose = await readFile("docker-compose.yml", "utf8");
    const consoleService = compose.slice(
      compose.indexOf("  console:"),
      compose.indexOf("  worker:"),
    );

    expect(consoleService).toContain("GATEWAY_URL:");
    expect(compose.match(/^\s+GATEWAY_URL:/gm)).toHaveLength(1);
  });

  it("renders auditable release assets bound to exact image digests", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "llmingress-release-assets-"));
    temporaryDirectories.push(outputDirectory);
    const digest = `sha256:${"a".repeat(64)}`;
    const postgresDigest = `sha256:${"b".repeat(64)}`;

    await execFileAsync(
      "pnpm",
      [
        "exec",
        "tsx",
        "scripts/render-release-assets.ts",
        "--version",
        "v1.2.3",
        "--app-image",
        `ghcr.io/iamnotshady/llmingress@${digest}`,
        "--postgres-image",
        `postgres:18.4-alpine@${postgresDigest}`,
        "--output-directory",
        outputDirectory,
      ],
      { cwd: process.cwd() },
    );

    const installerPath = join(outputDirectory, "install.sh");
    const installer = await readFile(installerPath, "utf8");
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, "release-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    const checksum = await readFile(join(outputDirectory, "install.sh.sha256"), "utf8");

    expect(installer).toContain("v1.2.3");
    expect(installer).toContain(`ghcr.io/iamnotshady/llmingress@${digest}`);
    expect(installer).toContain(`postgres:18.4-alpine@${postgresDigest}`);
    expect(installer).not.toContain("@@");
    expect(manifest).toEqual({
      appImage: `ghcr.io/iamnotshady/llmingress@${digest}`,
      postgresImage: `postgres:18.4-alpine@${postgresDigest}`,
      schemaVersion: 1,
      version: "v1.2.3",
    });
    expect(checksum).toMatch(/^[a-f0-9]{64} {2}install\.sh\n$/);

    await expect(
      execFileAsync("bash", [installerPath, "--console-port", "80"], {
        env: { PATH: "/usr/bin:/bin" },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/console-port must be from 1024/) });
  });

  it("publishes verified multi-architecture release assets only from version tags", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");

    expect(workflow).toContain("tags:");
    expect(workflow).toContain('"v*"');
    expect(workflow).toContain("linux/amd64,linux/arm64");
    expect(workflow).toContain("docker/build-push-action");
    expect(workflow).toContain("scripts/render-release-assets.ts");
    expect(workflow).toContain("docker logout ghcr.io");
    expect(workflow).toContain("docker pull");
    expect(workflow).toContain("gh release create");
    expect(workflow.indexOf("pnpm run verify:features")).toBeLessThan(
      workflow.indexOf("gh release create"),
    );
  });

  it("refuses a database migration history newer than the shipped image", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: "docker_lifecycle_unknown_migration",
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      await fixture.query(
        "insert into migration_history (id, name, checksum) values ($1, $2, $3)",
        ["9999", "future_release", "future-checksum"],
      );

      await expect(runMigrations({ databaseUrl: fixture.databaseUrl })).rejects.toThrow(
        /unknown migration 9999/i,
      );
    } finally {
      await fixture.dispose();
    }
  });
});
