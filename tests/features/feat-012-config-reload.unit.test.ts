import { describe, expect, it, vi } from "vitest";
import { createGatewayConfigRuntime } from "../../apps/gateway/src/config-reload";
import type { ConfigChangedNotification } from "../../packages/config/src/index";

describe("feat-012 gateway config snapshot reload", () => {
  it("starts from latest snapshot applies newer notifications and reconciles missed versions", async () => {
    const snapshots = [
      snapshot(1, ["openai"]),
      snapshot(2, ["openai", "anthropic"]),
      snapshot(3, ["anthropic"]),
    ];
    let notify: ((notification: ConfigChangedNotification) => void) | undefined;
    const close = vi.fn(async () => {});
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
        return { close };
      },
      reconcileIntervalMs: 0,
    });

    await runtime.start();
    expect(runtime.getSnapshot()).toMatchObject({
      version: 1,
      providers: [{ providerKey: "openai" }],
    });

    notify?.({
      channel: "config_changed",
      version: 2,
      configVersionId: "2",
      source: "console",
      changeCount: 1,
    });
    await expect.poll(() => runtime.getSnapshot().version).toBe(2);
    expect(runtime.getSnapshot().providers.map((provider) => provider.providerKey)).toEqual([
      "openai",
      "anthropic",
    ]);

    notify?.({
      channel: "config_changed",
      version: 1,
      configVersionId: "1",
      source: "console",
      changeCount: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runtime.getSnapshot().version).toBe(2);

    await runtime.reconcile();
    expect(runtime.getSnapshot()).toMatchObject({
      version: 3,
      providers: [{ providerKey: "anthropic" }],
    });

    await runtime.stop();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not drop a newer notification while a reload is already in flight", async () => {
    let notify: ((notification: ConfigChangedNotification) => void) | undefined;
    let finishSecondLoad: ((snapshot: ReturnType<typeof snapshot>) => void) | undefined;
    const loads = [
      Promise.resolve(snapshot(1, ["openai"])),
      new Promise<ReturnType<typeof snapshot>>((resolve) => {
        finishSecondLoad = resolve;
      }),
      Promise.resolve(snapshot(3, ["openai", "anthropic", "openrouter"])),
    ];
    const runtime = createGatewayConfigRuntime({
      loadLatestSnapshot: async () => {
        const next = loads.shift();
        if (!next) {
          throw new Error("unexpected snapshot load");
        }
        return next;
      },
      createConfigChangedListener: async (onNotification) => {
        notify = onNotification;
        return { close: async () => {} };
      },
      reconcileIntervalMs: 0,
    });

    await runtime.start();
    notify?.({
      channel: "config_changed",
      version: 2,
      configVersionId: "2",
      source: "console",
      changeCount: 1,
    });
    notify?.({
      channel: "config_changed",
      version: 3,
      configVersionId: "3",
      source: "console",
      changeCount: 1,
    });

    finishSecondLoad?.(snapshot(2, ["openai", "anthropic"]));

    await expect.poll(() => runtime.getSnapshot().version).toBe(3);
    expect(runtime.getSnapshot().providers.map((provider) => provider.providerKey)).toEqual([
      "openai",
      "anthropic",
      "openrouter",
    ]);
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
    version,
  };
}
