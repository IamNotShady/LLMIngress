import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(compose).not.toContain('"4000:4000"');
    expect(compose).not.toContain('"3000:3000"');
    expect(compose).not.toContain(`"${shell}{POSTGRES_PORT:-55432}:5432"`);

    accessSync("scripts/deploy.sh", constants.X_OK);
    expect(deploy).toContain("openssl rand -base64 32");
    expect(deploy).toContain("^ENCRYPTION_KEY=");
    expect(deploy).toContain("--ensure-env");
    expect(deploy).toContain('exec docker compose up --build "$@"');
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
