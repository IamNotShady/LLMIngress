/**
 * What a key whose request logging mode is "full" keeps of one request: the
 * client's body as it arrived and the provider's body as it was answered.
 *
 * Two rules shape everything here. A capped side is capped in bytes, because
 * the cap exists to bound what is written and held, not how many characters a
 * body has. And a captured string can carry a NUL, which jsonb refuses inside a
 * string: an unreplaced one would not lose the body, it would lose the whole
 * activity row the body travels in.
 */

export const gatewayPayloadByteLimit = 1_048_576;

/** Written rather than escaped, so the bytes these stand for are unambiguous. */
const nulCharacter = String.fromCharCode(0);
const replacementCharacter = String.fromCharCode(0xfffd);

export type GatewayCapturedPayloadSide = {
  /** The size of the whole body, including the part a truncated capture dropped. */
  bytes: number;
  truncated: boolean;
  /** The body as JSON while it fit, and the text it was cut down to when it did not. */
  value: unknown;
};

export type GatewayCapturedPayload = {
  requestBody: GatewayCapturedPayloadSide;
  responseBody: GatewayCapturedPayloadSide;
};

export type GatewayBoundedPayloadAccumulator = {
  append: (chunk: Buffer | Uint8Array | string) => void;
  read: () => { bytes: number; truncated: boolean; value: string };
};

/**
 * Captures one side of a request. A body that fits is kept as the JSON it is,
 * so it stays queryable and readable; one that does not becomes the text it
 * serializes to, cut at the cap, which is no longer JSON and says so through
 * `truncated`.
 */
export function captureGatewayPayloadValue(value: unknown): GatewayCapturedPayloadSide {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "";
  } catch {
    // A body JSON cannot hold — a cycle, a bigint — is recorded as nothing.
    // The alternative is throwing inside recording and losing the activity.
    return { bytes: 0, truncated: false, value: "" };
  }

  const bytes = Buffer.byteLength(text);
  if (bytes <= gatewayPayloadByteLimit) {
    return { bytes, truncated: false, value: sanitizeGatewayPayloadValue(value) };
  }

  return {
    bytes,
    truncated: true,
    value: readWholeCharacters(Buffer.from(text, "utf8").subarray(0, gatewayPayloadByteLimit)),
  };
}

/**
 * Collects a streamed response as it is written to the client. Buffering stops
 * at the cap while counting continues, so memory stays bounded by the cap plus
 * one chunk and the recorded size still describes what actually streamed.
 */
export function createGatewayBoundedPayloadAccumulator(): GatewayBoundedPayloadAccumulator {
  const buffered: Buffer[] = [];
  let bufferedBytes = 0;
  let streamedBytes = 0;

  return {
    append(chunk) {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      streamedBytes += buffer.byteLength;

      const room = gatewayPayloadByteLimit - bufferedBytes;
      if (room <= 0) {
        return;
      }
      const kept = buffer.byteLength <= room ? buffer : buffer.subarray(0, room);
      buffered.push(kept);
      bufferedBytes += kept.byteLength;
    },
    read() {
      return {
        bytes: streamedBytes,
        truncated: streamedBytes > bufferedBytes,
        value: replaceNulCharacters(readWholeCharacters(Buffer.concat(buffered))),
      };
    },
  };
}

/**
 * Rebuilds a body with every NUL replaced, in keys as well as values. Only the
 * uncapped path needs it: a truncated capture is already a JSON string, where
 * a NUL is six literal characters that jsonb accepts.
 */
function sanitizeGatewayPayloadValue(value: unknown): unknown {
  if (typeof value === "string") {
    return replaceNulCharacters(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeGatewayPayloadValue);
  }
  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      sanitized[replaceNulCharacters(key)] = sanitizeGatewayPayloadValue(child);
    }
    return sanitized;
  }
  return value;
}

function replaceNulCharacters(value: string): string {
  return value.replaceAll(nulCharacter, replacementCharacter);
}

/**
 * Decodes bytes that were cut at an arbitrary offset, dropping a trailing
 * partial character rather than decoding it into a replacement character that
 * would read as data the provider never sent.
 */
function readWholeCharacters(buffer: Buffer): string {
  let start = buffer.byteLength - 1;
  while (start >= 0 && ((buffer[start] ?? 0) & 0xc0) === 0x80) {
    start -= 1;
  }

  const lead = start >= 0 ? buffer[start] : undefined;
  if (lead === undefined) {
    return buffer.toString("utf8");
  }
  const expected = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return (expected > buffer.byteLength - start ? buffer.subarray(0, start) : buffer).toString(
    "utf8",
  );
}
