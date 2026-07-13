import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildProviderConnectionProbeJobPayload } from "../../packages/db/src/provider-jobs";
import {
  isProviderCredentialFailure,
  selectProviderProbeModels,
} from "../../packages/provider/src/connectivity";
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
