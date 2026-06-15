import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
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
});
