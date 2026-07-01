import { randomUUID } from "node:crypto";
import {
  getConsoleAnalyticsSnapshot,
  normalizeConsoleAnalyticsInput,
} from "@llmingress/db/console-analytics";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTestPostgresFixture,
  loadSqlMigrations,
  runMigrations,
} from "../../packages/db/src/index";
import { analyticsIds, seedAnalyticsBackendData } from "../support/analytics-backend";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-105 analytics backend", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("ships only the analytics lookup indexes required for current runtime tables", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0029" && candidate.name === "analytics_backend_indexes",
    );

    expect(migration?.sql).toContain("idx_request_activity_started_at_id");
    expect(migration?.sql).toContain("on request_activity (started_at desc, id desc)");
    expect(migration?.sql).toContain("idx_request_activity_virtual_model_started_at");
    expect(migration?.sql).toContain(
      "on request_activity (virtual_model_id, started_at desc, id desc)",
    );
    expect(migration?.sql).toContain("idx_request_activity_route_policy_started_at");
    expect(migration?.sql).toContain(
      "on request_activity (route_policy_id, started_at desc, id desc)",
    );
    expect(migration?.sql).toContain("values (1, '0029')");
    expect(migration?.sql).not.toContain("create table");
    expect(migration?.sql).not.toContain("alter table");
  });

  it("normalizes date range bucket filters and top limit", () => {
    const normalized = normalizeConsoleAnalyticsInput({
      bucket: "bad-bucket",
      end: "2026-06-18T14:00:00.000Z",
      filters: {
        agentId: ` ${analyticsIds.targetAgentId} `,
        providerId: analyticsIds.targetProviderId,
        virtualModelId: analyticsIds.targetVirtualModelId,
      },
      start: "2026-06-18T10:00:00.000Z",
      topLimit: 50,
    });

    expect(normalized).toEqual({
      bucket: "hour",
      end: new Date("2026-06-18T14:00:00.000Z"),
      filters: {
        agentId: analyticsIds.targetAgentId,
        providerId: analyticsIds.targetProviderId,
        virtualModelId: analyticsIds.targetVirtualModelId,
      },
      previousEnd: new Date("2026-06-18T10:00:00.000Z"),
      previousStart: new Date("2026-06-18T06:00:00.000Z"),
      start: new Date("2026-06-18T10:00:00.000Z"),
      topLimit: 20,
    });
    expect(
      normalizeConsoleAnalyticsInput({
        end: "2026-06-22T00:00:00.000Z",
        start: "2026-06-18T00:00:00.000Z",
      }).bucket,
    ).toBe("day");
    expect(() =>
      normalizeConsoleAnalyticsInput({
        end: "2026-06-18T10:00:00.000Z",
        start: "2026-06-18T10:00:00.000Z",
      }),
    ).toThrow("Analytics end date must be after start date.");
    expect(() =>
      normalizeConsoleAnalyticsInput({
        end: "2026-06-18T10:00:00.000Z",
        start: "not-a-date",
      }),
    ).toThrow("Analytics start and end dates are required.");
  });

  it("aggregates filtered current previous timeseries top and route fallback metrics", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_analytics_unit_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedAnalyticsBackendData(fixture);

    const snapshot = await getConsoleAnalyticsSnapshot({
      databaseUrl: fixture.databaseUrl,
      end: "2026-06-18T14:00:00.000Z",
      filters: {
        agentId: analyticsIds.targetAgentId,
        providerId: analyticsIds.targetProviderId,
        virtualModelId: analyticsIds.targetVirtualModelId,
      },
      start: "2026-06-18T10:00:00.000Z",
      topLimit: 3,
    });

    expect(snapshot.current).toMatchObject({
      failureCount: 1,
      fallbackEventCount: 2,
      fallbackRequestCount: 1,
      inputTokens: 120,
      outputTokens: 180,
      p95LatencyMs: 650,
      requestCount: 3,
      totalCostUsd: "0.00300000",
      totalSavingsUsd: "0.00700000",
      totalTokens: 300,
    });
    expect(snapshot.current.failureRate).toBeCloseTo(1 / 3, 6);
    expect(snapshot.previous).toMatchObject({
      failureCount: 0,
      fallbackEventCount: 0,
      requestCount: 1,
      totalCostUsd: "0.00070000",
      totalSavingsUsd: "0.00100000",
      totalTokens: 50,
    });
    expect(snapshot.timeseries.map(selectTimeseriesFields)).toEqual([
      {
        bucketStart: "2026-06-18T10:00:00.000Z",
        failureCount: 0,
        fallbackEventCount: 0,
        requestCount: 1,
        totalCostUsd: "0.00100000",
      },
      {
        bucketStart: "2026-06-18T11:00:00.000Z",
        failureCount: 0,
        fallbackEventCount: 2,
        requestCount: 1,
        totalCostUsd: "0.00200000",
      },
      {
        bucketStart: "2026-06-18T12:00:00.000Z",
        failureCount: 1,
        fallbackEventCount: 0,
        requestCount: 1,
        totalCostUsd: "0.00000000",
      },
    ]);
    expect(snapshot.topAgents).toEqual([
      expect.objectContaining({
        id: analyticsIds.targetAgentId,
        label: "Analytics Target Agent",
        requestCount: 3,
      }),
    ]);
    expect(snapshot.topProviderModels).toEqual([
      expect.objectContaining({
        id: analyticsIds.targetProviderModelId,
        requestCount: 3,
      }),
    ]);
    expect(snapshot.topVirtualModels).toEqual([
      expect.objectContaining({
        id: analyticsIds.targetVirtualModelId,
        requestCount: 3,
      }),
    ]);
    expect(snapshot.topRoutes).toEqual([
      expect.objectContaining({
        id: analyticsIds.targetRoutePolicyId,
        requestCount: 3,
      }),
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
  });
});

function selectTimeseriesFields(input: {
  bucketStart: Date;
  failureCount: number;
  fallbackEventCount: number;
  requestCount: number;
  totalCostUsd: string | null;
}) {
  return {
    bucketStart: input.bucketStart.toISOString(),
    failureCount: input.failureCount,
    fallbackEventCount: input.fallbackEventCount,
    requestCount: input.requestCount,
    totalCostUsd: input.totalCostUsd,
  };
}
