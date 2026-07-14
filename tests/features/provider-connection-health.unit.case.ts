import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countProviderAggregateHealthStatuses } from "../../apps/console/src/app/_lib/provider-health";
import { buildProviderConnectionProbeJobPayload } from "../../packages/db/src/provider-jobs";
import {
  isProviderCredentialFailure,
  selectProviderProbeModels,
} from "../../packages/provider/src/connectivity";
import {
  type ClaimedJob,
  createJobRunner,
  type JobStore,
} from "../../packages/worker-runtime/src/worker-job-runner";
import { providerConnectionProbeRetryDelayMs } from "../../packages/worker-runtime/src/worker-provider-connection-probe";

describe("provider connection health", () => {
  it("selects at most three distinct probe models using the existing ranking", () => {
    expect(
      selectProviderProbeModels(
        [
          {
            contextWindow: 128_000,
            inputUsdPerMillionTokens: 3,
            modelId: "expensive",
            outputUsdPerMillionTokens: 6,
          },
          {
            contextWindow: 32_000,
            inputUsdPerMillionTokens: 0.2,
            modelId: "cheap-mini",
            outputUsdPerMillionTokens: 0.4,
          },
          {
            contextWindow: 64_000,
            inputUsdPerMillionTokens: 1,
            modelId: "middle",
            outputUsdPerMillionTokens: 2,
          },
          {
            contextWindow: 8_000,
            inputUsdPerMillionTokens: 0.01,
            modelId: "embedding-model",
            outputUsdPerMillionTokens: 0.01,
          },
          {
            contextWindow: 16_000,
            inputUsdPerMillionTokens: 4,
            modelId: "fourth-chat",
            outputUsdPerMillionTokens: 8,
          },
        ],
        3,
      ),
    ).toEqual(["cheap-mini", "middle", "expensive"]);
  });

  it("uses the agreed 5, 10, 30, then 60 minute retry lifecycle", () => {
    expect([1, 2, 3, 4, 9].map(providerConnectionProbeRetryDelayMs)).toEqual([
      5 * 60_000,
      10 * 60_000,
      30 * 60_000,
      60 * 60_000,
      60 * 60_000,
    ]);
  });

  it("triggers Gateway probes only for authentication and account-limit failures", () => {
    expect(isProviderCredentialFailure({ statusCode: 401 })).toBe(true);
    expect(isProviderCredentialFailure({ statusCode: 403 })).toBe(true);
    expect(isProviderCredentialFailure({ statusCode: 402 })).toBe(true);
    expect(isProviderCredentialFailure({ statusCode: 429 })).toBe(true);
    expect(
      isProviderCredentialFailure({
        errorCode: "billing_error",
        errorMessage: "insufficient balance",
        statusCode: 400,
      }),
    ).toBe(true);
    expect(isProviderCredentialFailure({ statusCode: 500 })).toBe(false);
    expect(isProviderCredentialFailure({ errorCode: "model_not_found", statusCode: 404 })).toBe(
      false,
    );
    expect(isProviderCredentialFailure({ errorCode: "socket_error", statusCode: null })).toBe(
      false,
    );
  });

  it("uses a connection-scoped job payload with no Provider or model probe scope", () => {
    expect(
      buildProviderConnectionProbeJobPayload({
        providerConnectionId: "connection-1",
        providerId: "provider-1",
        source: "manual_probe",
      }),
    ).toEqual({
      providerConnectionId: "connection-1",
      providerId: "provider-1",
      source: "manual_probe",
    });
  });

  it("counts aggregate Provider health instead of counting connections", () => {
    expect(
      countProviderAggregateHealthStatuses([
        { enabled: true, providerId: "mixed", status: "healthy" },
        { enabled: true, providerId: "mixed", status: "unhealthy" },
        { enabled: true, providerId: "failed", status: "unhealthy" },
        { enabled: true, providerId: "failed", status: "unhealthy" },
        { enabled: true, providerId: "checking", status: "checking" },
        { enabled: true, providerId: "checking", status: "unhealthy" },
        { enabled: false, providerId: "disabled", status: "disabled" },
      ]),
    ).toEqual({ healthy: 1, unhealthy: 1 });
  });

  it("cancels a job when its handler returns a canceled result", async () => {
    const claimedJob: ClaimedJob = {
      attemptNumber: 1,
      id: "probe-canceled",
      jobType: "provider_connection_probe",
      maxAttempts: 3,
      payload: {},
      priority: 0,
      trigger: "system",
    };
    let claimed = false;
    let cancelCalls = 0;
    let completeCalls = 0;
    let failCalls = 0;
    const store: JobStore = {
      cancelJob: async (input) => {
        cancelCalls += 1;
        expect(input).toMatchObject({
          attemptNumber: 1,
          jobId: "probe-canceled",
          result: { canceled: true, reason: "provider_disabled_or_missing" },
          workerId: "provider-health-test",
        });
        return true;
      },
      claimNextJob: async () => {
        if (claimed) {
          return null;
        }
        claimed = true;
        return claimedJob;
      },
      completeJob: async () => {
        completeCalls += 1;
        return true;
      },
      failJob: async () => {
        failCalls += 1;
        return true;
      },
      renewJobLease: async () => true,
    };
    const runner = createJobRunner({
      handlers: {
        provider_connection_probe: async () => ({
          canceled: true,
          reason: "provider_disabled_or_missing",
        }),
      },
      store,
      workerId: "provider-health-test",
    });

    await expect(runner.runOnce()).resolves.toBe(true);
    expect({ cancelCalls, completeCalls, failCalls }).toEqual({
      cancelCalls: 1,
      completeCalls: 0,
      failCalls: 0,
    });
  });

  it("clears OAuth credential material on every soft-delete path", () => {
    const providerConnections = readFileSync("packages/db/src/providers.ts", "utf8");
    const consoleProviders = readFileSync("packages/db/src/console-providers.ts", "utf8");
    const directDelete = providerConnections.slice(
      providerConnections.indexOf("export async function deleteProviderOAuthConnection"),
      providerConnections.indexOf("export async function readProviderOAuthRuntimeConnection"),
    );
    const providerDelete = consoleProviders.slice(
      consoleProviders.indexOf("export async function deleteProvider"),
      consoleProviders.indexOf("async function clearProviderHealthForCurrentConnections"),
    );

    for (const deletePath of [directDelete, providerDelete]) {
      expect(deletePath).toContain("encrypted_token = null");
      expect(deletePath).toContain("token_expires_at = null");
      expect(deletePath).toContain("pending_state = null");
      expect(deletePath).toContain("pending_code_verifier = null");
      expect(deletePath).toContain("pending_code_challenge = null");
      expect(deletePath).toContain("pending_expires_at = null");
      expect(deletePath).toContain("completed_at = null");
    }
  });

  it("keeps the baseline schema and Console connection-scoped", () => {
    const migration = readFileSync("packages/db/migrations/0001_core_baseline.sql", "utf8");
    const healthStart = migration.indexOf("CREATE TABLE public.provider_health_events");
    const modelsStart = migration.indexOf("CREATE TABLE public.provider_models");
    const healthSchema = migration.slice(healthStart, modelsStart);
    const console = readFileSync(
      "apps/console/src/app/_modules/providers-client-section.tsx",
      "utf8",
    );
    const worker = readFileSync("apps/worker/src/main.ts", "utf8");

    expect(healthSchema).toContain("provider_connection_id uuid NOT NULL");
    expect(healthSchema).not.toContain("provider_model_id");
    expect(migration).toContain("'provider_connection_probe'::text");
    expect(migration).not.toContain("'provider_connectivity_check'::text");
    expect(migration).not.toContain("last_test_status");
    expect(worker).toContain("provider_connection_probe:");
    expect(worker).not.toContain("provider_connectivity_check:");
    expect(console).toContain("/api/provider-health-probes");
    expect(console).not.toContain("ProviderApiKeyTestStatusPill");
    expect(console).not.toContain("ConsoleProviderModelHealthSummary");
  });
});
