import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type FakeProviderMode =
  | "json"
  | "stream"
  | "error"
  | "timeout"
  | "first-byte-failure"
  | "midstream-error"
  | "openrouter-error";

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
  requiredModelListAuthorization?: string;
  timeoutMs?: number;
};

export async function createFakeProviderServer(
  options: FakeProviderServerOptions = {},
): Promise<FakeProviderServer> {
  const requests: CapturedFakeProviderRequest[] = [];
  let models = options.models ?? [{ id: "fake-model" }];
  const timeoutMs = options.timeoutMs ?? 30_000;

  const server = createServer((request, response) => {
    void handleRequest(request, response, requests, {
      getModels: () => models,
      requiredModelListAuthorization: options.requiredModelListAuthorization,
      timeoutMs,
    });
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
  response: ServerResponse<IncomingMessage>,
  requests: CapturedFakeProviderRequest[],
  options: {
    getModels: () => FakeProviderModel[];
    requiredModelListAuthorization?: string;
    timeoutMs: number;
  },
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

    if (
      url.pathname.endsWith("/models") &&
      options.requiredModelListAuthorization &&
      readAuthorization(request.headers) !== options.requiredModelListAuthorization
    ) {
      writeJson(response, 401, {
        error: {
          code: "invalid_api_key",
          message: "Missing or invalid model list API key",
        },
      });
      return;
    }

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

    if (mode === "json" && url.pathname.endsWith("/responses")) {
      writeJson(response, 200, {
        id: "fake-provider-response",
        object: "response",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "fake provider response" }],
          },
        ],
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
      const secondChunkTimer = setTimeout(() => {
        response.write('data: {"delta":" stream"}\n\n');
      }, 300);
      const endTimer = setTimeout(() => {
        response.end("data: [DONE]\n\n");
      }, 700);
      response.once("close", () => {
        clearTimeout(secondChunkTimer);
        clearTimeout(endTimer);
      });
      return;
    }

    if (mode === "midstream-error") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
      });
      response.write('data: {"delta":"fake"}\n\n');
      const destroyTimer = setTimeout(() => {
        response.destroy(new Error("Fake provider mid-stream error"));
      }, 100);
      response.once("close", () => clearTimeout(destroyTimer));
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

    if (mode === "openrouter-error") {
      writeJson(response, 402, {
        error: {
          code: 402,
          message: "OpenRouter account has insufficient credits",
          metadata: {
            provider_name: "OpenRouter",
          },
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
    mode === "first-byte-failure" ||
    mode === "midstream-error" ||
    mode === "openrouter-error"
  ) {
    return mode;
  }
  return "json";
}

function writeJson(response: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
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
  const apiKey = Array.isArray(headers["x-api-key"])
    ? headers["x-api-key"].join(" ")
    : headers["x-api-key"];
  return [readAuthorization(headers), apiKey].some((value) => value?.includes("bad-provider-key"));
}

function readAuthorization(headers: IncomingHttpHeaders): string | undefined {
  return Array.isArray(headers.authorization)
    ? headers.authorization.join(" ")
    : headers.authorization;
}
