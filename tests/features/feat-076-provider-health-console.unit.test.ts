import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatProviderHealthFailureCount,
  formatProviderHealthLatestProbe,
  formatProviderHealthStaleStatus,
  formatProviderHealthStatus,
  listConsoleProviderHealthSummaries,
} from "../../apps/console/src/server/provider-health";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

describe("feat-076 provider health console summary", () => {
  const fixtures: Fixture[] = [];

  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map((fixture) => fixture.dispose()));
  });

  it("formats status latest probe consecutive failures and stale labels", () => {
    const now = new Date("2026-06-16T06:00:00.000Z");
    const recentProbe = new Date("2026-06-16T05:58:30.000Z");
    const staleProbe = new Date("2026-06-16T05:30:00.000Z");

    expect(formatProviderHealthStatus("healthy")).toBe("Healthy");
    expect(formatProviderHealthStatus("degraded")).toBe("Degraded");
    expect(formatProviderHealthStatus("unhealthy")).toBe("Unhealthy");
    expect(formatProviderHealthStatus(null)).toBe("Unknown");
    expect(formatProviderHealthFailureCount(3)).toBe("Consecutive failures: 3");
    expect(formatProviderHealthLatestProbe({ latestProbeAt: recentProbe, trigger: "manual" })).toBe(
      "Latest probe: 2026-06-16T05:58:30.000Z via manual",
    );
    expect(formatProviderHealthLatestProbe({ latestProbeAt: null, trigger: null })).toBe(
      "Latest probe: Never",
    );
    expect(
      formatProviderHealthStaleStatus({
        latestProbeAt: recentProbe,
        now,
        staleAfterMs: 5 * 60 * 1000,
      }),
    ).toBe("Fresh");
    expect(
      formatProviderHealthStaleStatus({
        latestProbeAt: staleProbe,
        now,
        staleAfterMs: 5 * 60 * 1000,
      }),
    ).toBe("Stale");
    expect(formatProviderHealthStaleStatus({ latestProbeAt: null, now })).toBe("No probe");
  });

  it("lists provider and model health summaries with latest events and stale status", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_health_console_unit_${randomUUID().replaceAll("-", "_")}`,
    });
    fixtures.push(fixture);

    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedProviderHealthConsoleData(fixture);

    const summaries = await listConsoleProviderHealthSummaries({
      databaseUrl: fixture.databaseUrl,
      now: new Date("2026-06-16T06:00:00.000Z"),
      staleAfterMs: 5 * 60 * 1000,
    });

    expect(summaries).toEqual([
      {
        consecutiveFailures: 0,
        displayName: "Health Console Provider",
        id: seeded.providerId,
        isStale: false,
        latestProbeAt: new Date("2026-06-16T05:58:30.000Z"),
        models: [
          {
            consecutiveFailures: 3,
            displayName: "Health Console Model",
            id: seeded.providerModelId,
            isStale: true,
            latestProbeAt: new Date("2026-06-16T05:30:00.000Z"),
            modelId: "health-console-model",
            providerId: seeded.providerId,
            status: "unhealthy",
            trigger: "request_path",
          },
        ],
        providerKey: "health-console",
        status: "healthy",
        trigger: "manual",
      },
      {
        consecutiveFailures: 0,
        displayName: "No Probe Provider",
        id: seeded.noProbeProviderId,
        isStale: true,
        latestProbeAt: null,
        models: [],
        providerKey: "no-probe",
        status: "unknown",
        trigger: null,
      },
    ]);
  });
});

async function seedProviderHealthConsoleData(fixture: Fixture): Promise<{
  noProbeProviderId: string;
  providerId: string;
  providerModelId: string;
}> {
  const providerId = randomUUID();
  const noProbeProviderId = randomUUID();
  const providerModelId = randomUUID();
  const providerEventId = randomUUID();
  const modelEventId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'health-console', 'Health Console Provider', 'https://example.com/v1', true),
             ($2, 'api_key', 'no-probe', 'No Probe Provider', 'https://no-probe.example.com/v1', true)
    `,
    [providerId, noProbeProviderId],
  );
  await fixture.query(
    `
      insert into provider_models (
        id,
        provider_id,
        model_id,
        display_name,
        availability
      )
      values ($1, $2, 'health-console-model', 'Health Console Model', 'available')
    `,
    [providerModelId, providerId],
  );
  await fixture.query(
    `
      insert into provider_health_events (
        id,
        provider_id,
        provider_model_id,
        trigger,
        status,
        observed_at
      )
      values ($1, $2, null, 'manual', 'healthy', '2026-06-16T05:58:30.000Z'),
             ($3, $2, $4, 'request_path', 'failed', '2026-06-16T05:30:00.000Z')
    `,
    [providerEventId, providerId, modelEventId, providerModelId],
  );
  await fixture.query(
    `
      insert into provider_health_summary (
        id,
        provider_id,
        provider_model_id,
        last_event_id,
        status,
        consecutive_failures,
        last_success_at,
        last_failure_at,
        updated_at
      )
      values ($1, $2, null, $3, 'healthy', 0, '2026-06-16T05:58:30.000Z', null, '2026-06-16T05:58:30.000Z'),
             ($4, $2, $5, $6, 'unhealthy', 3, null, '2026-06-16T05:30:00.000Z', '2026-06-16T05:30:00.000Z')
    `,
    [randomUUID(), providerId, providerEventId, randomUUID(), providerModelId, modelEventId],
  );

  return {
    noProbeProviderId,
    providerId,
    providerModelId,
  };
}
