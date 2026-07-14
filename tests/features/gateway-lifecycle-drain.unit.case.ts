import { describe, expect, it } from "vitest";
import { GatewayBackgroundTaskRegistry } from "../../packages/gateway-runtime/src/gateway-background-tasks";
import {
  createGatewayConfigRuntime,
  type GatewayConfigSnapshot,
} from "../../packages/gateway-runtime/src/gateway-config-reload";
import { gatewayShutdownDrainMs } from "../../packages/gateway-runtime/src/gateway-env";

describe("gateway-lifecycle-drain", () => {
  it("tracks background tasks and reports pending work on drain timeout", async () => {
    const registry = new GatewayBackgroundTaskRegistry();
    let releaseTask: (() => void) | undefined;

    registry.track({
      metadata: { requestId: "req-drain" },
      name: "gateway.activity",
      task: () =>
        new Promise<void>((resolve) => {
          releaseTask = resolve;
        }),
    });

    await expect(registry.drain({ timeoutMs: 5 })).resolves.toEqual({
      pending: [{ metadata: { requestId: "req-drain" }, name: "gateway.activity" }],
      timedOut: true,
    });

    releaseTask?.();
    await expect(registry.drain({ timeoutMs: 100 })).resolves.toEqual({
      pending: [],
      timedOut: false,
    });
  });

  it("continues draining tasks that are scheduled by another background task", async () => {
    const registry = new GatewayBackgroundTaskRegistry();
    let nestedStarted = false;
    let releaseNested: (() => void) | undefined;

    registry.track({
      name: "gateway.stream.activity",
      task: async () => {
        registry.track({
          name: "gateway.activity",
          task: () =>
            new Promise<void>((resolve) => {
              nestedStarted = true;
              releaseNested = resolve;
            }),
        });
      },
    });

    await eventually(() => nestedStarted);
    const drainPromise = registry.drain({ timeoutMs: 100 });
    await delay(20);
    releaseNested?.();

    await expect(drainPromise).resolves.toEqual({
      pending: [],
      timedOut: false,
    });
  });

  it("defaults gateway shutdown drain to ten seconds and rejects invalid values", () => {
    expect(gatewayShutdownDrainMs({})).toBe(10_000);
    expect(gatewayShutdownDrainMs({ GATEWAY_SHUTDOWN_DRAIN_MS: "0" })).toBe(0);
    expect(gatewayShutdownDrainMs({ GATEWAY_SHUTDOWN_DRAIN_MS: "25000" })).toBe(25_000);
    expect(() => gatewayShutdownDrainMs({ GATEWAY_SHUTDOWN_DRAIN_MS: "-1" })).toThrow(
      "GATEWAY_SHUTDOWN_DRAIN_MS must be a non-negative integer.",
    );
  });

  it("stops listeners first and waits for an in-flight scheduled reload to settle", async () => {
    let configChanged: ((notification: { version: number }) => void) | undefined;
    let releaseReload: (() => void) | undefined;
    let closeCalled = false;
    let loadCount = 0;
    const runtime = createGatewayConfigRuntime({
      createConfigChangedListener: async (callback) => {
        configChanged = callback;
        return {
          close: async () => {
            closeCalled = true;
          },
        };
      },
      loadLatestSnapshot: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return snapshot(1);
        }
        return new Promise<GatewayConfigSnapshot>((resolve) => {
          releaseReload = () => resolve(snapshot(2));
        });
      },
      reconcileIntervalMs: 0,
      recordRuntimeStatus: async () => undefined,
    });

    await runtime.start();
    configChanged?.({ version: 2 });
    await Promise.resolve();

    let stopped = false;
    const stopPromise = runtime.stop().then(() => {
      stopped = true;
    });
    await delay(20);

    expect(closeCalled).toBe(true);
    expect(stopped).toBe(false);
    releaseReload?.();
    await stopPromise;
    expect(runtime.getSnapshot().version).toBe(2);
  });

  it("coalesces notifications during an active reload into one trailing reload", async () => {
    let configChanged: ((notification: { version: number }) => void) | undefined;
    let releaseReload: (() => void) | undefined;
    let loadCount = 0;
    const runtime = createGatewayConfigRuntime({
      createConfigChangedListener: async (callback) => {
        configChanged = callback;
        return { close: async () => undefined };
      },
      loadLatestSnapshot: async () => {
        loadCount += 1;
        if (loadCount === 1) {
          return snapshot(1);
        }
        if (loadCount === 2) {
          return new Promise<GatewayConfigSnapshot>((resolve) => {
            releaseReload = () => resolve(snapshot(1));
          });
        }
        return snapshot(1);
      },
      reconcileIntervalMs: 0,
      recordRuntimeStatus: async () => undefined,
    });

    await runtime.start();
    configChanged?.({ version: 2 });
    await Promise.resolve();
    configChanged?.({ version: 3 });
    configChanged?.({ version: 4 });
    releaseReload?.();
    await eventually(() => loadCount >= 3);
    await delay(20);

    expect(loadCount).toBe(3);
  });
});

function snapshot(version: number): GatewayConfigSnapshot {
  return {
    loadedAt: new Date(0),
    providers: [],
    routePolicies: [],
    version,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await delay(5);
  }
  throw new Error("Timed out waiting for predicate.");
}
