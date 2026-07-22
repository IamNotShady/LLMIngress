import { randomUUID } from "node:crypto";
import { createTestPostgresFixture, runMigrations } from "@llmingress/db";
import {
  completeProviderOAuthAuthorization,
  pollProviderOAuthDeviceAuthorization,
  startProviderOAuthConnection,
} from "@llmingress/db/console-provider-oauth";
import {
  createProviderOAuthDevicePendingConnection,
  readProviderOAuthPendingConnection,
  readProviderOAuthRuntimeConnection,
} from "@llmingress/db/providers";
import {
  pollProviderOAuthUserCodeToken,
  refreshProviderOAuthToken,
  requestProviderOAuthUserCode,
} from "../../packages/provider/src/oauth";
import type { EncryptionKeySource } from "../../packages/security/src/encryption-key";
import { createSecretEncryption } from "../../packages/security/src/secret-encryption";
import { describe, expect, it } from "vitest";

const CLIENT_ID = "78257093-7e40-4613-99e0-527b14b39113";
const encryptionKeySource: EncryptionKeySource = { kind: "inline", value: "test-master-key" };

type RecordedRequest = { body: string; url: string };

function recordingFetch(
  responder: (call: number) => { body: unknown; status?: number },
): { calls: RecordedRequest[]; fetch: typeof globalThis.fetch } {
  const calls: RecordedRequest[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const rawBody = init?.body;
    calls.push({
      body: rawBody instanceof URLSearchParams ? rawBody.toString() : String(rawBody),
      url: String(url),
    });
    const { body, status = 200 } = responder(calls.length);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status,
    });
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

describe("provider oauth device-code engine", () => {
  it("posts the PKCE challenge to the device-code URL and rewrites the verification host", async () => {
    const { calls, fetch } = recordingFetch(() => ({
      body: {
        expired_in: 900,
        interval: 5,
        state: "flow-123",
        user_code: "WDJB-MJHT",
        verification_uri: "https://www.minimax.io/oauth-authorize",
      },
    }));

    const result = await requestProviderOAuthUserCode({
      codeChallenge: "challenge-abc",
      fetch,
      providerKey: "minimax_coding",
      state: "flow-123",
    });

    expect(calls[0]?.url).toBe("https://api.minimax.io/oauth/code");
    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get("response_type")).toBe("code");
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("scope")).toBe("group_id profile model.completion");
    expect(body.get("code_challenge")).toBe("challenge-abc");
    expect(body.get("code_challenge_method")).toBe("S256");
    expect(body.get("state")).toBe("flow-123");

    expect(result.userCode).toBe("WDJB-MJHT");
    // www.minimax.io/oauth-authorize 307-redirects to the marketing home page.
    expect(result.verificationUri).toBe("https://platform.minimax.io/oauth-authorize");
    expect(result.intervalSeconds).toBe(5);
  });

  it("rejects a mismatched device-code response state", async () => {
    const { fetch } = recordingFetch(() => ({
      body: { state: "other", user_code: "X", verification_uri: "https://x.test/oauth-authorize" },
    }));
    await expect(
      requestProviderOAuthUserCode({
        codeChallenge: "c",
        fetch,
        providerKey: "minimax_coding",
        state: "flow-123",
      }),
    ).rejects.toThrow(/state did not match/);
  });

  it("normalizes a millisecond poll interval to seconds", async () => {
    const { fetch } = recordingFetch(() => ({
      body: { interval: 2000, user_code: "X", verification_uri: "https://x.test/other" },
    }));
    const result = await requestProviderOAuthUserCode({
      codeChallenge: "c",
      fetch,
      providerKey: "minimax_coding",
      state: "s",
    });
    expect(result.intervalSeconds).toBe(2);
    // A non-/oauth-authorize path is left untouched.
    expect(result.verificationUri).toBe("https://x.test/other");
  });

  it("polls with the user-code grant and judges pending/error/success from the body status", async () => {
    const pending = recordingFetch(() => ({ body: { status: "pending" } }));
    expect(
      (
        await pollProviderOAuthUserCodeToken({
          codeVerifier: "v",
          fetch: pending.fetch,
          providerKey: "minimax_coding",
          userCode: "U",
        })
      ).status,
    ).toBe("pending");

    // Anything that is not "success" (and not an error) is treated as pending.
    const authorizing = recordingFetch(() => ({ body: { status: "authorizing" } }));
    expect(
      (
        await pollProviderOAuthUserCodeToken({
          codeVerifier: "v",
          fetch: authorizing.fetch,
          providerKey: "minimax_coding",
          userCode: "U",
        })
      ).status,
    ).toBe("pending");

    const statusError = recordingFetch(() => ({ body: { status: "error" } }));
    expect(
      (
        await pollProviderOAuthUserCodeToken({
          codeVerifier: "v",
          fetch: statusError.fetch,
          providerKey: "minimax_coding",
          userCode: "U",
        })
      ).status,
    ).toBe("error");

    const httpError = recordingFetch(() => ({ body: "nope", status: 500 }));
    expect(
      (
        await pollProviderOAuthUserCodeToken({
          codeVerifier: "v",
          fetch: httpError.fetch,
          providerKey: "minimax_coding",
          userCode: "U",
        })
      ).status,
    ).toBe("error");
  });

  it("normalizes expired_in and captures resource_url on a successful poll", async () => {
    const { calls, fetch } = recordingFetch(() => ({
      body: {
        access_token: "access-1",
        expired_in: 3600,
        refresh_token: "refresh-1",
        resource_url: "https://api.minimax.io/anthropic/v1",
        status: "success",
      },
    }));

    const result = await pollProviderOAuthUserCodeToken({
      codeVerifier: "verifier-1",
      fetch,
      nowMs: () => 1000,
      providerKey: "minimax_coding",
      userCode: "USER-1",
    });

    expect(calls[0]?.url).toBe("https://api.minimax.io/oauth/token");
    const body = new URLSearchParams(calls[0]?.body);
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:user_code");
    expect(body.get("user_code")).toBe("USER-1");
    expect(body.get("code_verifier")).toBe("verifier-1");
    expect(body.get("client_id")).toBe(CLIENT_ID);

    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(result.token.accessToken).toBe("access-1");
      expect(result.token.refreshToken).toBe("refresh-1");
      expect(result.token.resourceUrl).toBe("https://api.minimax.io/anthropic/v1");
      expect(result.token.expiresAt).toBe(1000 + 3600 * 1000);
    }
  });

  it("normalizes expired_in on the refresh path too", async () => {
    const { fetch } = recordingFetch(() => ({
      body: { access_token: "refreshed", expired_in: 7200 },
    }));
    const blob = await refreshProviderOAuthToken({
      fetch,
      nowMs: () => 5000,
      providerKey: "minimax_coding",
      refreshToken: "refresh-1",
    });
    expect(blob.expiresAt).toBe(5000 + 7200 * 1000);
    expect(blob.refreshToken).toBe("refresh-1");
  });
});

describe("provider oauth device-code storage", () => {
  it("applies 0003 idempotently and enforces the flow_type check", async () => {
    const fixture = await createDeviceFixture();
    try {
      // Re-running migrations is a no-op (already-applied rows are skipped).
      await runMigrations({ databaseUrl: fixture.databaseUrl });

      const columns = await fixture.query<{ column_name: string }>(
        `select column_name from information_schema.columns
         where table_name = 'provider_oauth'
           and column_name in ('pending_user_code','pending_verification_uri','pending_interval_seconds','flow_type')
         order by column_name`,
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        "flow_type",
        "pending_interval_seconds",
        "pending_user_code",
        "pending_verification_uri",
      ]);

      const providerId = await seedSubscriptionProvider(fixture);
      // Existing/authorization-code rows default flow_type to authorization_code.
      const defaulted = await fixture.query<{ flow_type: string }>(
        `insert into provider_oauth (id, provider_id, pending_state)
         values ($1, $2, $3) returning flow_type`,
        [randomUUID(), providerId, randomUUID()],
      );
      expect(defaulted.rows[0]?.flow_type).toBe("authorization_code");

      await expect(
        fixture.query(
          `insert into provider_oauth (id, provider_id, flow_type) values ($1, $2, 'bogus')`,
          [randomUUID(), providerId],
        ),
      ).rejects.toThrow(/provider_oauth_flow_type_check/);
    } finally {
      await fixture.dispose();
    }
  });

  it("starts a device connection, clears earlier pending device rows, and polls to complete", async () => {
    const fixture = await createDeviceFixture();
    try {
      const providerId = await seedSubscriptionProvider(fixture);

      const startFetch = recordingFetch(() => ({
        body: {
          expired_in: 900,
          interval: 3,
          user_code: "AAAA-1111",
          verification_uri: "https://www.minimax.io/oauth-authorize",
        },
      }));
      const first = await startProviderOAuthConnection({
        databaseUrl: fixture.databaseUrl,
        fetch: startFetch.fetch,
        providerId,
      });
      expect(first.flowType).toBe("device_code");
      if (first.flowType !== "device_code") {
        throw new Error("expected device-code start result");
      }
      expect(first.userCode).toBe("AAAA-1111");
      expect(first.verificationUri).toBe("https://platform.minimax.io/oauth-authorize");

      const pending = await readProviderOAuthPendingConnection({
        databaseUrl: fixture.databaseUrl,
        providerOAuthId: first.connection.id,
      });
      expect(pending.flowType).toBe("device_code");
      expect(pending.pendingUserCode).toBe("AAAA-1111");
      expect(pending.pendingCodeVerifier).toBeTruthy();

      // A second start invalidates the first still-pending device row.
      const second = await startProviderOAuthConnection({
        databaseUrl: fixture.databaseUrl,
        fetch: startFetch.fetch,
        providerId,
      });
      const pendingRows = await fixture.query<{ count: number }>(
        `select count(*)::integer as count from provider_oauth
         where provider_id = $1 and flow_type = 'device_code' and completed_at is null
           and deleted_at is null`,
        [providerId],
      );
      expect(pendingRows.rows[0]?.count).toBe(1);

      if (second.flowType !== "device_code") {
        throw new Error("expected device-code start result");
      }
      const pollFetch = recordingFetch(() => ({
        body: {
          access_token: "device-access",
          expired_in: 3600,
          refresh_token: "device-refresh",
          resource_url: "https://api.minimax.io/anthropic/v1",
          status: "success",
        },
      }));
      const result = await pollProviderOAuthDeviceAuthorization({
        databaseUrl: fixture.databaseUrl,
        encryptionKeySource,
        fetch: pollFetch.fetch,
        providerOAuthId: second.connection.id,
      });
      expect(result.status).toBe("complete");
      expect(result.providerId).toBe(providerId);

      // resource_url survives the encrypt/store/decrypt round-trip.
      const runtime = await readProviderOAuthRuntimeConnection({
        databaseUrl: fixture.databaseUrl,
        providerOAuthId: second.connection.id,
      });
      const decrypted = JSON.parse(
        createSecretEncryption(encryptionKeySource).decrypt(
          runtime.encryptedToken as never,
        ),
      ) as { accessToken: string; resourceUrl?: string };
      expect(decrypted.accessToken).toBe("device-access");
      expect(decrypted.resourceUrl).toBe("https://api.minimax.io/anthropic/v1");
    } finally {
      await fixture.dispose();
    }
  });

  it("returns expired without hitting upstream once the code has lapsed", async () => {
    const fixture = await createDeviceFixture();
    try {
      const providerId = await seedSubscriptionProvider(fixture);
      const connection = await createProviderOAuthDevicePendingConnection({
        databaseUrl: fixture.databaseUrl,
        intervalSeconds: 2,
        pendingCodeChallenge: "challenge",
        pendingCodeVerifier: "verifier",
        pendingExpiresAt: new Date(Date.now() - 60_000),
        pendingState: randomUUID(),
        providerId,
        userCode: "EXPI-RED0",
        verificationUri: "https://platform.minimax.io/oauth-authorize",
      });

      const upstream = recordingFetch(() => {
        throw new Error("upstream must not be called for an expired code");
      });
      const result = await pollProviderOAuthDeviceAuthorization({
        databaseUrl: fixture.databaseUrl,
        encryptionKeySource,
        fetch: upstream.fetch,
        providerOAuthId: connection.id,
      });
      expect(result.status).toBe("expired");
      expect(upstream.calls).toHaveLength(0);
    } finally {
      await fixture.dispose();
    }
  });

  it("refuses to complete a device-code row with the authorization-code grant", async () => {
    const fixture = await createDeviceFixture();
    try {
      const providerId = await seedSubscriptionProvider(fixture);
      const connection = await createProviderOAuthDevicePendingConnection({
        databaseUrl: fixture.databaseUrl,
        intervalSeconds: 2,
        pendingCodeChallenge: "challenge",
        pendingCodeVerifier: "verifier",
        pendingExpiresAt: new Date(Date.now() + 600_000),
        pendingState: randomUUID(),
        providerId,
        userCode: "GUAR-DED0",
        verificationUri: "https://platform.minimax.io/oauth-authorize",
      });

      await expect(
        completeProviderOAuthAuthorization({
          callbackInput: "the-pasted-code",
          databaseUrl: fixture.databaseUrl,
          encryptionKeySource,
          providerOAuthId: connection.id,
        }),
      ).rejects.toThrow(/device-code flow/);
    } finally {
      await fixture.dispose();
    }
  });
});

async function createDeviceFixture() {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_oauth_device_${randomUUID().replaceAll("-", "_")}`,
  });
  await runMigrations({ databaseUrl: fixture.databaseUrl });
  return fixture;
}

async function seedSubscriptionProvider(fixture: {
  databaseUrl: string;
  query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
}): Promise<string> {
  const providerId = randomUUID();
  await fixture.query(
    `insert into providers (id, provider_type, provider_key, display_name, enabled)
     values ($1, 'subscription', 'minimax_coding', 'MiniMax Coding Plan', true)`,
    [providerId],
  );
  return providerId;
}
