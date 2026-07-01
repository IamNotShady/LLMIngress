import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("docker compose config defines the runnable LLMIngress stack", async () => {
  const services = await dockerCompose("config", "--services");
  const serviceNames = services.stdout.trim().split(/\r?\n/);

  expect(serviceNames).toHaveLength(5);
  expect(serviceNames).toEqual(
    expect.arrayContaining(["postgres", "migrate", "gateway", "console", "worker"]),
  );

  await dockerCompose("config", "--quiet");
});

async function dockerCompose(...args: string[]) {
  return execFileAsync("docker", ["compose", "-f", "docker-compose.yml", ...args], {
    cwd: process.cwd(),
  });
}
