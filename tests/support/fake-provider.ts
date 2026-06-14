import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export type FakeProviderMode = "json" | "stream" | "error" | "timeout" | "first-byte-failure";

export type CapturedFakeProviderRequest = {
  method: string;
  path: string;
  mode: FakeProviderMode;
  headers: IncomingHttpHeaders;
  bodyRaw: string;
  bodyJson: unknown;
};

export type FakeProviderModel = {
  id: string;
  name?: string;
};

export type FakeProviderServer = {
  url: string;
  requests: CapturedFakeProviderRequest[];
  setModels: (models: FakeProviderModel[]) => void;
  close: () => Promise<void>;
};

type FakeProviderServerOptions = {
  models?: FakeProviderModel[];
  timeoutMs?: number;
};

export async function createFakeProviderServer(
  options: FakeProviderServerOptions = {},
): Promise<FakeProviderServer> {
  const requests: CapturedFakeProviderRequest[] = [];
  let models = options.models ?? [{ id: "fake-model" }];
  const timeoutMs = options.timeoutMs ?? 30_000;

  const server = createServer((request, response) => {
    void handleRequest(request, response, requests, { getModels: () => models, timeoutMs });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setModels: (nextModels) => {
      models = nextModels;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: Parameters<Parameters<typeof createServer>[0]>[1],
  requests: CapturedFakeProviderRequest[],
  options: { getModels: () => FakeProviderModel[]; timeoutMs: number },
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://fake-provider.local");
    const mode = readMode(url);
    const bodyRaw = await readBody(request);
    const bodyJson = parseJsonBody(bodyRaw);

    requests.push({
      method: request.method ?? "GET",
      path: url.pathname,
      mode,
      headers: request.headers,
      bodyRaw,
      bodyJson,
    });

    if (hasBadCredentials(request.headers)) {
      writeJson(response, 401, {
        error: {
          code: "invalid_api_key",
          message: "Invalid API key",
        },
      });
      return;
    }

    if (mode === "json" && url.pathname.endsWith("/models")) {
      writeJson(response, 200, {
        object: "list",
        data: options.getModels().map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          object: "model",
        })),
      });
      return;
    }

    if (mode === "json" && url.pathname.endsWith("/api/tags")) {
      writeJson(response, 200, {
        models: [
          {
            digest: "fake-ollama-digest",
            modified_at: "2026-01-01T00:00:00Z",
            name: "llama3.2:latest",
            size: 123,
          },
        ],
      });
      return;
    }

    if (mode === "json" && url.pathname.endsWith("/api/chat")) {
      writeJson(response, 200, {
        done: true,
        message: { role: "assistant", content: "fake provider response" },
        model: "llama3.2",
      });
      return;
    }

    if (mode === "json" && url.pathname.endsWith("/messages")) {
      writeJson(response, 200, {
        id: "fake-provider-message",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "fake provider response" }],
      });
      return;
    }

    if (mode === "json") {
      writeJson(response, 200, {
        id: "fake-provider-response",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "fake provider response" } }],
      });
      return;
    }

    if (mode === "stream") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.write('data: {"delta":"fake"}\n\n');
      response.write('data: {"delta":" stream"}\n\n');
      response.end("data: [DONE]\n\n");
      return;
    }

    if (mode === "error") {
      writeJson(response, 503, {
        error: {
          code: "fake_provider_error",
          message: "Fake provider error",
        },
      });
      return;
    }

    if (mode === "timeout") {
      const timer = setTimeout(() => {
        if (!response.destroyed) {
          writeJson(response, 504, {
            error: {
              code: "fake_provider_timeout",
              message: "Fake provider timeout",
            },
          });
        }
      }, options.timeoutMs);
      timer.unref();
      response.once("close", () => clearTimeout(timer));
      return;
    }

    request.socket.destroy();
  } catch (error) {
    response.destroy(error instanceof Error ? error : undefined);
  }
}

function readMode(url: URL): FakeProviderMode {
  const mode = url.searchParams.get("mode") ?? "json";
  if (
    mode === "json" ||
    mode === "stream" ||
    mode === "error" ||
    mode === "timeout" ||
    mode === "first-byte-failure"
  ) {
    return mode;
  }
  return "json";
}

function writeJson(
  response: Parameters<Parameters<typeof createServer>[0]>[1],
  status: number,
  body: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonBody(bodyRaw: string): unknown {
  if (!bodyRaw) {
    return undefined;
  }
  try {
    return JSON.parse(bodyRaw);
  } catch {
    return undefined;
  }
}

function hasBadCredentials(headers: IncomingHttpHeaders): boolean {
  const authorization = Array.isArray(headers.authorization)
    ? headers.authorization.join(" ")
    : headers.authorization;
  const apiKey = Array.isArray(headers["x-api-key"])
    ? headers["x-api-key"].join(" ")
    : headers["x-api-key"];
  return [authorization, apiKey].some((value) => value?.includes("bad-provider-key"));
}
