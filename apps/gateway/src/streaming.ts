import { randomUUID } from "node:crypto";
import { PassThrough, Readable } from "node:stream";
import { PostgresClient } from "@llmingress/db/providers";
import { openRouterAttributionHeaders } from "@llmingress/provider/openrouter";
import {
  buildClaudeCodeMessagesUrl,
  buildClaudeCodeSubscriptionHeaders,
  buildCodexResponsesUrl,
  buildCodexSubscriptionHeaders,
  withClaudeCodeSystemPrompt,
} from "@llmingress/provider/subscription";
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
  recordGatewayProviderApiKeyLastUsed,
} from "./chat-completions.js";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./config-reload.js";
import { mapGatewayErrorStatus } from "./error-mapping.js";
import { normalizeAnthropicMessagesRequest } from "./messages.js";
import {
  enforceGatewayRateLimits,
  type GatewayConcurrencyLease,
  releaseGatewayConcurrency,
} from "./rate-limits.js";
import {
  buildAnthropicMessagesRequestMetadata,
  buildOpenAIChatCompletionRequestMetadata,
  buildOpenAIResponsesRequestMetadata,
  type GatewayRequestMetadata,
} from "./request-metadata.js";
import { normalizeOpenAIResponsesRequest } from "./responses.js";
import { selectRouteCandidate } from "./route-engine.js";
import { recordGatewayProviderTrace } from "./tracing.js";
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

type GatewayStreamingErrorCode =
  | "provider_credentials_missing"
  | "provider_protocol_unsupported"
  | "provider_rate_limited"
  | "provider_request_failed"
  | "route_not_found";

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
  let concurrencyLease = rateLimit.concurrencyLease;
  try {
    const routeDecision = selectRouteCandidate({
      estimatedInputTokens: normalized.estimatedInputTokens,
      estimatedOutputTokens: normalized.estimatedOutputTokens,
      snapshot: input.snapshot,
      usesTools: normalized.requestMetadata.usesTools,
      virtualModelId: input.virtualModel.id,
    });
    const routePolicy = requireRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const selectedCandidate = requireSelectedCandidate(routePolicy, routeDecision.providerModelId);
    const activity = buildStreamingActivityRoute({
      modelId: selectedCandidate.modelId,
      providerId: selectedCandidate.providerId,
      providerKey: selectedCandidate.providerKey,
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
      await releaseGatewayConcurrency({
        databaseUrl: input.databaseUrl,
        lease: concurrencyLease,
      });
      concurrencyLease = undefined;
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
    if (
      !isStreamingProtocolSupportedByProvider({
        pathSuffix: normalized.pathSuffix,
        providerKey: selected.providerKey,
      })
    ) {
      await releaseGatewayBudgetReservation({
        databaseUrl: input.databaseUrl,
        reservation: budgetReservation,
      });
      budgetReservation = undefined;
      await releaseGatewayConcurrency({
        databaseUrl: input.databaseUrl,
        lease: concurrencyLease,
      });
      concurrencyLease = undefined;
      return {
        activity,
        body: createGatewayStreamingErrorBody("provider_protocol_unsupported", input.requestId),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: mapGatewayErrorStatus("provider_protocol_unsupported"),
      };
    }

    const providerStartedAt = new Date();
    const providerUrl = buildStreamingProviderUrl({
      baseUrl: selected.baseUrl,
      pathSuffix: normalized.pathSuffix,
      providerKey: selected.providerKey,
    });
    const response = await (input.fetch ?? globalThis.fetch)(providerUrl, {
      body: JSON.stringify(
        buildStreamingProviderRequestBody({
          modelId: selected.modelId,
          pathSuffix: normalized.pathSuffix,
          payload: normalized.payload,
          providerKey: selected.providerKey,
        }),
      ),
      headers: buildStreamingProviderHeaders({
        apiKey: selected.apiKey,
        headersWithApiKey: normalized.headersWithApiKey,
        providerKey: selected.providerKey,
      }),
      method: "POST",
    });
    await recordGatewayProviderTrace({
      errorCode: response.ok && response.body ? null : "provider_request_failed",
      modelId: selected.modelId,
      providerKey: selected.providerKey,
      requestId: input.requestId,
      startedAt: providerStartedAt,
      status: response.ok && response.body ? "succeeded" : "failed",
    });

    if (!response.ok || !response.body) {
      const providerErrorBody = await readProviderErrorBody(response);
      console.error("gateway provider streaming request failed", {
        body: providerErrorBody,
        modelId: selected.modelId,
        providerKey: selected.providerKey,
        requestId: input.requestId,
        statusCode: response.status,
        url: providerUrl,
      });
      await releaseGatewayBudgetReservation({
        databaseUrl: input.databaseUrl,
        reservation: budgetReservation,
      });
      budgetReservation = undefined;
      await releaseGatewayConcurrency({
        databaseUrl: input.databaseUrl,
        lease: concurrencyLease,
      });
      concurrencyLease = undefined;
      const errorCode =
        response.status === 429 ? "provider_rate_limited" : "provider_request_failed";
      return {
        activity,
        body: createGatewayStreamingErrorBody(errorCode, input.requestId),
        ok: false,
        requestMetadata: normalized.requestMetadata,
        statusCode: mapGatewayErrorStatus(errorCode),
      };
    }
    await recordGatewayProviderApiKeyLastUsed({
      databaseUrl: input.databaseUrl,
      providerApiKeyId: selected.providerApiKeyId,
    });
    const body = wrapProviderStreamWithConcurrencyRelease(
      wrapProviderStreamWithBudgetFinalization(
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
      ),
      {
        databaseUrl: input.databaseUrl,
        lease: concurrencyLease,
      },
    );
    budgetReservation = undefined;
    concurrencyLease = undefined;

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
    await releaseGatewayConcurrency({
      databaseUrl: input.databaseUrl,
      lease: concurrencyLease,
    });
    const message = error instanceof Error ? error.message : "Provider request failed.";
    const code = classifyStreamingError(message);
    return {
      body: createGatewayStreamingErrorBody(
        code,
        input.requestId,
        code === "provider_request_failed" ? message : undefined,
      ),
      ok: false,
      requestMetadata: normalized.requestMetadata,
      statusCode: mapGatewayErrorStatus(code),
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

function wrapProviderStreamWithConcurrencyRelease(
  source: Readable,
  input: {
    databaseUrl: string;
    lease: GatewayConcurrencyLease | undefined;
  },
): Readable {
  let settled = false;
  const release = () => {
    if (settled) {
      return;
    }
    settled = true;
    void releaseGatewayConcurrency(input);
  };
  source.once("end", release);
  source.once("error", release);
  source.once("close", release);
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
        tool_choice: normalized.request.toolChoice,
        tools: normalized.request.tools,
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
        instructions: normalized.request.instructions,
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
      metadata: normalized.request.metadata,
      messages: normalized.request.messages,
      service_tier: normalized.request.serviceTier,
      stop_sequences: normalized.request.stopSequences,
      system: normalized.request.system,
      temperature: normalized.request.temperature,
      thinking: normalized.request.thinking,
      tool_choice: normalized.request.toolChoice,
      tools: normalized.request.tools,
      top_k: normalized.request.topK,
      top_p: normalized.request.topP,
    }),
    requestMetadata,
  };
}

async function recordGatewayRuntimeError(input: {
  databaseUrl: string;
  error: GatewayRuntimeStreamError;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const client = new PostgresClient({ connectionString: input.databaseUrl });
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

export function buildStreamingProviderUrl(input: {
  baseUrl: string;
  pathSuffix: string;
  providerKey: string;
}): string {
  if (input.providerKey === "openai_codex" && input.pathSuffix === "responses") {
    return buildCodexResponsesUrl(input.baseUrl);
  }
  if (input.providerKey === "claude_code" && input.pathSuffix === "messages") {
    return buildClaudeCodeMessagesUrl(input.baseUrl);
  }
  return buildProviderUrl(input.baseUrl, input.pathSuffix);
}

export function buildStreamingProviderRequestBody(input: {
  modelId: string;
  pathSuffix: string;
  payload: Record<string, unknown>;
  providerKey: string;
}): Record<string, unknown> {
  const body = buildProviderRequestBody(input.payload, input.modelId);
  if (input.providerKey === "openai_codex" && input.pathSuffix === "responses") {
    return buildCodexStreamingResponsesBody(body);
  }
  if (input.providerKey === "claude_code" && input.pathSuffix === "messages") {
    return {
      ...body,
      system: withClaudeCodeSystemPrompt(body.system),
    };
  }
  return body;
}

const codexUnsupportedResponsesParameters = [
  "max_output_tokens",
  "metadata",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_p",
  "truncation",
];

function buildProviderRequestBody(
  payload: Record<string, unknown>,
  modelId: string,
): Record<string, unknown> {
  return {
    ...payload,
    model: modelId,
    stream: true,
  };
}

function buildCodexStreamingResponsesBody(body: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = { ...body, store: false, stream: true };
  for (const key of codexUnsupportedResponsesParameters) {
    delete cleaned[key];
  }
  if (typeof cleaned.instructions !== "string" || !cleaned.instructions.trim()) {
    cleaned.instructions = "You are a helpful assistant.";
  }
  return cleaned;
}

export function buildStreamingProviderHeaders(input: {
  apiKey: string;
  headersWithApiKey: (apiKey: string) => Record<string, string>;
  providerKey: string;
}): Record<string, string> {
  if (input.providerKey === "openai_codex") {
    return buildCodexSubscriptionHeaders(input.apiKey);
  }
  if (input.providerKey === "claude_code") {
    return buildClaudeCodeSubscriptionHeaders(input.apiKey);
  }
  const headers = input.headersWithApiKey(input.apiKey);
  if (input.providerKey === "openrouter") {
    return {
      ...headers,
      ...openRouterAttributionHeaders,
    };
  }
  return headers;
}

export function isStreamingProtocolSupportedByProvider(input: {
  pathSuffix: string;
  providerKey: string;
}): boolean {
  if (input.providerKey === "openai_codex") {
    return input.pathSuffix === "responses";
  }
  if (input.providerKey === "claude_code") {
    return input.pathSuffix === "messages";
  }
  return true;
}

async function readProviderErrorBody(response: Response): Promise<string | null> {
  try {
    const text = await response.text();
    return text ? text.slice(0, 2000) : null;
  } catch (error) {
    return error instanceof Error ? error.message : "Unable to read provider error body.";
  }
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
  modelId: string;
  providerId: string;
  providerKey: string;
  providerModelId: string;
  routePolicyId: string;
  routeReason: unknown;
}): GatewayRequestActivityRoute {
  return {
    fallbackAttempts: [],
    modelId: input.modelId,
    providerId: input.providerId,
    providerKey: input.providerKey,
    providerModelId: input.providerModelId,
    routePolicyId: input.routePolicyId,
    routeReason: input.routeReason,
  };
}

function createGatewayStreamingErrorBody(
  code: GatewayStreamingErrorCode,
  requestId: string,
  message = streamingErrorMessage(code),
) {
  return {
    error: {
      code,
      message,
    },
    requestId,
  };
}

function classifyStreamingError(message: string): GatewayStreamingErrorCode {
  if (message.includes("No route policy") || message.includes("Route policy")) {
    return "route_not_found";
  }
  if (message.includes("Provider credentials") || message.includes("Provider base URL")) {
    return "provider_credentials_missing";
  }
  return "provider_request_failed";
}

function streamingErrorMessage(code: GatewayStreamingErrorCode): string {
  if (code === "route_not_found") {
    return "No route policy is available for the selected Virtual Model.";
  }
  if (code === "provider_credentials_missing") {
    return "Provider credentials are not configured for the selected route.";
  }
  if (code === "provider_rate_limited") {
    return "Provider rate limit exceeded.";
  }
  if (code === "provider_protocol_unsupported") {
    return "Provider protocol is not supported for this endpoint.";
  }
  return "Provider request failed.";
}

function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
