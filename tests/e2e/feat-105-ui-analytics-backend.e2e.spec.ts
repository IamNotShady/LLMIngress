import { randomUUID } from "node:crypto";
import { getConsoleAnalyticsSnapshot } from "@llmingress/db/console-analytics";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { analyticsIds, seedAnalyticsBackendData } from "../support/analytics-backend";

test("analytics backend returns filtered kpis trends p95 route and savings metrics", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_analytics_e2e_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedAnalyticsBackendData(fixture);

    const snapshot = await getConsoleAnalyticsSnapshot({
      databaseUrl: fixture.databaseUrl,
      end: new Date("2026-06-18T14:00:00.000Z"),
      filters: {
        agentId: analyticsIds.targetAgentId,
        providerId: analyticsIds.targetProviderId,
        virtualModelId: analyticsIds.targetVirtualModelId,
      },
      start: new Date("2026-06-18T10:00:00.000Z"),
      topLimit: 5,
    });

    expect(snapshot.window).toMatchObject({
      bucket: "hour",
      end: new Date("2026-06-18T14:00:00.000Z"),
      previousEnd: new Date("2026-06-18T10:00:00.000Z"),
      previousStart: new Date("2026-06-18T06:00:00.000Z"),
      start: new Date("2026-06-18T10:00:00.000Z"),
    });
    expect(snapshot.current).toMatchObject({
      failureCount: 1,
      fallbackEventCount: 2,
      fallbackRequestCount: 1,
      p95LatencyMs: 650,
      requestCount: 3,
      totalCostUsd: "0.00300000",
      totalSavingsUsd: "0.00700000",
      totalTokens: 300,
    });
    expect(snapshot.current.failureRate).toBeCloseTo(1 / 3, 6);
    expect(snapshot.previous).toMatchObject({
      requestCount: 1,
      totalCostUsd: "0.00070000",
      totalSavingsUsd: "0.00100000",
      totalTokens: 50,
    });
    expect(snapshot.timeseries.map((point) => point.bucketStart.toISOString())).toEqual([
      "2026-06-18T10:00:00.000Z",
      "2026-06-18T11:00:00.000Z",
      "2026-06-18T12:00:00.000Z",
    ]);
    expect(snapshot.topAgents.map((item) => item.id)).toEqual([analyticsIds.targetAgentId]);
    expect(snapshot.topProviderModels.map((item) => item.id)).toEqual([
      analyticsIds.targetProviderModelId,
    ]);
    expect(snapshot.topVirtualModels.map((item) => item.id)).toEqual([
      analyticsIds.targetVirtualModelId,
    ]);
    expect(snapshot.routeMetrics).toEqual([
      expect.objectContaining({
        failedFallbackEventCount: 1,
        fallbackEventCount: 2,
        fallbackRequestCount: 1,
        id: analyticsIds.targetRoutePolicyId,
        requestCount: 3,
        succeededFallbackEventCount: 1,
      }),
    ]);
  } finally {
    await fixture.dispose();
  }
});
