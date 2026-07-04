import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePostgresPools } from "../../packages/db/src/client";
import { readGatewayRequestId } from "../../packages/db/src/gateway-auth";
import {
  attachGatewayProviderCredentials,
  normalizeOpenAIChatCompletionRequest,
  refreshProviderOAuthTokenWithLock,
} from "../../packages/db/src/gateway-chat-completions";
import type { GatewayRouteCandidateSnapshot } from "../../packages/db/src/gateway-config-reload";
import { estimateTextTokens } from "../../packages/db/src/gateway-request-metadata";
import { selectGatewayBaselineCandidate } from "../../packages/db/src/gateway-usage-recorder";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createSecretEncryption } from "../../packages/security/src/secret-encryption";

describe("gateway request hygiene", () => {
  afterAll(async () => {
    await closePostgresPools();
  });

  it("accepts only safe client request ids", () => {
    expect(readGatewayRequestId({ "x-request-id": "abc-123._:id" })).toBe("abc-123._:id");
    expect(readGatewayRequestId({ "x-request-id": "bad id\n" })).toMatch(/^gw_/);
    expect(readGatewayRequestId({ "x-request-id": "x".repeat(200) })).toMatch(/^gw_/);
  });

  it("estimates CJK text as one token per character", () => {
    expect(estimateTextTokens(["你好世界"])).toBe(4);
    expect(estimateTextTokens(["abcdefgh"])).toBe(2);
    expect(estimateTextTokens(["你好ab"])).toBe(3);
  });

  it("selects the baseline candidate without mutating the route snapshot", () => {
    const second = candidateSnapshot({ candidateOrder: 2 });
    const first = candidateSnapshot({ candidateOrder: 1 });
    const routePolicy = {
      candidates: [second, first],
      id: "route-1",
      strategy: "fixed",
      virtualModelId: "vm-1",
      virtualModelName: "vm",
    };

    expect(selectGatewayBaselineCandidate(routePolicy)).toBe(first);
    expect(routePolicy.candidates).toEqual([second, first]);
  });

  it("normalizes whitelisted OpenAI passthrough parameters and max_completion_tokens", () => {
    const normalized = normalizeOpenAIChatCompletionRequest(
      {
        max_completion_tokens: 2048,
        max_tokens: 12,
        messages: [{ content: "hi", role: "user" }],
        seed: 7,
        stop: ["END"],
        top_p: 0.9,
      },
      "req-1",
    );

    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(normalized.request.maxOutputTokens).toBe(2048);
      expect(normalized.request.passthrough).toEqual({
        seed: 7,
        stop: ["END"],
        top_p: 0.9,
      });
    }
  });

  it("refreshes an expired OAuth token once under concurrent row-lock contention", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_oauth_single_flight_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const encryption = createSecretEncryption({ kind: "inline", value: "test-master-key" });
      const providerId = randomUUID();
      const providerOAuthId = randomUUID();
      const expired = {
        accessToken: "expired-token",
        expiresAt: Date.now() - 60_000,
        refreshToken: "refresh-token",
        scopes: [],
        tokenType: "Bearer",
      };
      const refreshed = {
        accessToken: "fresh-token",
        expiresAt: Date.now() + 600_000,
        refreshToken: "refresh-token",
        scopes: ["chat"],
        tokenType: "Bearer" as const,
      };
      let refreshCalls = 0;

      await fixture.query(
        `
          insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
          values ($1, 'subscription', 'openai_codex', 'OpenAI Codex', 'http://provider.test/v1', true)
        `,
        [providerId],
      );
      await fixture.query(
        `
          insert into provider_oauth (
            id,
            provider_id,
            encrypted_token,
            token_expires_at,
            completed_at
          )
          values ($1, $2, $3, $4, now())
        `,
        [
          providerOAuthId,
          providerId,
          JSON.stringify(encryption.encrypt(JSON.stringify(expired))),
          new Date(expired.expiresAt),
        ],
      );

      const refresh = async () => {
        refreshCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return refreshed;
      };

      const [first, second] = await Promise.all([
        refreshProviderOAuthTokenWithLock({
          databaseUrl: fixture.databaseUrl,
          encryption,
          providerKey: "openai_codex",
          providerOAuthId,
          refresh,
        }),
        refreshProviderOAuthTokenWithLock({
          databaseUrl: fixture.databaseUrl,
          encryption,
          providerKey: "openai_codex",
          providerOAuthId,
          refresh,
        }),
      ]);

      expect(refreshCalls).toBe(1);
      expect(first.accessToken).toBe("fresh-token");
      expect(second.accessToken).toBe("fresh-token");
    } finally {
      await fixture.dispose();
    }
  });

  it("does not hold the outer credential pool client while refreshing OAuth tokens", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_oauth_pool_release_${randomUUID().replaceAll("-", "_")}`,
    });
    const originalPoolMax = process.env.LLMINGRESS_DB_POOL_MAX;
    await closePostgresPools();
    process.env.LLMINGRESS_DB_POOL_MAX = "1";
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const encryption = createSecretEncryption({ kind: "inline", value: "test-master-key" });
      const providerId = randomUUID();
      const providerOAuthId = randomUUID();
      const expired = {
        accessToken: "expired-token",
        expiresAt: Date.now() - 60_000,
        refreshToken: "refresh-token",
        scopes: [],
        tokenType: "Bearer",
      };
      const refreshed = {
        accessToken: "fresh-token",
        expiresAt: Date.now() + 600_000,
        refreshToken: "refresh-token",
        scopes: ["chat"],
        tokenType: "Bearer",
      };
      let refreshCalls = 0;

      await fixture.query(
        `
          insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
          values ($1, 'subscription', 'openai_codex', 'OpenAI Codex', 'http://provider.test/v1', true)
        `,
        [providerId],
      );
      await fixture.query(
        `
          insert into provider_oauth (
            id,
            provider_id,
            encrypted_token,
            token_expires_at,
            completed_at
          )
          values ($1, $2, $3, $4, now())
        `,
        [
          providerOAuthId,
          providerId,
          JSON.stringify(encryption.encrypt(JSON.stringify(expired))),
          new Date(expired.expiresAt),
        ],
      );

      const attached = await attachGatewayProviderCredentials({
        candidates: [candidateSnapshot({ providerId, providerKey: "openai_codex" })],
        databaseUrl: fixture.databaseUrl,
        masterKeySource: { kind: "inline", value: "test-master-key" },
        refreshProviderOAuthToken: async () => {
          refreshCalls += 1;
          return refreshed;
        },
      });

      expect(refreshCalls).toBe(1);
      expect(attached[0]?.apiKey).toBe("fresh-token");
      expect(attached[0]?.providerApiKeys[0]?.providerOAuthId).toBe(providerOAuthId);
    } finally {
      if (originalPoolMax === undefined) {
        delete process.env.LLMINGRESS_DB_POOL_MAX;
      } else {
        process.env.LLMINGRESS_DB_POOL_MAX = originalPoolMax;
      }
      await closePostgresPools();
      await fixture.dispose();
    }
  });
});

function candidateSnapshot(
  overrides: Partial<GatewayRouteCandidateSnapshot> = {},
): GatewayRouteCandidateSnapshot {
  return {
    candidateOrder: 1,
    displayName: "Fake Model",
    healthStatus: "healthy",
    modelId: "fake-model",
    price: {
      modelId: "fake-model",
      priceVersion: "test",
      providerKey: "openai",
      reason: "no_current_price",
      status: "unknown_price",
    },
    providerId: randomUUID(),
    providerKey: "openai",
    providerModelId: randomUUID(),
    ...overrides,
  };
}
