import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("v1 release verification runner and docker compose contracts stay runnable", async () => {
  const dryRun = await execFileAsync("pnpm", ["run", "verify:features", "--", "--dry-run"], {
    cwd: process.cwd(),
  });
  expect(dryRun.stdout).toContain("Optimized feature regression plan: 5 passing feature(s).");
  expect(dryRun.stdout).toContain("Optimized coverage comparison passed.");

  const services = await execFileAsync(
    "docker",
    ["compose", "-f", "docker-compose.yml", "config", "--services"],
    {
      cwd: process.cwd(),
    },
  );
  expect(services.stdout.trim().split(/\r?\n/)).toEqual(
    expect.arrayContaining(["postgres", "migrate", "gateway", "console", "worker"]),
  );

  await execFileAsync("docker", ["compose", "-f", "docker-compose.yml", "config", "--quiet"], {
    cwd: process.cwd(),
  });
});
