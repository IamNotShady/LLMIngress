import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { sendWorkerWebhookRequest } from "../../packages/worker-runtime/src/worker-webhook-transport";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("worker-webhook-egress-hardening", () => {
  it("blocks private, local, reserved, and credentialed targets before connecting", async () => {
    const blockedUrls = [
      "http://user:pass@example.com/webhook",
      "http://10.0.0.1:1/webhook",
      "http://172.16.0.1:1/webhook",
      "http://192.168.0.1:1/webhook",
      "http://169.254.0.1:1/webhook",
      "http://100.64.0.1:1/webhook",
      "http://0.0.0.0:1/webhook",
      "http://224.0.0.1:1/webhook",
      "http://[::1]:1/webhook",
      "http://[fe80::1]:1/webhook",
      "http://[fc00::1]:1/webhook",
      "http://[ff00::1]:1/webhook",
      "http://[::ffff:192.168.1.1]:1/webhook",
    ];

    for (const url of blockedUrls) {
      await expect(
        sendWorkerWebhookRequest({
          body: { ok: true },
          idempotencyKey: `blocked:${url}`,
          url,
        }),
      ).resolves.toMatchObject({
        errorCode: "webhook_target_blocked",
        responseStatus: null,
        status: "failed",
      });
    }
  });

  it("blocks private targets by default and only allows exact host allowlist entries", async () => {
    const hits: string[] = [];
    const server = await startHttpServer((request, response) => {
      hits.push(request.url ?? "/");
      response.end("ok");
    });

    await expect(
      sendWorkerWebhookRequest({
        body: { ok: true },
        idempotencyKey: "notification:event-private",
        url: server.url,
      }),
    ).resolves.toMatchObject({
      errorCode: "webhook_target_blocked",
      responseStatus: null,
      status: "failed",
    });
    expect(hits).toEqual([]);

    await expect(
      sendWorkerWebhookRequest({
        allowedHosts: ["127.0.0.1"],
        body: { ok: true },
        idempotencyKey: "notification:event-private",
        url: server.url,
      }),
    ).resolves.toMatchObject({
      responseBody: "ok",
      responseStatus: 200,
      status: "sent",
    });
    expect(hits).toEqual(["/webhook"]);
  });

  it("pins DNS lookup results for the actual connection and blocks rebinding to private IPs", async () => {
    const hits: string[] = [];
    const server = await startHttpServer((_request, response) => {
      hits.push("hit");
      response.end("ok");
    });
    const url = new URL(server.url);
    url.hostname = "rebind.test";

    await expect(
      sendWorkerWebhookRequest({
        body: { ok: true },
        idempotencyKey: "notification:event-rebind",
        lookup: async () => ({ address: "127.0.0.1", family: 4 }),
        url: url.toString(),
      }),
    ).resolves.toMatchObject({
      errorCode: "webhook_target_blocked",
      status: "failed",
    });
    expect(hits).toEqual([]);

    await expect(
      sendWorkerWebhookRequest({
        allowedHosts: ["rebind.test"],
        body: { ok: true },
        idempotencyKey: "notification:event-rebind",
        lookup: async () => ({ address: "127.0.0.1", family: 4 }),
        url: url.toString(),
      }),
    ).resolves.toMatchObject({
      responseStatus: 200,
      status: "sent",
    });
    expect(hits).toEqual(["hit"]);
  });

  it("does not follow redirects and sends a stable Idempotency-Key", async () => {
    let idempotencyKey: string | undefined;
    const server = await startHttpServer((request, response) => {
      idempotencyKey = request.headers["idempotency-key"] as string | undefined;
      response.writeHead(302, { location: "http://example.com/final" });
      response.end("redirect");
    });

    await expect(
      sendWorkerWebhookRequest({
        allowedHosts: ["127.0.0.1"],
        body: { ok: true },
        idempotencyKey: "job:activity:fallback",
        url: server.url,
      }),
    ).resolves.toMatchObject({
      errorCode: "webhook_http_error",
      responseBody: "redirect",
      responseStatus: 302,
      status: "failed",
    });
    expect(idempotencyKey).toBe("job:activity:fallback");
  });

  it("times out hanging targets and caps response bodies", async () => {
    const hangingServer = await startHttpServer((_request, _response) => undefined);

    await expect(
      sendWorkerWebhookRequest({
        allowedHosts: ["127.0.0.1"],
        body: { ok: true },
        idempotencyKey: "notification:event-timeout",
        timeoutMs: 20,
        url: hangingServer.url,
      }),
    ).resolves.toMatchObject({
      errorCode: "webhook_timeout",
      responseStatus: null,
      status: "failed",
    });

    const largeServer = await startHttpServer((_request, response) => {
      response.end("0123456789abcdef");
    });

    await expect(
      sendWorkerWebhookRequest({
        allowedHosts: ["127.0.0.1"],
        body: { ok: true },
        idempotencyKey: "notification:event-large",
        maxResponseBytes: 8,
        url: largeServer.url,
      }),
    ).resolves.toMatchObject({
      errorCode: "webhook_response_too_large",
      responseBody: "01234567",
      responseStatus: 200,
      status: "failed",
    });
  });

  it("uses worker webhook environment defaults for response caps", async () => {
    const originalMaxResponseBytes = process.env.WORKER_WEBHOOK_MAX_RESPONSE_BYTES;
    const server = await startHttpServer((_request, response) => {
      response.end("0123456789abcdef");
    });

    try {
      process.env.WORKER_WEBHOOK_MAX_RESPONSE_BYTES = "8";

      await expect(
        sendWorkerWebhookRequest({
          allowedHosts: ["127.0.0.1"],
          body: { ok: true },
          idempotencyKey: "notification:event-env-large",
          url: server.url,
        }),
      ).resolves.toMatchObject({
        errorCode: "webhook_response_too_large",
        responseBody: "01234567",
        responseStatus: 200,
        status: "failed",
      });
    } finally {
      if (originalMaxResponseBytes === undefined) {
        delete process.env.WORKER_WEBHOOK_MAX_RESPONSE_BYTES;
      } else {
        process.env.WORKER_WEBHOOK_MAX_RESPONSE_BYTES = originalMaxResponseBytes;
      }
    }
  });

  it("routes notification and webhook export defaults through the shared transport", () => {
    const notificationDispatcher = readFileSync(
      "packages/worker-runtime/src/worker-notification-dispatcher.ts",
      "utf8",
    );
    const webhookExport = readFileSync(
      "packages/worker-runtime/src/worker-webhook-export.ts",
      "utf8",
    );

    expect(notificationDispatcher).toContain("sendWorkerWebhookRequest");
    expect(webhookExport).toContain("sendWorkerWebhookRequest");
    expect(notificationDispatcher).not.toContain("fetch(");
    expect(webhookExport).not.toContain("fetch(");
  });
});

async function startHttpServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ close: () => Promise<void>; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP server did not bind to a TCP port.");
  }
  const handle = {
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${address.port}/webhook`,
  };
  servers.push(handle);
  return handle;
}
