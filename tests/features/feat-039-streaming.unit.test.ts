import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { wrapProviderStreamWithErrorRecording } from "../../apps/gateway/src/streaming";

describe("feat-039 streaming response passthrough", () => {
  it("forwards provider stream chunks in order", async () => {
    const recordedErrors: unknown[] = [];
    const stream = wrapProviderStreamWithErrorRecording(Readable.from(["first", "second"]), {
      recordRuntimeError: async (error) => {
        recordedErrors.push(error);
      },
    });

    await expect(readStream(stream)).resolves.toBe("firstsecond");
    expect(recordedErrors).toEqual([]);
  });

  it("records mid-stream errors once and propagates the stream failure", async () => {
    const source = new Readable({
      read() {
        this.push("first");
        this.destroy(new Error("provider socket closed mid-stream"));
      },
    });
    const recordedErrors: unknown[] = [];
    const stream = wrapProviderStreamWithErrorRecording(source, {
      recordRuntimeError: async (error) => {
        recordedErrors.push(error);
      },
    });

    await expect(readStream(stream)).rejects.toThrow("provider socket closed mid-stream");
    expect(recordedErrors).toEqual([
      {
        errorCode: "provider_stream_error",
        errorMessage: "provider socket closed mid-stream",
      },
    ]);
  });
});

async function readStream(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}
