import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pooledModules = [
  "packages/db/src/providers.ts",
  "packages/db/src/provider-jobs.ts",
  "packages/worker-runtime/src/worker-model-refresh.ts",
  "packages/worker-runtime/src/worker-provider-connectivity-check.ts",
];

describe("db connection hygiene", () => {
  it("logs postgres pool background errors instead of swallowing them", () => {
    const source = readFileSync("packages/db/src/client.ts", "utf8");
    expect(source).toContain('logger.error({ err: error }, "postgres pool error")');
    expect(source).not.toContain("console.error");
  });

  it("uses the pooled client in provider and worker modules", () => {
    for (const file of pooledModules) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/\bwithPostgresClient\(/);
      expect(source, file).toContain("withPooledPostgresClient");
    }
  });

  it("does not silently swallow concurrency release failures", () => {
    const source = readFileSync("packages/gateway-runtime/src/gateway-protocol-request.ts", "utf8");
    expect(source).not.toContain("catch(() => undefined)");
  });

  it("installs gateway signal handlers and closes worker pools on stop", () => {
    const gatewaySource = readFileSync("apps/gateway/src/main.ts", "utf8");
    expect(gatewaySource).toContain('process.once("SIGTERM"');
    expect(gatewaySource).toContain('process.once("SIGINT"');
    const workerSource = readFileSync("apps/worker/src/main.ts", "utf8");
    expect(workerSource).toContain("closePostgresPools");
  });

  it("keeps runtime-status and the dead observability package removed", () => {
    expect(existsSync("packages/gateway-runtime/src/gateway-gateway-runtime-status.ts")).toBe(
      false,
    );
    expect(existsSync("packages/gateway-runtime/src/gateway-runtime-status.ts")).toBe(false);
    expect(existsSync(["packages", "observability"].join("/"))).toBe(false);
  });
});
