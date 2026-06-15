import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConsoleCommand } from "../../apps/console/src/main";
import {
  buildLocalDeploymentRequestId,
  localDeploymentSmokeComponents,
} from "../support/local-deployment-smoke";

const root = resolve(import.meta.dirname, "../..");

describe("feat-054 MVP local deployment smoke", () => {
  it("manifest enumerates postgres, gateway, console, and worker with a health signal", () => {
    expect(localDeploymentSmokeComponents.map((component) => component.name)).toEqual([
      "postgres",
      "gateway",
      "console",
      "worker",
    ]);
    for (const component of localDeploymentSmokeComponents) {
      expect(component.healthSignal.length).toBeGreaterThan(0);
    }
  });

  it("init.sh runs the verify gate before starting gateway, console, and worker", () => {
    const initSh = readFileSync(resolve(root, "init.sh"), "utf8");
    const verifyIndex = initSh.indexOf("pnpm run verify");
    const gatewayIndex = initSh.indexOf("@llmingress/gateway dev");
    const consoleIndex = initSh.indexOf("@llmingress/console dev");
    const workerIndex = initSh.indexOf("@llmingress/worker dev");

    expect(verifyIndex).toBeGreaterThan(-1);
    expect(gatewayIndex).toBeGreaterThan(verifyIndex);
    expect(consoleIndex).toBeGreaterThan(verifyIndex);
    expect(workerIndex).toBeGreaterThan(verifyIndex);
  });

  it("builds a stable startup-smoke request id", () => {
    expect(buildLocalDeploymentRequestId("smoke")).toBe("req_local_deploy_smoke_054");
  });

  it("starts Console on localhost by default so local browser hydration works", () => {
    withBootstrapEnv(
      {
        CONSOLE_PORT: "3101",
        DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:55432/app",
        MASTER_KEY: "test-master-key",
      },
      () => {
        expect(buildConsoleCommand("dev").args).toEqual([
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          "3101",
        ]);
      },
    );
  });
});

function withBootstrapEnv(env: Record<string, string>, run: () => void): void {
  const previous = {
    CONSOLE_PORT: process.env.CONSOLE_PORT,
    DATABASE_URL: process.env.DATABASE_URL,
    MASTER_KEY: process.env.MASTER_KEY,
    MASTER_KEY_FILE: process.env.MASTER_KEY_FILE,
  };

  try {
    delete process.env.MASTER_KEY_FILE;
    Object.assign(process.env, env);
    run();
  } finally {
    restoreEnv("CONSOLE_PORT", previous.CONSOLE_PORT);
    restoreEnv("DATABASE_URL", previous.DATABASE_URL);
    restoreEnv("MASTER_KEY", previous.MASTER_KEY);
    restoreEnv("MASTER_KEY_FILE", previous.MASTER_KEY_FILE);
  }
}

function restoreEnv(name: keyof NodeJS.ProcessEnv, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
