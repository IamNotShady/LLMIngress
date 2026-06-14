import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { wrapProviderStreamWithActivityCompletion } from "../../apps/gateway/src/streaming";

describe("feat-051 MVP streaming activity completion", () => {
  it("completes request activity after a successful stream ends", async () => {
    const source = new PassThrough();
    const completions: Array<{ statusCode: number }> = [];
    const wrapped = wrapProviderStreamWithActivityCompletion(source, {
      completeActivity: async (input) => {
        completions.push({ statusCode: input.statusCode });
      },
      statusCode: 200,
    });
    const chunks: string[] = [];

    wrapped.on("data", (chunk) => chunks.push(String(chunk)));
    source.write('data: {"delta":"fake"}\n\n');
    source.end("data: [DONE]\n\n");
    await new Promise<void>((resolve, reject) => {
      wrapped.once("end", resolve);
      wrapped.once("error", reject);
    });

    expect(chunks.join("")).toBe('data: {"delta":"fake"}\n\ndata: [DONE]\n\n');
    expect(completions).toEqual([{ statusCode: 200 }]);
  });
});
