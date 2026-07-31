import { normalizeApiKeyFormInput } from "@llmingress/db/console-api-keys";
import {
  captureGatewayPayloadValue,
  createGatewayBoundedPayloadAccumulator,
  gatewayPayloadByteLimit,
} from "@llmingress/gateway-runtime/gateway-payload-capture";
import { describe, expect, it } from "vitest";
import {
  apiKeyRequestLoggingModes,
  isApiKeyRequestLoggingMode,
} from "../../packages/domain/src/index.ts";

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
