import { describe, expect, it } from "vitest";
import {
  formatGatewayHeartbeatStatus,
  formatRuntimeErrorEntry,
  formatRuntimeReloadResult,
} from "../../apps/console/src/server/runtime";

describe("feat-048 gateway runtime console page", () => {
  it("labels fresh stale and missing gateway heartbeats", () => {
    const now = new Date("2026-06-14T12:00:00.000Z");

    expect(
      formatGatewayHeartbeatStatus({
        heartbeatAt: new Date("2026-06-14T11:59:30.000Z"),
        now,
      }),
    ).toBe("Healthy");
    expect(
      formatGatewayHeartbeatStatus({
        heartbeatAt: new Date("2026-06-14T11:57:30.000Z"),
        now,
      }),
    ).toBe("Stale");
    expect(formatGatewayHeartbeatStatus({ heartbeatAt: null, now })).toBe("Missing");
  });

  it("formats reload result and runtime error entries", () => {
    expect(
      formatRuntimeReloadResult({
        lastReloadAt: new Date("2026-06-14T11:58:00.000Z"),
        lastReloadError: null,
        lastReloadStatus: "succeeded",
      }),
    ).toBe("Reload succeeded at 2026-06-14T11:58:00.000Z");

    expect(
      formatRuntimeReloadResult({
        lastReloadAt: new Date("2026-06-14T11:59:00.000Z"),
        lastReloadError: "provider key missing",
        lastReloadStatus: "failed",
      }),
    ).toBe("Reload failed at 2026-06-14T11:59:00.000Z: provider key missing");

    expect(
      formatRuntimeErrorEntry({
        createdAt: new Date("2026-06-14T11:59:30.000Z"),
        errorCode: "config_reload_failed",
        errorMessage: "Provider key missing",
        processId: "gateway-runtime-048",
        processType: "gateway",
        severity: "fatal",
      }),
    ).toBe(
      "fatal gateway/gateway-runtime-048: config_reload_failed - Provider key missing at 2026-06-14T11:59:30.000Z",
    );
  });
});
