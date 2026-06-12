import { describe, expect, it } from "vitest";
import { createFakeProviderServer } from "../support/fake-provider";

describe("feat-004 fake provider unit contract", () => {
  it("returns a deterministic non-streaming response and captures the request", async () => {
    const server = await createFakeProviderServer();

    try {
      const response = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: "Bearer test-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: "fake-model", messages: [{ role: "user", content: "hi" }] }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        id: "fake-provider-response",
        choices: [{ message: { content: "fake provider response" } }],
      });

      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).toMatchObject({
        method: "POST",
        path: "/v1/chat/completions",
        mode: "json",
        bodyJson: { model: "fake-model", messages: [{ role: "user", content: "hi" }] },
      });
      expect(server.requests[0]?.headers.authorization).toBe("Bearer test-key");
    } finally {
      await server.close();
    }
  });

  it("returns a structured fake provider error", async () => {
    const server = await createFakeProviderServer();

    try {
      const response = await fetch(`${server.url}/v1/chat/completions?mode=error`, {
        method: "POST",
        body: JSON.stringify({ model: "fake-model" }),
      });

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: {
          code: "fake_provider_error",
          message: "Fake provider error",
        },
      });
    } finally {
      await server.close();
    }
  });
});
