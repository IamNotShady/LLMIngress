import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  executeProviderFallbackAttempts,
  type FallbackChainCandidate,
} from "../../packages/db/src/gateway-fallback-chain";

const repoRoot = process.cwd();

describe("feat-123 gateway ponytail cleanup", () => {
  it("keeps the gateway app as the HTTP shell only", () => {
    const files = readdirSync(join(repoRoot, "apps/gateway/src"))
      .filter((name) => name.endsWith(".ts"))
      .sort();

    expect(files).toEqual(["cors.ts", "main.ts"]);
  });

  it("removes direct gateway app dependencies now owned by the db package", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "apps/gateway/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(manifest.dependencies).toEqual({
      "@llmingress/config": "workspace:*",
      "@llmingress/db": "workspace:*",
      fastify: "^5.8.5",
    });
  });

  it("does not publish a gateway route-engine wrapper from db", () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, "packages/db/package.json"), "utf8"),
    ) as { exports?: Record<string, unknown> };

    expect(manifest.exports).not.toHaveProperty("./gateway-route-engine");
  });

  it("shares provider fallback attempts across JSON protocols", async () => {
    const adapterCall = vi
      .fn()
      .mockResolvedValueOnce({
        errorCode: "provider_request_failed",
        errorMessage: "try fallback",
        ok: false,
        statusCode: null,
      })
      .mockResolvedValueOnce({ body: { id: "ok" }, ok: true, statusCode: 200 });
    const failedAttempts: unknown[] = [];

    const result = await executeProviderFallbackAttempts({
      callProvider: adapterCall,
      candidates: [candidate("primary"), candidate("fallback")],
      fallbackAttempts: failedAttempts,
      requestId: "req_feat_123_retry",
    });

    expect(result?.candidate.providerModelId).toBe("fallback");
    expect(result?.result).toMatchObject({ body: { id: "ok" }, ok: true });
    expect(adapterCall).toHaveBeenCalledTimes(2);
    expect(failedAttempts).toEqual([
      {
        attemptOrder: 1,
        errorCode: "provider_request_failed",
        errorMessage: "try fallback",
        failedBeforeFirstByte: true,
        providerModelId: "primary",
        retryable: true,
        statusCode: null,
      },
    ]);
  });

  it("stops shared provider fallback attempts on non-retryable failures", async () => {
    const adapterCall = vi.fn().mockResolvedValueOnce({
      errorCode: "invalid_api_key",
      errorMessage: "bad key",
      ok: false,
      statusCode: 401,
    });
    const failedAttempts: unknown[] = [];

    const result = await executeProviderFallbackAttempts({
      callProvider: adapterCall,
      candidates: [candidate("primary"), candidate("fallback")],
      fallbackAttempts: failedAttempts,
      requestId: "req_feat_123_stop",
    });

    expect(result).toBeUndefined();
    expect(adapterCall).toHaveBeenCalledTimes(1);
    expect(failedAttempts).toEqual([
      {
        attemptOrder: 1,
        errorCode: "invalid_api_key",
        errorMessage: "bad key",
        failedBeforeFirstByte: false,
        providerModelId: "primary",
        retryable: false,
        statusCode: 401,
      },
    ]);
  });
});

function candidate(providerModelId: string): FallbackChainCandidate {
  return {
    apiKey: "provider-key",
    baseUrl: "https://provider.example/v1",
    candidateOrder: providerModelId === "primary" ? 1 : 2,
    displayName: providerModelId,
    healthStatus: "unknown",
    modelId: providerModelId,
    price: {
      currency: "USD",
      inputUsdPerMillionTokens: 1,
      modelId: providerModelId,
      outputUsdPerMillionTokens: 1,
      priceVersion: "test",
      providerKey: "openai",
      snapshotDate: "2026-06-30",
      source: "manual",
      sourceUrl: "manual://test",
      status: "priced",
      unit: "per_1m_tokens",
    },
    providerId: `provider-${providerModelId}`,
    providerKey: "openai",
    providerModelId,
  };
}
