import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { closePostgresPools } from "../../packages/db/src/client";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import type { GatewayRouteCandidateSnapshot } from "../../packages/gateway-runtime/src/gateway-config-reload";
import {
  toGatewayErrorResponseParts,
  truncateProviderMessage,
} from "../../packages/gateway-runtime/src/gateway-errors";
import { buildFallbackExhaustionError } from "../../packages/gateway-runtime/src/gateway-fallback-chain";
import {
  attachGatewayProviderCredentialsLeniently,
  readGatewayMasterKeySource,
} from "../../packages/gateway-runtime/src/gateway-provider-credentials";
import { executeGatewayStreamingRequest } from "../../packages/gateway-runtime/src/gateway-streaming";
import { createSecretEncryption } from "../../packages/security/src/secret-encryption";

describe("gateway error fidelity", () => {
  afterAll(async () => {
    await closePostgresPools();
  });

  it("throws provider_rejected_request with upstream status for non-retryable provider 4xx", async () => {
    expect(
      buildFallbackExhaustionError({
        errorCode: "provider_error",
        errorMessage: "context length exceeded",
        statusCode: 400,
      }),
    ).toMatchObject({
      code: "provider_rejected_request",
      message: "context length exceeded",
      upstreamStatus: 400,
    });
  });

  it("throws provider_rate_limited for upstream 429", async () => {
    expect(
      buildFallbackExhaustionError({
        errorCode: "provider_error",
        errorMessage: "slow down",
        statusCode: 429,
      }),
    ).toMatchObject({
      code: "provider_rate_limited",
      upstreamStatus: 429,
    });
  });

  it("throws provider_request_failed when retryable network failures exhaust the chain", async () => {
    expect(
      buildFallbackExhaustionError({
        errorCode: "provider_request_failed",
        errorMessage: "socket hang up",
        statusCode: null,
      }),
    ).toMatchObject({
      code: "provider_request_failed",
      upstreamStatus: null,
    });
  });

  it("maps unknown errors to the fallback gateway status", () => {
    expect(toGatewayErrorResponseParts(new Error("boom"), "provider_request_failed")).toEqual({
      code: "provider_request_failed",
      message: undefined,
      statusCode: 502,
    });
  });

  it("truncates provider messages and strips control characters", () => {
    const message = `bad\u0000\n${"x".repeat(2048)}`;
    const truncated = truncateProviderMessage(message);
    expect(truncated.length).toBeLessThanOrEqual(500);
    expect(truncated).not.toContain("\u0000");
    expect(truncated).not.toContain("\n");
  });

  it("attaches credentials leniently by skipping only the candidate missing keys", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_error_fidelity_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const keyedProviderId = randomUUID();
      const missingProviderId = randomUUID();
      await seedProvider(fixture, keyedProviderId, true);
      await seedProvider(fixture, missingProviderId, false);

      const attached = await attachGatewayProviderCredentialsLeniently({
        candidates: [
          candidateSnapshot({ providerId: missingProviderId }),
          candidateSnapshot({ providerId: keyedProviderId }),
        ],
        databaseUrl: fixture.databaseUrl,
        masterKeySource: readGatewayMasterKeySource({ MASTER_KEY: "test-master-key" }),
      });

      expect(attached).toHaveLength(1);
      expect(attached[0]?.providerId).toBe(keyedProviderId);
      expect(attached[0]?.apiKey).toBe("fake-provider-key");
    } finally {
      await fixture.dispose();
    }
  });

  it("throws provider_credentials_missing when every candidate lacks credentials", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_error_missing_${randomUUID().replaceAll("-", "_")}`,
    });
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const providerId = randomUUID();
      await seedProvider(fixture, providerId, false);

      await expect(
        attachGatewayProviderCredentialsLeniently({
          candidates: [candidateSnapshot({ providerId })],
          databaseUrl: fixture.databaseUrl,
          masterKeySource: readGatewayMasterKeySource({ MASTER_KEY: "test-master-key" }),
        }),
      ).rejects.toMatchObject({
        code: "provider_credentials_missing",
      });
    } finally {
      await fixture.dispose();
    }
  });

  it("retries streaming with the next provider api key after a retryable key failure", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_stream_keys_${randomUUID().replaceAll("-", "_")}`,
    });
    const originalMasterKey = process.env.MASTER_KEY;
    process.env.MASTER_KEY = "test-master-key";
    try {
      await runMigrations({ databaseUrl: fixture.databaseUrl });
      const providerId = randomUUID();
      const providerModelId = randomUUID();
      await seedProvider(fixture, providerId, false);
      await seedProviderApiKey(fixture, providerId, "bad-retry-key", 1);
      await seedProviderApiKey(fixture, providerId, "good-key", 2);

      const authorizationHeaders: string[] = [];
      const response = await executeGatewayStreamingRequest({
        agentId: randomUUID(),
        databaseUrl: fixture.databaseUrl,
        fetch: async (_url, init) => {
          const authorization = readAuthorization(init?.headers);
          authorizationHeaders.push(authorization ?? "");
          if (authorization?.includes("bad-retry-key")) {
            return new Response(JSON.stringify({ error: { message: "retry me" } }), {
              headers: { "content-type": "application/json" },
              status: 500,
            });
          }
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"delta":"ok"}\n\n'));
                controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" }, status: 200 },
          );
        },
        protocol: "chat_completions",
        requestBody: {
          messages: [{ content: "ping", role: "user" }],
          stream: true,
        },
        requestId: "req-stream-keys",
        snapshot: {
          loadedAt: new Date(),
          providers: [],
          routePolicies: [
            {
              candidates: [
                candidateSnapshot({
                  providerId,
                  providerModelId,
                }),
              ],
              id: "route-1",
              strategy: "fixed",
              virtualModelId: "vm-1",
              virtualModelName: "vm",
            },
          ],
          version: 1,
        },
        virtualModel: {
          id: "vm-1",
          name: "vm",
        },
      });

      if (!response.ok) {
        throw new Error(JSON.stringify(response.body));
      }
      expect(response.ok).toBe(true);
      expect(authorizationHeaders).toEqual(["Bearer bad-retry-key", "Bearer good-key"]);
      if (response.ok) {
        for await (const _chunk of response.body) {
          // drain stream so completion hooks can settle
        }
      }
    } finally {
      if (originalMasterKey === undefined) {
        delete process.env.MASTER_KEY;
      } else {
        process.env.MASTER_KEY = originalMasterKey;
      }
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
    providerId: overrides.providerId ?? randomUUID(),
    providerKey: "openai",
    providerModelId: randomUUID(),
    ...overrides,
  };
}

async function seedProvider(
  fixture: {
    query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
  },
  providerId: string,
  withKey: boolean,
): Promise<void> {
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'OpenAI', 'http://provider.test/v1', true)
    `,
    [providerId],
  );
  if (!withKey) {
    return;
  }
  await seedProviderApiKey(fixture, providerId, "fake-provider-key", 100);
}

async function seedProviderApiKey(
  fixture: {
    query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
  },
  providerId: string,
  apiKey: string,
  priority: number,
): Promise<void> {
  const encrypted = createSecretEncryption({ kind: "inline", value: "test-master-key" }).encrypt(
    apiKey,
  );
  await fixture.query(
    `
      insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, priority)
      values ($1, $2, $3, $4, $5, $6)
    `,
    [
      randomUUID(),
      providerId,
      apiKey.slice(0, 12),
      JSON.stringify(encrypted),
      encrypted.keyId,
      priority,
    ],
  );
}

function readAuthorization(headers: HeadersInit | undefined): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get("authorization") ?? undefined;
  }
  if (Array.isArray(headers)) {
    return headers.find(([key]) => key.toLowerCase() === "authorization")?.[1];
  }
  const value = headers.authorization ?? headers.Authorization;
  return Array.isArray(value) ? value.join(" ") : value;
}
