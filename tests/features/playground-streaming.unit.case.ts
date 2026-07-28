import { describe, expect, it } from "vitest";
import {
  createPlaygroundStreamDecoder,
  readPlaygroundErrorText,
} from "../../apps/console/src/app/_ui/playground/helpers.ts";

const frame = (delta: string) =>
  `data: {"choices":[{"delta":{"content":${JSON.stringify(delta)}}}]}`;

describe("playground stream decoding", () => {
  it("gives back each frame's text as the frame completes", () => {
    const decoder = createPlaygroundStreamDecoder();
    expect(decoder.push(`${frame("Hel")}\n`)).toBe("Hel");
    expect(decoder.push(`${frame("lo ")}\n${frame("world")}\n`)).toBe("lo world");
    expect(decoder.push("data: [DONE]\n")).toBe("");
    expect(decoder.flush()).toBe("");
  });

  it("holds back a frame the network cut in half", () => {
    const decoder = createPlaygroundStreamDecoder();
    const whole = `${frame("chunked")}\n`;
    const cut = Math.floor(whole.length / 2);
    // Nothing until the newline: half a frame is JSON, not an answer.
    expect(decoder.push(whole.slice(0, cut))).toBe("");
    expect(decoder.push(whole.slice(cut))).toBe("chunked");
  });

  it("reads the last frame even when the stream ends without a newline", () => {
    const decoder = createPlaygroundStreamDecoder();
    expect(decoder.push(frame("tail"))).toBe("");
    expect(decoder.flush()).toBe("tail");
  });

  it("reads the shapes the three protocols stream, and ignores everything else", () => {
    const decoder = createPlaygroundStreamDecoder();
    expect(
      decoder.push(
        [
          'data: {"delta":{"text":"messages "}}',
          'data: {"text":"responses "}',
          'data: {"choices":[{"delta":{"reasoning_content":"thinking "}}]}',
          "event: ping",
          ": keep-alive",
          "data: not json",
          'data: {"choices":[{"delta":{}}]}',
          "",
        ].join("\n"),
      ),
    ).toBe("messages responses thinking ");
    expect(decoder.flush()).toBe("");
  });
});

describe("playground refusals", () => {
  it("reads a refusal in the words it was refused with", () => {
    // The gateway's own envelope: the code is what an operator searches for and
    // the message is what tells them which control to change.
    expect(
      readPlaygroundErrorText({
        error: { code: "route_not_found", message: "No route policy is available." },
        requestId: "gw_1",
      }),
    ).toBe("route_not_found · No route policy is available.");
    // A provider passed straight through carries its own shape.
    expect(readPlaygroundErrorText({ error: { message: "context length exceeded" } })).toBe(
      "context length exceeded",
    );
    expect(readPlaygroundErrorText({ error: "upstream unavailable" })).toBe("upstream unavailable");
    expect(readPlaygroundErrorText({ message: "bad request" })).toBe("bad request");
  });

  it("says nothing about an answer that is not a refusal", () => {
    expect(readPlaygroundErrorText({ choices: [{ message: { content: "hi" } }] })).toBeNull();
    expect(readPlaygroundErrorText("plain text")).toBeNull();
    expect(readPlaygroundErrorText(null)).toBeNull();
  });
});
