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
  | "bad-request"
  | "unsupported-parameter"
  | "rate-limit"
  | "timeout"
  | "stream-stall"
  | "first-byte-failure"
  | "midstream-error"
  | "openrouter-error"
  | "cached-usage"
  | "flaky";

export type CapturedFakeProviderRequest = {
  method: string;
  path: string;
  mode: FakeProviderMode;
  headers: IncomingHttpHeaders;
  bodyRaw: string;
  bodyJson: unknown;
};

export type FakeProviderModel = {
  contextWindow?: number;
  id: string;
  name?: string;
};

export type FakeProviderServer = {
  closedRequests: CapturedFakeProviderRequest[];
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
  const closedRequests: CapturedFakeProviderRequest[] = [];
  const flakyState = { calls: 0 };
  let models = options.models ?? [{ id: "fake-model" }];
  const timeoutMs = options.timeoutMs ?? 30_000;

  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      { closedRequests, requests },
      {
        flakyState,
        getModels: () => models,
        requiredModelListAuthorization: options.requiredModelListAuthorization,
        timeoutMs,
      },
    );
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
    closedRequests,
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
  capture: {
    closedRequests: CapturedFakeProviderRequest[];
    requests: CapturedFakeProviderRequest[];
  },
  options: {
    flakyState: { calls: number };
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

    const capturedRequest = {
      method: request.method ?? "GET",
      path: url.pathname,
      mode,
      headers: request.headers,
      bodyRaw,
      bodyJson,
    };
    capture.requests.push(capturedRequest);
    response.once("close", () => {
      capture.closedRequests.push(capturedRequest);
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
          ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
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

    if (mode === "cached-usage") {
      writeJson(response, 200, {
        id: "fake-provider-cached-usage",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "fake cached response" } }],
        usage: {
          completion_tokens: 200,
          completion_tokens_details: {
            reasoning_tokens: 25,
          },
          prompt_tokens: 1000,
          prompt_tokens_details: {
            cached_tokens: 400,
          },
          total_tokens: 1200,
        },
      });
      return;
    }

    if (mode === "flaky") {
      const failTimes = readPositiveIntegerQuery(url, "fail_times", 1);
      options.flakyState.calls += 1;
      if (options.flakyState.calls <= failTimes) {
        writeJson(response, 503, {
          error: {
            code: "fake_provider_error",
            message: "Fake provider flaky error",
          },
        });
        return;
      }
      writeJson(response, 200, {
        id: "fake-provider-response",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: "fake provider response" } }],
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
        ...fakeProviderResponseHeaders(200),
      });
      response.write('data: {"delta":"fake"}\n\n');
      const streamEndMs = readPositiveIntegerQuery(url, "stream_end_ms", 700);
      const secondChunkTimer = setTimeout(
        () => {
          response.write('data: {"delta":" stream"}\n\n');
        },
        Math.min(300, streamEndMs),
      );
      const endTimer = setTimeout(() => {
        const usageEvents = buildFakeStreamUsageEvents(url.searchParams.get("usage"));
        if (usageEvents) {
          response.write(usageEvents);
        }
        response.end("data: [DONE]\n\n");
      }, streamEndMs);
      response.once("close", () => {
        clearTimeout(secondChunkTimer);
        clearTimeout(endTimer);
      });
      return;
    }

    if (mode === "stream-stall") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        ...fakeProviderResponseHeaders(200),
      });
      response.write('data: {"delta":"fake"}\n\n');
      return;
    }

    if (mode === "midstream-error") {
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        ...fakeProviderResponseHeaders(200),
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

    if (mode === "bad-request") {
      writeJson(response, 400, {
        error: {
          code: "context_length_exceeded",
          message: "context length exceeded by fake provider",
        },
      });
      return;
    }

    if (mode === "unsupported-parameter") {
      writeJson(response, 400, {
        error: {
          code: "invalid_request_error",
          message: "unsupported parameter temperature",
        },
      });
      return;
    }

    if (mode === "rate-limit") {
      writeJson(response, 429, {
        error: {
          code: "rate_limit_error",
          message: "Fake provider rate limit",
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
    mode === "bad-request" ||
    mode === "unsupported-parameter" ||
    mode === "rate-limit" ||
    mode === "timeout" ||
    mode === "stream-stall" ||
    mode === "first-byte-failure" ||
    mode === "midstream-error" ||
    mode === "openrouter-error" ||
    mode === "cached-usage" ||
    mode === "flaky"
  ) {
    return mode;
  }
  return "json";
}

function readPositiveIntegerQuery(url: URL, name: string, fallback: number): number {
  const value = Number(url.searchParams.get(name));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function buildFakeStreamUsageEvents(usage: string | null): string {
  if (usage === "chat") {
    return [
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"prompt_tokens_details":{"cached_tokens":400},"completion_tokens":200,"completion_tokens_details":{"reasoning_tokens":25},"total_tokens":1200}}',
      "",
      "",
    ].join("\n");
  }
  if (usage === "responses") {
    return [
      'data: {"type":"response.completed","response":{"id":"fake-stream-response","usage":{"input_tokens":50,"input_tokens_details":{"cached_tokens":10},"output_tokens":25,"output_tokens_details":{"reasoning_tokens":5}}}}',
      "",
      "",
    ].join("\n");
  }
  if (usage === "messages") {
    return [
      'data: {"type":"message_start","message":{"id":"fake-stream-message","usage":{"input_tokens":60,"cache_read_input_tokens":5,"output_tokens":1}}}',
      "",
      'data: {"type":"message_delta","usage":{"output_tokens":30}}',
      "",
      "",
    ].join("\n");
  }
  if (usage === "openrouter") {
    return [
      'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":200,"total_tokens":1200,"cost":99}}',
      "",
      "",
    ].join("\n");
  }
  return "";
}

function writeJson(response: ServerResponse<IncomingMessage>, status: number, body: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...fakeProviderResponseHeaders(status),
  });
  response.end(JSON.stringify(body));
}

function fakeProviderResponseHeaders(status: number): Record<string, string> {
  return {
    "anthropic-ratelimit-requests-remaining": status === 429 ? "0" : "88",
    "request-id": "fake-provider-request",
    ...(status === 429 ? { "retry-after": "2" } : {}),
    "x-ratelimit-remaining-requests": status === 429 ? "0" : "99",
    "x-request-id": "fake-provider-request",
  };
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
