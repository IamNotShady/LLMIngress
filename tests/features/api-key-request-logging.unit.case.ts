import { randomUUID } from "node:crypto";
import { normalizeApiKeyFormInput } from "@llmingress/db/console-api-keys";
import {
  captureGatewayPayloadValue,
  createGatewayBoundedPayloadAccumulator,
  gatewayPayloadByteLimit,
} from "@llmingress/gateway-runtime/gateway-payload-capture";
import { describe, expect, it } from "vitest";
import { getConsoleActivityDetail } from "../../packages/db/src/console-activity.ts";
import type { TestPostgresFixture } from "../../packages/db/src/index.ts";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index.ts";
import {
  apiKeyRequestLoggingModes,
  isApiKeyRequestLoggingMode,
} from "../../packages/domain/src/index.ts";
import { recordCompletedGatewayRequestActivity } from "../../packages/gateway-runtime/src/gateway-activity-recorder.ts";

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe("the request logging mode an API key carries", () => {
  it("offers exactly the two modes the column allows", () => {
    expect([...apiKeyRequestLoggingModes]).toEqual(["default", "full"]);
    expect(isApiKeyRequestLoggingMode("default")).toBe(true);
    expect(isApiKeyRequestLoggingMode("full")).toBe(true);
    expect(isApiKeyRequestLoggingMode("none")).toBe(false);
    expect(isApiKeyRequestLoggingMode("")).toBe(false);
  });

  it("keeps a mode the form submitted", () => {
    expect(normalizeApiKeyFormInput({ name: "key", requestLoggingMode: "full" })).toMatchObject({
      name: "key",
      requestLoggingMode: "full",
    });
    expect(normalizeApiKeyFormInput({ name: "key", requestLoggingMode: "default" })).toMatchObject({
      requestLoggingMode: "default",
    });
  });

  it("falls back to default when the form said nothing", () => {
    expect(normalizeApiKeyFormInput({ name: "key" }).requestLoggingMode).toBe("default");
    expect(
      normalizeApiKeyFormInput({ name: "key", requestLoggingMode: null }).requestLoggingMode,
    ).toBe("default");
    expect(
      normalizeApiKeyFormInput({ name: "key", requestLoggingMode: "  " }).requestLoggingMode,
    ).toBe("default");
  });

  it("refuses a mode outside the two, naming the field", () => {
    let refusal: unknown;
    try {
      normalizeApiKeyFormInput({ name: "key", requestLoggingMode: "everything" });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal).toMatchObject({
      code: "api_key_request_logging_mode_invalid",
      details: { field: "requestLoggingMode" },
    });
  });
});

describe("capturing one side of a request for a full-logging key", () => {
  it("keeps a body that fits as the object it was", () => {
    const body = { messages: [{ content: "hello", role: "user" }], model: "gpt-4o-mini" };
    const captured = captureGatewayPayloadValue(body);

    expect(captured.truncated).toBe(false);
    expect(captured.value).toEqual(body);
    expect(captured.bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
  });

  it("replaces every NUL a nested string or key carries", () => {
    // jsonb refuses a NUL inside a string and a client's JSON may legally carry
    // one, so without this the whole activity row would fail to insert.
    const captured = captureGatewayPayloadValue({
      [`nested${NUL}key`]: { deep: [`a${NUL}b`, { deeper: `c${NUL}` }] },
      plain: "no nul",
    });

    expect(JSON.stringify(captured.value)).not.toContain("\\u0000");
    expect(captured.value).toEqual({
      [`nested${REPLACEMENT}key`]: {
        deep: [`a${REPLACEMENT}b`, { deeper: `c${REPLACEMENT}` }],
      },
      plain: "no nul",
    });
    expect(captured.truncated).toBe(false);
  });

  it("truncates a body past the limit to text and reports the original size", () => {
    const oversized = { text: "a".repeat(gatewayPayloadByteLimit + 4_096) };
    const originalBytes = Buffer.byteLength(JSON.stringify(oversized));
    const captured = captureGatewayPayloadValue(oversized);

    expect(captured.truncated).toBe(true);
    expect(typeof captured.value).toBe("string");
    expect(Buffer.byteLength(captured.value as string)).toBeLessThanOrEqual(
      gatewayPayloadByteLimit,
    );
    expect(captured.bytes).toBe(originalBytes);
    expect(captured.value as string).toContain('{"text":"aaa');
  });

  it("never splits a multi-byte character while truncating", () => {
    const captured = captureGatewayPayloadValue({
      text: "你好".repeat(gatewayPayloadByteLimit / 4),
    });

    expect(captured.truncated).toBe(true);
    expect(captured.value as string).not.toContain(REPLACEMENT);
  });

  it("records an empty body rather than throwing on a value JSON cannot hold", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const captured = captureGatewayPayloadValue(circular);

    expect(captured.value).toBe("");
    expect(captured.bytes).toBe(0);
    expect(captured.truncated).toBe(false);
  });
});

describe("accumulating a streamed response for a full-logging key", () => {
  it("joins the chunks it was handed, whatever they arrived as", () => {
    const accumulator = createGatewayBoundedPayloadAccumulator();
    accumulator.append('data: {"a":1}\n\n');
    accumulator.append(Buffer.from("data: [DONE]\n\n"));

    const read = accumulator.read();
    expect(read.value).toBe('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(read.truncated).toBe(false);
    expect(read.bytes).toBe(Buffer.byteLength(read.value));
  });

  it("reads the same answer twice", () => {
    const accumulator = createGatewayBoundedPayloadAccumulator();
    accumulator.append("data: one\n\n");

    expect(accumulator.read()).toEqual(accumulator.read());
  });

  it("stops buffering past the limit but keeps counting what streamed", () => {
    const accumulator = createGatewayBoundedPayloadAccumulator();
    const chunk = "x".repeat(256 * 1024);
    for (let index = 0; index < 6; index += 1) {
      accumulator.append(chunk);
    }

    const read = accumulator.read();
    expect(read.truncated).toBe(true);
    expect(read.bytes).toBe(6 * 256 * 1024);
    expect(Buffer.byteLength(read.value)).toBeLessThanOrEqual(gatewayPayloadByteLimit);
  });

  it("replaces a NUL byte the provider streamed", () => {
    const accumulator = createGatewayBoundedPayloadAccumulator();
    accumulator.append(Buffer.from(`data: a${NUL}b\n\n`, "utf8"));

    expect(accumulator.read().value).toBe(`data: a${REPLACEMENT}b\n\n`);
  });
});

describe("what a recorded request keeps of its bodies", () => {
  it("stores the captured bodies, their sizes and their truncation as one payload", async () => {
    await withMigratedFixture(async (fixture) => {
      const ids = await seedRecordingEntities(fixture);
      const requestId = "req-logging-full";

      await recordCompletedGatewayRequestActivity({
        activityId: randomUUID(),
        apiKeyId: ids.apiKeyId,
        apiKeyPrefix: "llmi_logging",
        completedAt: new Date("2026-07-05T00:00:01.000Z"),
        databaseUrl: fixture.databaseUrl,
        model: "logging-vm",
        payload: {
          // A client body may legally carry a NUL, and jsonb refuses one inside
          // a string: unreplaced, this insert would lose the whole activity.
          requestBody: captureGatewayPayloadValue({
            messages: [{ content: `hello${NUL}there`, role: "user" }],
          }),
          responseBody: { bytes: 4_194_304, truncated: true, value: "data: partial" },
        },
        protocol: "chat_completions",
        requestId,
        responseBody: { id: "provider-response" },
        route: { providerId: ids.providerId, providerModelId: ids.providerModelId },
        startedAt: new Date("2026-07-05T00:00:00.000Z"),
        statusCode: 200,
        stream: true,
        virtualModelId: ids.virtualModelId,
      });

      const detail = await getConsoleActivityDetail({
        databaseUrl: fixture.databaseUrl,
        requestId,
      });
      expect(detail?.payload).toEqual({
        requestBody: { messages: [{ content: `hello${REPLACEMENT}there`, role: "user" }] },
        requestBytes: Buffer.byteLength(
          JSON.stringify({ messages: [{ content: `hello${NUL}there`, role: "user" }] }),
        ),
        requestTruncated: false,
        responseBody: "data: partial",
        responseBytes: 4_194_304,
        responseTruncated: true,
      });
    });
  });

  it("leaves the payload null for a request that captured nothing", async () => {
    await withMigratedFixture(async (fixture) => {
      const ids = await seedRecordingEntities(fixture);
      const requestId = "req-logging-default";

      await recordCompletedGatewayRequestActivity({
        activityId: randomUUID(),
        apiKeyId: ids.apiKeyId,
        apiKeyPrefix: "llmi_logging",
        completedAt: new Date("2026-07-05T00:00:01.000Z"),
        databaseUrl: fixture.databaseUrl,
        model: "logging-vm",
        protocol: "chat_completions",
        requestId,
        responseBody: { id: "provider-response" },
        route: { providerId: ids.providerId, providerModelId: ids.providerModelId },
        startedAt: new Date("2026-07-05T00:00:00.000Z"),
        statusCode: 200,
        stream: false,
        virtualModelId: ids.virtualModelId,
      });

      const stored = await fixture.query<{ payload: unknown }>(
        "select payload from request_activity where request_id = $1",
        [requestId],
      );
      expect(stored.rows[0]?.payload).toBeNull();

      const detail = await getConsoleActivityDetail({
        databaseUrl: fixture.databaseUrl,
        requestId,
      });
      expect(detail?.payload).toBeNull();
    });
  });
});

async function withMigratedFixture<T>(
  run: (fixture: TestPostgresFixture) => Promise<T>,
): Promise<T> {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_request_logging_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    return await run(fixture);
  } finally {
    await fixture.dispose();
  }
}

async function seedRecordingEntities(fixture: TestPostgresFixture) {
  const ids = {
    apiKeyId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    virtualModelId: randomUUID(),
  };
  await fixture.query(
    "insert into api_keys (id, name, key_prefix, key_hash, request_logging_mode) values ($1, 'Logging ApiKey', 'llmi_logging', gen_random_uuid()::text, 'full')",
    [ids.apiKeyId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'logging-vm', 'Logging VM', true)",
    [ids.virtualModelId],
  );
  await fixture.query(
    "insert into providers (id, provider_type, provider_key, display_name, enabled) values ($1, 'api_key', 'openai', 'OpenAI', true)",
    [ids.providerId],
  );
  await fixture.query(
    "insert into provider_models (id, provider_id, model_id, display_name) values ($1, $2, 'gpt-logging', 'Logging Model')",
    [ids.providerModelId, ids.providerId],
  );
  return ids;
}
