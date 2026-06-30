import { describe, expect, it } from "vitest";
import type { ConfigChangedNotification } from "../../packages/config/src/index";
import { createGatewayConfigRuntime } from "../../packages/db/src/gateway-config-reload";
import type { GatewayRuntimeStatusEvent } from "../../packages/db/src/gateway-gateway-runtime-status";

describe("feat-099 gateway runtime status heartbeat", () => {
  it("records a startup event and a reload-succeeded event for each applied config version", async () => {
    const snapshots = [
      snapshot(1, ["openai"]),
      snapshot(2, ["openai", "anthropic"]),
      snapshot(3, ["anthropic"]),
    ];
    const events: GatewayRuntimeStatusEvent[] = [];
    let notify: ((notification: ConfigChangedNotification) => void) | undefined;

    const runtime = createGatewayConfigRuntime({
      loadLatestSnapshot: async () => {
        const next = snapshots.shift();
        if (!next) {
          throw new Error("unexpected snapshot load");
        }
        return next;
      },
      createConfigChangedListener: async (onNotification) => {
        notify = onNotification;
        return { close: async () => {} };
      },
      recordRuntimeStatus: async (event) => {
        events.push(event);
      },
      reconcileIntervalMs: 0,
      heartbeatIntervalMs: 0,
    });

    await runtime.start();

    const startup = events.filter((event) => event.type === "startup");
    expect(startup).toHaveLength(1);
    expect(startup[0]).toMatchObject({ type: "startup", appliedConfigVersion: 1 });
    expect(startup[0]).toHaveProperty("startedAt");
    expect((startup[0] as { startedAt: Date }).startedAt).toBeInstanceOf(Date);

    notify?.({
      channel: "config_changed",
      version: 2,
      configVersionId: "2",
      source: "console",
      changeCount: 1,
    });
    await expect.poll(() => runtime.getSnapshot().version).toBe(2);
    await expect
      .poll(() => events.filter((event) => event.type === "reload-succeeded").length)
      .toBe(1);
    expect(events.find((event) => event.type === "reload-succeeded")).toMatchObject({
      type: "reload-succeeded",
      appliedConfigVersion: 2,
      targetConfigVersion: 2,
    });

    await runtime.reconcile();
    expect(runtime.getSnapshot().version).toBe(3);
    expect(events.filter((event) => event.type === "reload-succeeded")).toHaveLength(2);
    expect(events.filter((event) => event.type === "reload-succeeded").at(-1)).toMatchObject({
      type: "reload-succeeded",
      appliedConfigVersion: 3,
      targetConfigVersion: 3,
    });

    await runtime.stop();
  });

  it("refreshes the heartbeat on the periodic interval and stops after the runtime stops", async () => {
    const events: GatewayRuntimeStatusEvent[] = [];
    const runtime = createGatewayConfigRuntime({
      loadLatestSnapshot: async () => snapshot(5, ["openai"]),
      enableNotifications: false,
      recordRuntimeStatus: async (event) => {
        events.push(event);
      },
      reconcileIntervalMs: 0,
      heartbeatIntervalMs: 10,
    });

    await runtime.start();
    await expect
      .poll(() => events.filter((event) => event.type === "heartbeat").length, { timeout: 2_000 })
      .toBeGreaterThanOrEqual(2);

    expect(events.find((event) => event.type === "heartbeat")).toMatchObject({
      type: "heartbeat",
      appliedConfigVersion: 5,
    });

    await runtime.stop();
    const afterStop = events.filter((event) => event.type === "heartbeat").length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(events.filter((event) => event.type === "heartbeat").length).toBe(afterStop);
  });

  it("records a reload-failed event and keeps the previous snapshot when a reload throws", async () => {
    const events: GatewayRuntimeStatusEvent[] = [];
    let loadCount = 0;
    const runtime = createGatewayConfigRuntime({
      loadLatestSnapshot: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return snapshot(4, ["openai"]);
        }
        throw new Error("snapshot load boom");
      },
      enableNotifications: false,
      recordRuntimeStatus: async (event) => {
        events.push(event);
      },
      reconcileIntervalMs: 0,
      heartbeatIntervalMs: 0,
    });

    await runtime.start();
    await expect(runtime.reconcile()).rejects.toThrow("snapshot load boom");

    expect(runtime.getSnapshot().version).toBe(4);
    const failed = events.filter((event) => event.type === "reload-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      type: "reload-failed",
      targetConfigVersion: null,
      error: "snapshot load boom",
    });

    await runtime.stop();
  });
});

function snapshot(version: number, providerKeys: string[]) {
  return {
    loadedAt: new Date("2026-01-01T00:00:00.000Z"),
    providers: providerKeys.map((providerKey) => ({
      displayName: providerKey,
      id: providerKey,
      providerKey,
    })),
    routePolicies: [],
    version,
  };
}
