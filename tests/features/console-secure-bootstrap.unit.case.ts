import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPostgresFixture, runMigrations } from "@llmingress/db";
import { createAdminPassword } from "@llmingress/db/console-auth";
import { ConsoleOperationError } from "@llmingress/db/console-operation-error";
import { describe, expect, it } from "vitest";

describe("console secure bootstrap", () => {
  it("requires ENCRYPTION_KEY from env and keeps host publishes loopback-bound by default", () => {
    const compose = readFileSync("docker-compose.yml", "utf8");
    const deploy = readFileSync("scripts/deploy.sh", "utf8");
    const exampleEnv = readFileSync(".env.example", "utf8");
    const shell = "$";

    expect(compose).toContain(`${shell}{ENCRYPTION_KEY:?ENCRYPTION_KEY is required}`);
    expect(compose).not.toContain("llmi-local-master");
    expect(compose).toContain(
      `${shell}{DATABASE_URL:-postgresql://postgres:llmi-local-db@postgres:5432/postgres}`,
    );
    expect(compose).toContain("POSTGRES_PASSWORD: llmi-local-db");
    expect(compose).not.toContain("CONSOLE_SETUP_TOKEN");
    expect(compose).not.toContain(`${shell}{ENCRYPTION_KEY:-`);
    expect(compose).not.toContain(`${shell}{POSTGRES_PASSWORD`);
    expect(compose).not.toContain("POSTGRES_PASSWORD: postgres");

    expect(compose).toContain("GATEWAY_HOST: 0.0.0.0");
    expect(compose).toContain("CONSOLE_HOST: 0.0.0.0");
    expect(compose).toContain(
      `"${shell}{GATEWAY_PUBLISH_HOST:-127.0.0.1}:${shell}{GATEWAY_PORT:-4000}:4000"`,
    );
    expect(compose).toContain(
      `"${shell}{CONSOLE_PUBLISH_HOST:-127.0.0.1}:${shell}{CONSOLE_PORT:-3000}:3000"`,
    );
    expect(compose).toContain(
      `"${shell}{POSTGRES_PUBLISH_HOST:-127.0.0.1}:${shell}{POSTGRES_PORT:-55432}:5432"`,
    );
    expect(compose).toContain(
      `GATEWAY_URL: "${shell}{GATEWAY_URL:-http://127.0.0.1:${shell}{GATEWAY_PORT:-4000}}"`,
    );
    expect(exampleEnv).not.toMatch(/^GATEWAY_URL=/m);
    expect(compose).not.toContain('"4000:4000"');
    expect(compose).not.toContain('"3000:3000"');
    expect(compose).not.toContain(`"${shell}{POSTGRES_PORT:-55432}:5432"`);

    accessSync("scripts/deploy.sh", constants.X_OK);
    expect(deploy).toContain("openssl rand -base64 32");
    expect(deploy).toContain("^ENCRYPTION_KEY=");
    expect(deploy).toContain("--ensure-env");
    expect(deploy).toContain("--project-name");
    expect(deploy).toContain("--force-recreate");
    expect(deploy).toContain("--remove-orphans");
  });

  it("writes ENCRYPTION_KEY into .env only when missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "llmingress-deploy-"));
    const ensureEncryptionKey = `
      set -euo pipefail
      cd "$1"
      if ! grep -q '^ENCRYPTION_KEY=' .env 2>/dev/null; then
        echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
      fi
    `;

    execFileSync("bash", ["-c", ensureEncryptionKey, "bash", directory]);
    const first = readFileSync(join(directory, ".env"), "utf8");
    expect(first).toMatch(/^ENCRYPTION_KEY=.+/m);

    execFileSync("bash", ["-c", ensureEncryptionKey, "bash", directory]);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe(first);

    writeFileSync(join(directory, ".env"), "ENCRYPTION_KEY=keep-me\n");
    execFileSync("bash", ["-c", ensureEncryptionKey, "bash", directory]);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe("ENCRYPTION_KEY=keep-me\n");
  });

  it("isolates Compose projects by branch while keeping main on the default name", () => {
    expect(runDeployWithMockedDocker("main")).toEqual([
      "compose",
      "--env-file",
      ".env",
      "--project-name",
      "llmingress",
      "up",
      "--build",
      "--force-recreate",
      "--remove-orphans",
      "-d",
    ]);
    expect(runDeployWithMockedDocker("feat/console-ui-redesign", true)).toEqual([
      "compose",
      "--env-file",
      ".env",
      "--env-file",
      ".env.local",
      "--project-name",
      "llmingress-feat-console-ui-redesign",
      "up",
      "--build",
      "--force-recreate",
      "--remove-orphans",
      "-d",
    ]);
  });

  it("has no setup token runtime or documented configuration surface", () => {
    const files = [
      ".env.example",
      "README.md",
      "docs/PRODUCT.md",
      "packages/config/src/index.ts",
      "apps/console/src/app/(dashboard)/layout.tsx",
      "apps/console/src/app/_ui/auth.tsx",
      "apps/console/src/app/api/auth/setup/route.ts",
    ];

    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /CONSOLE_SETUP_TOKEN|console_setup_token|SetupLocked|readConsoleSetupMode|requiresSetupToken|setupToken/,
      );
    }
  });

  it("creates the first admin with race-safe insert semantics", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_setup_race_${randomUUID().replaceAll("-", "_")}`,
    });

    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });

      const attempts = await Promise.allSettled([
        createAdminPassword(fixture.databaseUrl, "correct horse battery staple"),
        createAdminPassword(fixture.databaseUrl, "correct horse battery staple"),
      ]);
      const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
      const rejected = attempts.filter((attempt) => attempt.status === "rejected");

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConsoleOperationError);
      expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
        code: "console_already_initialized",
        kind: "conflict",
      });
    } finally {
      await fixture.dispose();
    }
  });
});

function runDeployWithMockedDocker(branchName: string, withLocalEnv = false): string[] {
  const directory = mkdtempSync(join(tmpdir(), "llmingress-deploy-project-"));
  const scriptsDirectory = join(directory, "scripts");
  const binDirectory = join(directory, "bin");
  const dockerArgumentsPath = join(directory, "docker-arguments");
  mkdirSync(scriptsDirectory);
  mkdirSync(binDirectory);
  writeFileSync(join(directory, ".env"), "ENCRYPTION_KEY=test-key\n");
  if (withLocalEnv) {
    writeFileSync(join(directory, ".env.local"), "GATEWAY_PORT=4001\n");
  }
  writeFileSync(join(scriptsDirectory, "deploy.sh"), readFileSync("scripts/deploy.sh"), {
    mode: 0o755,
  });
  writeFileSync(join(binDirectory, "git"), '#!/bin/sh\nprintf "%s\\n" "$TEST_GIT_BRANCH"\n', {
    mode: 0o755,
  });
  writeFileSync(
    join(binDirectory, "docker"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$TEST_DOCKER_ARGUMENTS_PATH"\n',
    { mode: 0o755 },
  );

  execFileSync(join(scriptsDirectory, "deploy.sh"), ["-d"], {
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${binDirectory}:${process.env.PATH}`,
      TEST_DOCKER_ARGUMENTS_PATH: dockerArgumentsPath,
      TEST_GIT_BRANCH: branchName,
    },
  });

  return readFileSync(dockerArgumentsPath, "utf8").trim().split("\n");
}
