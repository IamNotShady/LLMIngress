import { expect, test } from "@playwright/test";
import { createFakeProviderServer } from "../support/fake-provider";

test("fake provider returns fixed body stream error timeout and first byte failure", async () => {
  const server = await createFakeProviderServer({ timeoutMs: 1_000 });

  try {
    const jsonResponse = await fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "fake-model" }),
    });
    expect(jsonResponse.status).toBe(200);
    await expect(jsonResponse.json()).resolves.toMatchObject({
      id: "fake-provider-response",
      choices: [{ message: { content: "fake provider response" } }],
    });

    const streamResponse = await fetch(`${server.url}/v1/chat/completions?mode=stream`, {
      method: "POST",
      body: JSON.stringify({ stream: true }),
    });
    expect(streamResponse.status).toBe(200);
    expect(streamResponse.headers.get("content-type")).toContain("text/event-stream");
    const streamBody = await streamResponse.text();
    expect(streamBody).toContain('data: {"delta":"fake"}');
    expect(streamBody).toContain('data: {"delta":" stream"}');
    expect(streamBody).toContain("data: [DONE]");

    const errorResponse = await fetch(`${server.url}/v1/chat/completions?mode=error`, {
      method: "POST",
      body: JSON.stringify({ model: "fake-model" }),
    });
    expect(errorResponse.status).toBe(503);
    await expect(errorResponse.json()).resolves.toMatchObject({
      error: { code: "fake_provider_error" },
    });

    const timeoutController = new AbortController();
    const timeout = setTimeout(() => timeoutController.abort(), 50);
    await expect(
      fetch(`${server.url}/v1/chat/completions?mode=timeout`, {
        method: "POST",
        signal: timeoutController.signal,
      }),
    ).rejects.toThrow();
    clearTimeout(timeout);

    await expect(
      fetch(`${server.url}/v1/chat/completions?mode=first-byte-failure`, {
        method: "POST",
        body: JSON.stringify({ model: "fake-model" }),
      }),
    ).rejects.toThrow();

    expect(server.requests.map((request) => request.mode)).toEqual([
      "json",
      "stream",
      "error",
      "timeout",
      "first-byte-failure",
    ]);
  } finally {
    await server.close();
  }
});
