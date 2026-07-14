import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";
import { fetchListedProviderModels } from "../../packages/provider/src/model-list";

test("credentialed provider requests reject cross-origin redirects without reaching the target", async () => {
  const targetRequests: string[] = [];
  const target = await listen((request, response) => {
    targetRequests.push(request.url ?? "");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "leaked-model" }], id: "chatcmpl-leak" }));
  });

  const redirector = await listen((_request, response) => {
    response.writeHead(302, { location: `${target.url}/credential-leak` });
    response.end();
  });

  try {
    const adapter = createOpenAIProviderAdapter();
    const result = await adapter.chatCompletion({
      request: {
        messages: [{ content: "hello", role: "user" }],
        payload: { messages: [{ content: "hello", role: "user" }] },
      },
      target: {
        apiKey: "sk-real-server-secret",
        baseUrl: `${redirector.url}/v1`,
        modelId: "gpt-test",
      },
    });

    expect(result).toMatchObject({
      errorCode: "provider_redirect_rejected",
      ok: false,
      retryable: false,
      statusCode: 302,
    });
    expect(targetRequests).toEqual([]);

    await expect(
      fetchListedProviderModels({
        apiKey: "sk-real-server-secret",
        baseUrl: `${redirector.url}/v1`,
        providerKey: "openai",
      }),
    ).rejects.toMatchObject({
      code: "provider_redirect_rejected",
      statusCode: 302,
    });
    expect(targetRequests).toEqual([]);
  } finally {
    await Promise.all([target.close(), redirector.close()]);
  }
});

function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{
  close: () => Promise<void>;
  server: Server;
  url: string;
}> {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            server.close((error) => (error ? closeReject(error) : closeResolve()));
          }),
        server,
        url: `http://127.0.0.1:${address.port}`,
      });
    });
  });
}
