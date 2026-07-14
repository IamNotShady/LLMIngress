import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { getFreePort } from "../support/console-app";

const execFileAsync = promisify(execFile);

test("Docker Compose starts PostgreSQL 18.4", async () => {
  test.setTimeout(180_000);
  const projectName = `llmingress_pg18_${randomUUID().replaceAll("-", "_")}`;
  const composeArgs = ["compose", "-p", projectName, "-f", "docker-compose.yml"];
  const env = {
    ...process.env,
    MASTER_KEY: "m".repeat(32),
    POSTGRES_PASSWORD: "p".repeat(32),
    POSTGRES_PORT: String(await getFreePort()),
  };

  try {
    await execFileAsync("docker", [...composeArgs, "up", "-d", "postgres"], {
      cwd: process.cwd(),
      env,
    });
    await expect
      .poll(
        async () => {
          try {
            const readiness = await execFileAsync(
              "docker",
              [...composeArgs, "exec", "-T", "postgres", "pg_isready", "-U", "postgres"],
              { cwd: process.cwd(), env },
            );
            return readiness.stdout.includes("accepting connections");
          } catch {
            return false;
          }
        },
        { timeout: 120_000 },
      )
      .toBe(true);

    const version = await execFileAsync(
      "docker",
      [
        ...composeArgs,
        "exec",
        "-T",
        "postgres",
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-Atc",
        "show server_version;",
      ],
      { cwd: process.cwd(), env },
    );
    expect(version.stdout.trim()).toBe("18.4");
  } finally {
    await execFileAsync("docker", [...composeArgs, "down", "-v", "--remove-orphans"], {
      cwd: process.cwd(),
      env,
    }).catch(() => undefined);
  }
});

test("release verification runner and docker compose contracts stay runnable", async () => {
  const dryRun = await execFileAsync("pnpm", ["run", "verify:features", "--", "--dry-run"], {
    cwd: process.cwd(),
  });
  const featureList = JSON.parse(await readFile("feature_list.json", "utf8")) as {
    features: Array<{ status: string }>;
  };
  const passingFeatureCount = featureList.features.filter(
    (feature) => feature.status === "passing",
  ).length;
  expect(dryRun.stdout).toContain(
    `Optimized feature regression plan: ${passingFeatureCount} passing feature(s).`,
  );
  expect(dryRun.stdout).toContain("Standard feature(s): 9");
  expect(dryRun.stdout).toContain("Legacy feature(s): 0");
  expect(dryRun.stdout).toContain("Standard verification coverage passed.");

  const composeEnv = {
    ...process.env,
    MASTER_KEY: "m".repeat(32),
    POSTGRES_PASSWORD: "p".repeat(32),
  };
  const services = await execFileAsync(
    "docker",
    ["compose", "-f", "docker-compose.yml", "config", "--services"],
    {
      cwd: process.cwd(),
      env: composeEnv,
    },
  );
  expect(services.stdout.trim().split(/\r?\n/)).toEqual(
    expect.arrayContaining(["postgres", "migrate", "gateway", "console", "worker"]),
  );

  await execFileAsync("docker", ["compose", "-f", "docker-compose.yml", "config", "--quiet"], {
    cwd: process.cwd(),
    env: composeEnv,
  });
});
