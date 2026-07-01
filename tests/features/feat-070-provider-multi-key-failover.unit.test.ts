import { describe, expect, it } from "vitest";
import {
  executeFallbackChain,
  type FallbackChainCandidate,
} from "../../packages/db/src/gateway-fallback-chain";
import { loadSqlMigrations } from "../../packages/db/src/index";

describe("feat-070 provider multi-key failover", () => {
  it("declares provider API key multi-key schema and fallback event key attribution", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0013" && candidate.name === "provider_multi_key_failover",
    );

    expect(migration?.sql).toContain(
      "alter table provider_api_keys drop constraint if exists provider_api_keys_provider_id_key",
    );
    expect(migration?.sql).toContain("provider_api_key_id uuid");
    expect(migration?.sql).toContain("provider_api_key_prefix text");
  });

  it("tries all active keys for a provider before falling back to another provider", async () => {
    const calls: string[] = [];
    const candidate = buildCandidate({
      apiKey: "bad-provider-key-070",
      providerApiKeyId: "key_bad_070",
      providerApiKeyPrefix: "bad-prov",
      providerApiKeys: [
        {
          apiKey: "bad-provider-key-070",
          providerApiKeyId: "key_bad_070",
          keyPrefix: "bad-prov",
        },
        {
          apiKey: "sk-good-provider-key-070",
          providerApiKeyId: "key_good_070",
          keyPrefix: "sk-good-",
        },
      ],
      providerModelId: "primary-provider-model",
    });
    const fallbackCandidate = buildCandidate({
      apiKey: "sk-fallback-provider-key-070",
      providerApiKeyId: "key_fallback_070",
      providerApiKeyPrefix: "sk-fallb",
      providerModelId: "fallback-provider-model",
    });
    const result = await executeFallbackChain({
      adapter: {
        chatCompletion: async ({ target }) => {
          calls.push(`${target.modelId}:${target.apiKey}`);
          if (target.apiKey.includes("bad-provider-key")) {
            return {
              body: { error: { code: "invalid_api_key", message: "Invalid key" } },
              errorCode: "invalid_api_key",
              errorMessage: "Invalid key",
              ok: false,
              retryable: false,
              statusCode: 401,
            };
          }
          return {
            body: { id: "ok" },
            ok: true,
            providerRequestId: "ok",
            statusCode: 200,
          };
        },
      },
      candidates: [candidate, fallbackCandidate],
      request: {
        messages: [{ content: "hello", role: "user" }],
      },
    });

    expect(calls).toEqual([
      "primary-model:bad-provider-key-070",
      "primary-model:sk-good-provider-key-070",
    ]);
    expect(result.selectedCandidate.providerModelId).toBe("primary-provider-model");
    expect(result.selectedCandidate.providerApiKeyId).toBe("key_good_070");
    expect(result.failedAttempts).toEqual([
      {
        attemptOrder: 1,
        errorCode: "invalid_api_key",
        errorMessage: "Invalid key",
        failedBeforeFirstByte: false,
        providerApiKeyId: "key_bad_070",
        providerApiKeyPrefix: "bad-prov",
        providerModelId: "primary-provider-model",
        retryable: false,
        statusCode: 401,
      },
    ]);
  });
});

function buildCandidate(
  input: Partial<FallbackChainCandidate> & {
    apiKey: string;
    providerApiKeyId: string;
    providerApiKeyPrefix: string;
    providerModelId: string;
  },
): FallbackChainCandidate {
  return {
    apiKey: input.apiKey,
    baseUrl: "https://provider.example/v1",
    candidateOrder: input.candidateOrder ?? 1,
    displayName: "Primary Model",
    healthStatus: "unknown" as const,
    modelId: input.modelId ?? "primary-model",
    price: {
      modelId: input.modelId ?? "primary-model",
      priceVersion: "mvp-static-2026-06-13",
      providerKey: "openai",
      reason: "model_not_in_builtin_registry",
      status: "unknown_price",
    },
    providerApiKeyId: input.providerApiKeyId,
    providerApiKeyPrefix: input.providerApiKeyPrefix,
    providerApiKeys: input.providerApiKeys,
    providerId: input.providerId ?? "provider",
    providerKey: "openai",
    providerModelId: input.providerModelId,
  };
}
