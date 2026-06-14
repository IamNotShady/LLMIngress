import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { Client } from "pg";
import type { GatewayRequestActivityRoute } from "./activity-recorder.js";
import {
  finalizeGatewayBudgetReservation,
  type GatewayBudgetReservation,
  releaseGatewayBudgetReservation,
  reserveGatewayBudget,
} from "./budgets.js";
import {
  attachGatewayProviderCredentials,
  normalizeOpenAIChatCompletionRequest,
  readGatewayMasterKeySource,
} from "./chat-completions.js";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./config-reload.js";
import { normalizeAnthropicMessagesRequest } from "./messages.js";
import { enforceGatewayRateLimits } from "./rate-limits.js";
import {
  buildAnthropicMessagesRequestMetadata,
  buildOpenAIChatCompletionRequestMetadata,
  buildOpenAIResponsesRequestMetadata,
  type GatewayRequestMetadata,
} from "./request-metadata.js";
import { normalizeOpenAIResponsesRequest } from "./responses.js";
import { selectRouteCandidate } from "./route-engine.js";
import type { GatewayVirtualModel } from "./virtual-model-access.js";

export type GatewayStreamingProtocol = "chat_completions" | "messages" | "responses";

export type GatewayStreamingResult =
  | {
      body: Readable;
      contentType: string;
      activity?: GatewayRequestActivityRoute;
      headers?: Record<string, string>;
      ok: true;
      requestMetadata: GatewayRequestMetadata;
      statusCode: number;
    }
  | {
      body: unknown;
      activity?: GatewayRequestActivityRoute;
      headers?: Record<string, string>;
      ok: false;
      requestMetadata?: GatewayRequestMetadata;
      statusCode: number;
    };

export type GatewayRuntimeStreamError = {
  errorCode: "provider_stream_error";
  errorMessage: string;
};

type GatewayStreamingPayload = {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  pathSuffix: string;
  requestMetadata: GatewayRequestMetadata;
};

export function readGatewayStreamingFlag(body: unknown): boolean {
  return isRecord(body) && body.stream === true;
}

export async function executeGatewayStreamingRequest(input: {
  agentApiKeyId: string;
  databaseUrl: string;
  fetch?: typeof globalThis.fetch;
  protocol: GatewayStreamingProtocol;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayStreamingResult> {
  const normalized = buildStreamingPayload({
    protocol: input.protocol,
    requestBody: input.requestBody,
    requestId: input.requestId,
    resolvedModelName: input.virtualModel.name,
  });
  if (!normalized.ok) {
    return normalized;
  }

  const rateLimit = await enforceGatewayRateLimits({
    agentApiKeyId: input.agentApiKeyId,
    databaseUrl: input.databaseUrl,
    requestId: input.requestId,
    requestMetadata: normalized.requestMetadata,
  });
  if (!rateLimit.ok) {
    return {
      body: rateLimit.body,
      headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
      ok: false,
      requestMetadata: normalized.requestMetadata,
      statusCode: rateLimit.statusCode,
    };
  }

  let budgetReservation: GatewayBudgetReservation | undefined;
  try {
    const routeDecision = selectRouteCandidate({
      estimatedInputTokens: normalized.estimatedInputTokens,
      estimatedOutputTokens: normalized.estimatedOutputTokens,
      snapshot: input.snapshot,
      virtualModelId: input.virtualModel.id,
    });
    const routePolicy = requireRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const selectedCandidate = requireSelectedCandidate(routePolicy, routeDecision.providerModelId);
    const activity = buildStreamingActivityRoute({
      providerId: selectedCandidate.providerId,
      providerModelId: selectedCandidate.providerModelId,
      routePolicyId: routeDecision.routePolicyId,
      routeReason: routeDecision.routeReason,
    });
    const budget = await reserveGatewayBudget({
      agentApiKeyId: input.agentApiKeyId,
      databaseUrl: input.databaseUrl,
      price: selectedCandidate.price,
      requestId: input.requestId,
      requestMetadata: normalized.requestMetadata,
    });
    if (!budget.ok) {
      return {
        activity,
        body: budget.body,
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: budget.statusCode,
      };
    }
    budgetReservation = budget.reservation;

    const candidates = await attachGatewayProviderCredentials({
      candidates: [selectedCandidate],
      databaseUrl: input.databaseUrl,
      masterKeySource: readGatewayMasterKeySource(),
    });
    const selected = candidates[0];
    if (!selected) {
      throw new Error("Provider credentials are missing for the selected route.");
    }

    const response = await (input.fetch ?? globalThis.fetch)(
      buildProviderUrl(selected.baseUrl, normalized.pathSuffix),
      {
        body: JSON.stringify({
          ...normalized.payload,
          model: selected.modelId,
          stream: true,
        }),
        headers: normalized.headersWithApiKey(selected.apiKey),
        method: "POST",
      },
    );

    if (!response.ok || !response.body) {
      await releaseGatewayBudgetReservation({
        databaseUrl: input.databaseUrl,
        reservation: budgetReservation,
      });
      budgetReservation = undefined;
      return {
        activity,
        body: createGatewayStreamingErrorBody("provider_request_failed", input.requestId),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: 502,
      };
    }
    const body = wrapProviderStreamWithBudgetFinalization(
      wrapProviderStreamWithErrorRecording(
        Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
        {
          recordRuntimeError: (error) =>
            recordGatewayRuntimeError({
              databaseUrl: input.databaseUrl,
              error,
              metadata: {
                protocol: input.protocol,
                providerModelId: selected.providerModelId,
                requestId: input.requestId,
                virtualModelId: input.virtualModel.id,
              },
            }),
        },
      ),
      {
        databaseUrl: input.databaseUrl,
        reservation: budgetReservation,
      },
    );
    budgetReservation = undefined;

    return {
      activity,
      body,
      contentType: response.headers.get("content-type") ?? "text/event-stream; charset=utf-8",
      ok: true,
      requestMetadata: normalized.requestMetadata,
      statusCode: response.status,
    };
  } catch (error) {
    await releaseGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
    });
    return {
      body: createGatewayStreamingErrorBody(
        "provider_request_failed",
        input.requestId,
        error instanceof Error ? error.message : undefined,
      ),
      ok: false,
      requestMetadata: normalized.requestMetadata,
      statusCode: 502,
    };
  }
}

export function wrapProviderStreamWithActivityCompletion(
  source: Readable,
  input: {
    completeActivity: (completion: { statusCode: number }) => Promise<void>;
    errorStatusCode?: number;
    statusCode: number;
  },
): Readable {
  const output = new PassThrough();
  let settled = false;

  source.on("data", (chunk) => {
    output.write(chunk);
  });
  source.once("end", () => {
    void settleActivity(input.statusCode)
      .catch(() => undefined)
      .finally(() => output.end());
  });
  source.once("error", (error) => {
    void settleActivity(input.errorStatusCode ?? 502)
      .catch(() => undefined)
      .finally(() => {
        output.destroy(error instanceof Error ? error : new Error("Provider stream failed."));
      });
  });
  source.once("close", () => {
    if (settled || source.readableEnded) {
      return;
    }
    void settleActivity(input.errorStatusCode ?? 499)
      .catch(() => undefined)
      .finally(() => output.destroy());
  });

  async function settleActivity(statusCode: number): Promise<void> {
    if (settled) {
      return;
    }
    settled = true;
    await input.completeActivity({ statusCode });
  }

  return output;
}

export function wrapProviderStreamWithErrorRecording(
  source: Readable,
  input: {
    recordRuntimeError: (error: GatewayRuntimeStreamError) => Promise<void>;
  },
): Readable {
  const output = new PassThrough();
  let recorded = false;

  source.on("error", (error) => {
    const runtimeError: GatewayRuntimeStreamError = {
      errorCode: "provider_stream_error",
      errorMessage: error instanceof Error ? error.message : "Provider stream failed.",
    };

    const record = recorded
      ? Promise.resolve()
      : input.recordRuntimeError(runtimeError).catch(() => undefined);
    recorded = true;
    void record.finally(() => {
      output.destroy(error instanceof Error ? error : new Error(runtimeError.errorMessage));
    });
  });
  source.pipe(output);

  return output;
}

function wrapProviderStreamWithBudgetFinalization(
  source: Readable,
  input: {
    databaseUrl: string;
    reservation: GatewayBudgetReservation | undefined;
  },
): Readable {
  let settled = false;
  source.once("end", () => {
    if (settled) {
      return;
    }
    settled = true;
    void finalizeGatewayBudgetReservation(input);
  });
  source.once("error", () => {
    if (settled) {
      return;
    }
    settled = true;
    void releaseGatewayBudgetReservation(input);
  });
  source.once("close", () => {
    if (settled) {
      return;
    }
    settled = true;
    void releaseGatewayBudgetReservation(input);
  });
  return source;
}

function buildStreamingPayload(input: {
  protocol: GatewayStreamingProtocol;
  requestBody: unknown;
  requestId: string;
  resolvedModelName: string;
}):
  | (GatewayStreamingPayload & {
      headersWithApiKey: (apiKey: string) => Record<string, string>;
      ok: true;
    })
  | {
      body: unknown;
      ok: false;
      statusCode: number;
    } {
  if (input.protocol === "chat_completions") {
    const normalized = normalizeOpenAIChatCompletionRequest(input.requestBody, input.requestId);
    if (!normalized.ok) {
      return normalized;
    }
    const requestMetadata = buildOpenAIChatCompletionRequestMetadata({
      model: input.resolvedModelName,
      rawBody: input.requestBody,
      request: normalized.request,
    });

    return {
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      headers: { "content-type": "application/json" },
      headersWithApiKey: (apiKey) => ({
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      }),
      ok: true,
      pathSuffix: "chat/completions",
      payload: omitUndefined({
        max_tokens: normalized.request.maxOutputTokens,
        messages: normalized.request.messages,
        temperature: normalized.request.temperature,
      }),
      requestMetadata,
    };
  }

  if (input.protocol === "responses") {
    const normalized = normalizeOpenAIResponsesRequest(input.requestBody, input.requestId);
    if (!normalized.ok) {
      return normalized;
    }
    const requestMetadata = buildOpenAIResponsesRequestMetadata({
      model: input.resolvedModelName,
      rawBody: input.requestBody,
      request: normalized.request,
    });

    return {
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      headers: { "content-type": "application/json" },
      headersWithApiKey: (apiKey) => ({
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      }),
      ok: true,
      pathSuffix: "responses",
      payload: omitUndefined({
        input: normalized.request.input,
        max_output_tokens: normalized.request.maxOutputTokens,
        store: false,
        temperature: normalized.request.temperature,
      }),
      requestMetadata,
    };
  }

  const normalized = normalizeAnthropicMessagesRequest(input.requestBody, input.requestId);
  if (!normalized.ok) {
    return normalized;
  }
  const requestMetadata = buildAnthropicMessagesRequestMetadata({
    model: input.resolvedModelName,
    rawBody: input.requestBody,
    request: normalized.request,
  });

  return {
    estimatedInputTokens: requestMetadata.estimatedInputTokens,
    estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
    headers: { "content-type": "application/json" },
    headersWithApiKey: (apiKey) => ({
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "x-api-key": apiKey,
    }),
    ok: true,
    pathSuffix: "messages",
    payload: omitUndefined({
      max_tokens: normalized.request.maxOutputTokens,
      messages: normalized.request.messages,
      system: normalized.request.system,
      temperature: normalized.request.temperature,
      tool_choice: normalized.request.toolChoice,
      tools: normalized.request.tools,
    }),
    requestMetadata,
  };
}

async function recordGatewayRuntimeError(input: {
  databaseUrl: string;
  error: GatewayRuntimeStreamError;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `
        insert into runtime_errors (
          id,
          process_type,
          process_id,
          severity,
          error_code,
          error_message,
          metadata
        )
        values ($1, 'gateway', $2, 'error', $3, $4, $5)
      `,
      [
        randomUUID(),
        process.env.GATEWAY_INSTANCE_ID?.trim() || "gateway",
        input.error.errorCode,
        input.error.errorMessage,
        JSON.stringify(input.metadata),
      ],
    );
  } finally {
    await client.end();
  }
}

function buildProviderUrl(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const path = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  url.pathname = `${path}/${suffix}`.replaceAll(/\/{2,}/g, "/");
  return url.toString();
}

function requireRoutePolicy(
  snapshot: GatewayConfigSnapshot,
  routePolicyId: string,
): GatewayRoutePolicySnapshot {
  const routePolicy = snapshot.routePolicies.find((candidate) => candidate.id === routePolicyId);
  if (!routePolicy) {
    throw new Error(`Route policy ${routePolicyId} was not found.`);
  }
  return routePolicy;
}

function requireSelectedCandidate(
  routePolicy: GatewayRoutePolicySnapshot,
  providerModelId: string,
): GatewayRouteCandidateSnapshot {
  const candidate = routePolicy.candidates.find(
    (routeCandidate) => routeCandidate.providerModelId === providerModelId,
  );
  if (!candidate) {
    throw new Error(`Route policy ${routePolicy.id} selected candidate was not found.`);
  }
  return candidate;
}

function buildStreamingActivityRoute(input: {
  providerId: string;
  providerModelId: string;
  routePolicyId: string;
  routeReason: unknown;
}): GatewayRequestActivityRoute {
  return {
    fallbackAttempts: [],
    providerId: input.providerId,
    providerModelId: input.providerModelId,
    routePolicyId: input.routePolicyId,
    routeReason: input.routeReason,
  };
}

function createGatewayStreamingErrorBody(
  code: "provider_request_failed",
  requestId: string,
  message = "Provider request failed.",
) {
  return {
    error: {
      code,
      message,
    },
    requestId,
  };
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
