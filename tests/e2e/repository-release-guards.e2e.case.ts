import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

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
