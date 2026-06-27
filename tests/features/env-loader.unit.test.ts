import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatShellExports, loadEnvFiles, parseEnvFile } from "../../scripts/env-loader";

const createdDirectories: string[] = [];

afterEach(async () => {
  for (const directory of createdDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

describe("test environment file loader", () => {
  it("loads .env and lets .env.local override file defaults without replacing shell env", async () => {
    const directory = await mkdtemp(join(tmpdir(), "llmingress-env-loader-"));
    createdDirectories.push(directory);
    const env = {
      SHELL_ONLY: "from-shell",
    };

    await writeFile(
      join(directory, ".env"),
      [
        "LLMINGRESS_REAL_SMOKE=0",
        "TEST_DATABASE_URL=postgresql://from-env",
        "OPENAI_API_KEY=sk-from-env",
        "SHELL_ONLY=from-env",
      ].join("\n"),
    );
    await writeFile(
      join(directory, ".env.local"),
      ["LLMINGRESS_REAL_SMOKE=1", "OPENAI_API_KEY=sk-from-local"].join("\n"),
    );

    const result = loadEnvFiles({ cwd: directory, env });

    expect(result.loadedFiles.map((file) => file.name)).toEqual([".env", ".env.local"]);
    expect(env).toMatchObject({
      LLMINGRESS_REAL_SMOKE: "1",
      OPENAI_API_KEY: "sk-from-local",
      SHELL_ONLY: "from-shell",
      TEST_DATABASE_URL: "postgresql://from-env",
    });
  });

  it("parses comments quotes exports and blank values", () => {
    expect(
      parseEnvFile(
        [
          "# comment",
          "export DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/app'",
          'MASTER_KEY="test-master-key"',
          "LLMINGRESS_REAL_SMOKE=0",
          "EMPTY_VALUE=",
        ].join("\n"),
      ),
    ).toEqual({
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app",
      EMPTY_VALUE: "",
      LLMINGRESS_REAL_SMOKE: "0",
      MASTER_KEY: "test-master-key",
    });
  });

  it("keeps test package scripts behind the env loader", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe("tsx scripts/run-with-env.ts vitest run --coverage");
    expect(packageJson.scripts["test:e2e"]).toBe("tsx scripts/run-with-env.ts playwright test");
    expect(packageJson.scripts["test:e2e:coverage"]).toBe(
      "tsx scripts/run-with-env.ts tsx scripts/console-e2e-coverage.ts",
    );
    expect(packageJson.scripts["verify:features"]).toBe(
      "tsx scripts/run-with-env.ts node scripts/verify-features.mjs",
    );
    expect(packageJson.scripts["db:migrate:check"]).toBe(
      "tsx scripts/run-with-env.ts tsx scripts/migrate-check.ts",
    );
  });

  it("formats loaded values as shell-safe exports for init.sh", () => {
    expect(
      formatShellExports({
        EMPTY_VALUE: "",
        OPENAI_API_KEY: "sk-test'with-quote",
        TEST_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/postgres",
      }),
    ).toBe(
      [
        "export EMPTY_VALUE=''",
        "export OPENAI_API_KEY='sk-test'\\''with-quote'",
        "export TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/postgres'",
        "",
      ].join("\n"),
    );
  });

  it("loads env files before init.sh verification and service startup", async () => {
    const initScript = await readFile("init.sh", "utf8");

    expect(initScript).toContain("pnpm exec tsx scripts/print-env-exports.ts");
    expect(initScript.indexOf("scripts/print-env-exports.ts")).toBeLessThan(
      initScript.indexOf("pnpm run verify"),
    );
    expect(initScript.indexOf("scripts/print-env-exports.ts")).toBeLessThan(
      initScript.indexOf("pnpm --filter @llmingress/gateway dev"),
    );
  });
});
