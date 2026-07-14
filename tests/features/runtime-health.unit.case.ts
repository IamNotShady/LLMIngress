import { describe, expect, it } from "vitest";
import { readGatewayHealthStatus } from "../../packages/gateway-runtime/src/gateway-health";

describe("runtime health", () => {
  it("reports readiness from database and in-memory config state", async () => {
    const loadedSnapshot = {
      getReadinessStatus: () => ({ hasLoadedSnapshot: true, lastReloadFailed: false }),
      getSnapshot: () => ({ loadedAt: new Date("2026-07-11T00:00:00.000Z"), version: 0 }),
    };

    await expect(
      readGatewayHealthStatus({ checkDatabase: async () => true, configRuntime: loadedSnapshot }),
    ).resolves.toEqual({
      body: {
        configLoadedAt: "2026-07-11T00:00:00.000Z",
        configVersion: 0,
        service: "gateway",
        status: "ok",
      },
      statusCode: 200,
    });
    await expect(
      readGatewayHealthStatus({ checkDatabase: async () => false, configRuntime: loadedSnapshot }),
    ).resolves.toMatchObject({ body: { status: "unavailable" }, statusCode: 503 });
    await expect(
      readGatewayHealthStatus({
        checkDatabase: async () => true,
        configRuntime: {
          ...loadedSnapshot,
          getReadinessStatus: () => ({ hasLoadedSnapshot: true, lastReloadFailed: true }),
        },
      }),
    ).resolves.toMatchObject({ body: { status: "degraded" }, statusCode: 200 });
    await expect(
      readGatewayHealthStatus({
        checkDatabase: async () => true,
        configRuntime: {
          ...loadedSnapshot,
          getReadinessStatus: () => ({ hasLoadedSnapshot: false, lastReloadFailed: false }),
        },
      }),
    ).resolves.toMatchObject({ body: { status: "unavailable" }, statusCode: 503 });
  });
});
