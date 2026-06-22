import { describe, expect, it } from "vitest";
import { loadSqlMigrations } from "../../packages/db/src/index";
import {
  buildHealthSummaryChangedPayload,
  buildProviderHealthSummaryUpdate,
} from "../../packages/db/src/provider-health";

describe("feat-075 provider health summary runtime", () => {
  it("folds health events into provider summary status and consecutive failures", () => {
    const firstFailure = buildProviderHealthSummaryUpdate({
      eventStatus: "auth_failed",
      observedAt: new Date("2026-06-16T05:00:00.000Z"),
      previous: null,
    });
    expect(firstFailure).toEqual({
      consecutiveFailures: 1,
      lastFailureAt: new Date("2026-06-16T05:00:00.000Z"),
      lastSuccessAt: null,
      status: "auth_failed",
    });

    const thirdFailure = buildProviderHealthSummaryUpdate({
      eventStatus: "quota_limited",
      observedAt: new Date("2026-06-16T05:01:00.000Z"),
      previous: {
        consecutiveFailures: 2,
        lastFailureAt: new Date("2026-06-16T05:00:00.000Z"),
        lastSuccessAt: null,
        status: "auth_failed",
      },
    });
    expect(thirdFailure).toEqual({
      consecutiveFailures: 3,
      lastFailureAt: new Date("2026-06-16T05:01:00.000Z"),
      lastSuccessAt: null,
      status: "quota_limited",
    });

    const recovery = buildProviderHealthSummaryUpdate({
      eventStatus: "healthy",
      observedAt: new Date("2026-06-16T05:02:00.000Z"),
      previous: thirdFailure,
    });
    expect(recovery).toEqual({
      consecutiveFailures: 0,
      lastFailureAt: new Date("2026-06-16T05:01:00.000Z"),
      lastSuccessAt: new Date("2026-06-16T05:02:00.000Z"),
      status: "healthy",
    });
  });

  it("builds health_summary_changed notification payloads without secret data", () => {
    expect(
      buildHealthSummaryChangedPayload({
        consecutiveFailures: 2,
        eventId: "event-075",
        providerId: "provider-075",
        providerModelId: "model-075",
        status: "network_error",
        summaryId: "summary-075",
      }),
    ).toEqual({
      consecutiveFailures: 2,
      eventId: "event-075",
      providerId: "provider-075",
      providerModelId: "model-075",
      status: "network_error",
      summaryId: "summary-075",
    });
  });

  it("ships a migration for the provider health status taxonomy", () => {
    const migration = loadSqlMigrations().find((candidate) => candidate.id === "0043");

    expect(migration?.name).toBe("provider_health_status_taxonomy");
    expect(migration?.sql).toContain(
      "status in ('healthy', 'unhealthy', 'auth_failed', 'quota_limited', 'network_error')",
    );
    expect(migration?.sql).toContain(
      "status in ('unknown', 'healthy', 'unhealthy', 'auth_failed', 'quota_limited', 'network_error')",
    );
  });
});
