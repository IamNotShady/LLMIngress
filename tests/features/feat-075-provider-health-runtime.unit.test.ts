import { describe, expect, it } from "vitest";
import {
  buildHealthSummaryChangedPayload,
  buildProviderHealthSummaryUpdate,
} from "../../packages/db/src/provider-health";

describe("feat-075 provider health summary runtime", () => {
  it("folds health events into provider summary status and consecutive failures", () => {
    const firstFailure = buildProviderHealthSummaryUpdate({
      eventStatus: "failed",
      observedAt: new Date("2026-06-16T05:00:00.000Z"),
      previous: null,
    });
    expect(firstFailure).toEqual({
      consecutiveFailures: 1,
      lastFailureAt: new Date("2026-06-16T05:00:00.000Z"),
      lastSuccessAt: null,
      status: "degraded",
    });

    const thirdFailure = buildProviderHealthSummaryUpdate({
      eventStatus: "failed",
      observedAt: new Date("2026-06-16T05:01:00.000Z"),
      previous: {
        consecutiveFailures: 2,
        lastFailureAt: new Date("2026-06-16T05:00:00.000Z"),
        lastSuccessAt: null,
        status: "degraded",
      },
    });
    expect(thirdFailure).toEqual({
      consecutiveFailures: 3,
      lastFailureAt: new Date("2026-06-16T05:01:00.000Z"),
      lastSuccessAt: null,
      status: "unhealthy",
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
        status: "degraded",
        summaryId: "summary-075",
      }),
    ).toEqual({
      consecutiveFailures: 2,
      eventId: "event-075",
      providerId: "provider-075",
      providerModelId: "model-075",
      status: "degraded",
      summaryId: "summary-075",
    });
  });
});
