import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GatewayRouteCandidateSnapshot } from "../../packages/gateway-runtime/src/gateway-config-reload";
import {
  buildGatewayProviderErrorLog,
  executeProviderFallbackAttempts,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  type FallbackProviderApiKey,
} from "../../packages/gateway-runtime/src/gateway-fallback-chain";

describe("gateway fallback health", () => {
  it("keeps the complete Provider error response in the server log payload", () => {
    const body = {
      detail: "Input must be a list",
      error: { code: "invalid_request", metadata: { field: "input" } },
    };
    const headers = {
      "content-type": "application/json",
      "x-provider-request-id": "provider-request-1",
    };

    expect(
      buildGatewayProviderErrorLog({
        attemptOrder: 2,
        candidate: fallbackCandidate({ modelId: "provider-model" }),
        requestId: "gateway-request-1",
        result: {
          body,
          errorCode: "invalid_request",
          errorMessage: "Provider rejected the request.",
          headers,
          ok: false,
          statusCode: 400,
        },
      }),
    ).toEqual({
      attemptOrder: 2,
      errorCode: "invalid_request",
      errorMessage: "Provider rejected the request.",
      modelId: "provider-model",
      providerId: "provider-1",
      providerKey: "openai",
      providerModelId: "pm-1",
      providerResponseBody: body,
      providerResponseHeaders: headers,
      requestId: "gateway-request-1",
      statusCode: 400,
    });
  });

  it("tries the next credential on auth, quota, and rate-limit failures", async () => {
    const calls: string[] = [];
    const fallbackAttempts: FallbackFailedAttempt[] = [];
    const recordHealthEvent = vi.fn();

    const result = await executeProviderFallbackAttempts({
      callProvider: vi.fn(async ({ providerApiKey }) => {
        calls.push(providerApiKey.keyPrefix ?? "missing");
        if (providerApiKey.keyPrefix === "bad-auth") {
          return {
            errorCode: "invalid_api_key",
            errorMessage: "Invalid API key",
            ok: false,
            statusCode: 401,
          };
        }
        return { body: { ok: true }, ok: true, statusCode: 200 };
      }),
      candidates: [
        fallbackCandidate({
          providerApiKeys: [
            providerKey({ keyPrefix: "bad-auth" }),
            providerKey({ keyPrefix: "good-auth" }),
          ],
        }),
        fallbackCandidate({ providerModelId: "pm-should-not-run" }),
      ],
      fallbackAttempts,
      recordHealthEvent,
    });

    expect(result?.candidate.providerApiKeyPrefix).toBe("good-auth");
    expect(calls).toEqual(["bad-auth", "good-auth"]);
    expect(fallbackAttempts).toMatchObject([
      {
        attemptOrder: 1,
        providerApiKeyPrefix: "bad-auth",
        retryable: true,
        statusCode: 401,
      },
    ]);
    expect(recordHealthEvent).not.toHaveBeenCalled();
  });

  it("skips remaining credentials for 5xx failures and records failed candidate health once", async () => {
    const calls: string[] = [];
    const fallbackAttempts: FallbackFailedAttempt[] = [];
    const recordHealthEvent = vi.fn(async () => ({
      eventId: "event",
      notification: {},
      summaryId: "summary",
    }));

    const result = await executeProviderFallbackAttempts({
      callProvider: vi.fn(async ({ candidate, providerApiKey }) => {
        calls.push(`${candidate.providerModelId}:${providerApiKey.keyPrefix}`);
        if (candidate.providerModelId === "pm-1") {
          return {
            errorCode: "provider_http_error",
            errorMessage: "Provider unavailable",
            ok: false,
            statusCode: 503,
          };
        }
        return { body: { ok: true }, ok: true, statusCode: 200 };
      }),
      candidates: [
        fallbackCandidate({
          providerId: "provider-1",
          providerModelId: "pm-1",
          providerApiKeys: [
            providerKey({ keyPrefix: "first-key" }),
            providerKey({ keyPrefix: "must-not-run" }),
          ],
        }),
        fallbackCandidate({
          providerId: "provider-2",
          providerModelId: "pm-2",
          providerApiKeys: [providerKey({ keyPrefix: "fallback-key" })],
        }),
      ],
      fallbackAttempts,
      recordHealthEvent,
    });

    expect(result?.candidate.providerModelId).toBe("pm-2");
    expect(calls).toEqual(["pm-1:first-key", "pm-2:fallback-key"]);
    expect(fallbackAttempts).toMatchObject([
      {
        attemptOrder: 1,
        providerApiKeyPrefix: "first-key",
        providerModelId: "pm-1",
        retryable: true,
        statusCode: 503,
      },
    ]);
    expect(recordHealthEvent).toHaveBeenCalledOnce();
    expect(recordHealthEvent).toHaveBeenCalledWith({
      event: expect.objectContaining({
        providerId: "provider-1",
        status: "unhealthy",
        trigger: "request_path",
      }),
      providerModelId: "pm-1",
    });
  });

  it("falls back for any Provider HTTP 400 without polluting provider health", async () => {
    const calls: string[] = [];
    const fallbackAttempts: FallbackFailedAttempt[] = [];
    const recordHealthEvent = vi.fn();

    const result = await executeProviderFallbackAttempts({
      callProvider: vi.fn(async ({ candidate, providerApiKey }) => {
        calls.push(`${candidate.providerModelId}:${providerApiKey.keyPrefix}`);
        if (candidate.providerModelId === "pm-1") {
          return {
            errorCode: "provider_http_error",
            errorMessage: "Input must be a list",
            ok: false,
            statusCode: 400,
          };
        }
        return { body: { ok: true }, ok: true, statusCode: 200 };
      }),
      candidates: [
        fallbackCandidate({
          providerId: "provider-1",
          providerModelId: "pm-1",
          providerApiKeys: [
            providerKey({ keyPrefix: "first-key" }),
            providerKey({ keyPrefix: "must-not-run" }),
          ],
        }),
        fallbackCandidate({
          providerId: "provider-2",
          providerModelId: "pm-2",
          providerApiKeys: [providerKey({ keyPrefix: "fallback-key" })],
        }),
      ],
      fallbackAttempts,
      recordHealthEvent,
    });

    expect(result?.candidate.providerModelId).toBe("pm-2");
    expect(calls).toEqual(["pm-1:first-key", "pm-2:fallback-key"]);
    expect(fallbackAttempts).toMatchObject([
      {
        attemptOrder: 1,
        providerApiKeyPrefix: "first-key",
        providerModelId: "pm-1",
        retryable: true,
        statusCode: 400,
      },
    ]);
    expect(recordHealthEvent).not.toHaveBeenCalled();
  });

  it("keeps streaming on the shared fallback attempt executor", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/gateway-runtime/src/gateway-streaming.ts"),
      "utf8",
    );

    expect(source).toContain("executeProviderFallbackAttempts");
    expect(source).not.toContain("buildFallbackFailedAttempt");
    expect(source).not.toContain("readFallbackProviderApiKeys");
    expect(source).not.toMatch(/const\s+retryable\s*=/);
  });
});

function fallbackCandidate(
  overrides: Partial<GatewayRouteCandidateSnapshot & FallbackChainCandidate> = {},
): FallbackChainCandidate {
  return {
    apiKey: "fallback-key",
    baseUrl: "http://provider.test/v1",
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
    providerId: "provider-1",
    providerKey: "openai",
    providerModelId: "pm-1",
    ...overrides,
  };
}

function providerKey(overrides: Partial<FallbackProviderApiKey> = {}): FallbackProviderApiKey {
  return {
    apiKey: "fake-provider-key",
    keyPrefix: "fake-key",
    ...overrides,
  };
}
