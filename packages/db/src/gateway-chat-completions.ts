import { selectRouteAttempts } from "@llmingress/domain";
import type {
  NormalizedOpenAIChatMessage,
  NormalizedOpenAIChatRequest,
  OpenAIProviderAdapter,
} from "@llmingress/provider/openai";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import type { MasterKeySource } from "@llmingress/security/master-key";
import type { GatewayRequestActivityRoute } from "./gateway-activity-recorder.ts";
import {
  finalizeGatewayBudgetReservation,
  GatewayBudgetRejectedError,
  releaseGatewayBudgetReservation,
  reserveGatewayBudget,
} from "./gateway-budgets.ts";
import type { GatewayConfigSnapshot } from "./gateway-config-reload.ts";
import { mapGatewayErrorStatus } from "./gateway-error-mapping.ts";
import { GatewayPipelineError, toGatewayErrorResponseParts } from "./gateway-errors.ts";
import { executeFallbackChain, type FallbackFailedAttempt } from "./gateway-fallback-chain.ts";
import {
  attachGatewayProviderCredentialsLeniently,
  readGatewayMasterKeySource,
  recordGatewayProviderApiKeyLastUsed,
} from "./gateway-provider-credentials.ts";
import { enforceGatewayRateLimits, releaseGatewayConcurrency } from "./gateway-rate-limits.ts";
import {
  buildOpenAIChatCompletionRequestMetadata,
  type GatewayRequestMetadata,
} from "./gateway-request-metadata.ts";
import {
  buildGatewayRequestActivityRoute,
  isRecord,
  omitUndefined,
  requireGatewayRoutePolicy,
} from "./gateway-runtime-helpers.ts";
import {
  buildGatewayBudgetActualUsage,
  type GatewayUsageCostDetails,
  readGatewayProviderTokenUsage,
  selectGatewayBaselineCandidate,
} from "./gateway-usage-recorder.ts";
import type { GatewayVirtualModel } from "./gateway-virtual-model-access.ts";

export type GatewayChatCompletionErrorCode =
  | "invalid_chat_request"
  | "provider_credentials_missing"
  | "provider_rate_limited"
  | "provider_rejected_request"
  | "provider_request_failed"
  | "provider_unavailable"
  | "route_not_found";

export type GatewayChatCompletionErrorBody = {
  error: {
    code: GatewayChatCompletionErrorCode;
    message: string;
  };
  requestId: string;
};

export type GatewayChatCompletionResponse = {
  activity?: GatewayRequestActivityRoute;
  body: unknown;
  headers?: Record<string, string>;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
  usageCost?: GatewayUsageCostDetails;
};

export type GatewayChatCompletionRequestSuccess = {
  ok: true;
  request: NormalizedOpenAIChatRequest;
};

export type GatewayChatCompletionRequestFailure = {
  body: GatewayChatCompletionErrorBody;
  ok: false;
  statusCode: 400;
};

export type GatewayChatCompletionRequestResult =
  | GatewayChatCompletionRequestFailure
  | GatewayChatCompletionRequestSuccess;

const maxChatCompletionOutputTokens = 16_384;
const chatPassthroughParameterKeys = [
  "frequency_penalty",
  "logprobs",
  "parallel_tool_calls",
  "presence_penalty",
  "response_format",
  "seed",
  "stop",
  "top_logprobs",
  "top_p",
  "user",
] as const;

export function normalizeOpenAIChatCompletionRequest(
  body: unknown,
  requestId: string,
): GatewayChatCompletionRequestResult {
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidChatRequest(requestId);
  }

  const messages = body.messages.map(readOpenAIChatMessage);
  if (messages.some((message) => !message)) {
    return invalidChatRequest(requestId);
  }

  const maxOutputTokens = readOptionalPositiveInteger(
    body.max_completion_tokens ?? body.max_tokens,
  );
  if (maxOutputTokens === null) {
    return invalidChatRequest(requestId);
  }

  const temperature = readOptionalFiniteNumber(body.temperature);
  if (temperature === null) {
    return invalidChatRequest(requestId);
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return invalidChatRequest(requestId);
  }
  const tools = readOptionalObjectArray(body.tools);
  if (tools === null) {
    return invalidChatRequest(requestId);
  }
  const toolChoice = readOptionalOpenAIToolChoice(body.tool_choice);
  if (toolChoice === null) {
    return invalidChatRequest(requestId);
  }

  const passthrough = readChatPassthroughParameters(body);

  return {
    ok: true,
    request: omitUndefined({
      maxOutputTokens,
      messages: messages as NormalizedOpenAIChatMessage[],
      passthrough,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      temperature,
      toolChoice,
      tools,
    }),
  };
}

export async function executeGatewayOpenAIChatCompletion(input: {
  agentApiKeyId: string;
  adapter?: OpenAIProviderAdapter;
  databaseUrl?: string;
  masterKeySource?: MasterKeySource;
  requestActivityId?: string;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayChatCompletionResponse> {
  const normalized = normalizeOpenAIChatCompletionRequest(input.requestBody, input.requestId);
  if (!normalized.ok) {
    return {
      body: normalized.body,
      statusCode: normalized.statusCode,
    };
  }

  const requestMetadata = buildOpenAIChatCompletionRequestMetadata({
    model: input.virtualModel.name,
    rawBody: input.requestBody,
    request: normalized.request,
  });

  const rateLimit = await enforceGatewayRateLimits({
    agentApiKeyId: input.agentApiKeyId,
    databaseUrl: input.databaseUrl,
    requestId: input.requestId,
    requestMetadata,
  });
  if (!rateLimit.ok) {
    return {
      body: rateLimit.body,
      headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
      requestMetadata,
      statusCode: rateLimit.statusCode,
    };
  }

  const concurrencyLease = rateLimit.concurrencyLease;
  let activity: GatewayRequestActivityRoute | undefined;
  const fallbackAttempts: FallbackFailedAttempt[] = [];
  try {
    const routeResult = selectRouteAttempts({
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      snapshot: input.snapshot,
      usesTools: requestMetadata.usesTools,
      virtualModelId: input.virtualModel.id,
    });
    if (!routeResult.decision || routeResult.chain.length === 0) {
      return {
        activity,
        body: createGatewayChatCompletionErrorBody("provider_unavailable", input.requestId),
        requestMetadata,
        statusCode: mapGatewayErrorStatus("provider_unavailable"),
      };
    }
    const routeDecision = routeResult.decision;
    const routePolicy = requireGatewayRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);
    const gatewayChain = routeResult.chain;

    const selectedCandidate = gatewayChain[0];
    if (!selectedCandidate) {
      throw new Error("Selected route candidate was not found in route policy.");
    }
    activity = buildGatewayRequestActivityRoute({
      candidate: selectedCandidate,
      fallbackAttempts,
      routeDecision,
    });

    const chatCompletionCandidates = gatewayChain.filter(
      (candidate) => !isSubscriptionProviderKey(candidate.providerKey),
    );
    if (chatCompletionCandidates.length === 0) {
      throw new GatewayPipelineError(
        "provider_credentials_missing",
        "Provider credentials are missing for chat completions route.",
      );
    }
    const candidates = await attachGatewayProviderCredentialsLeniently({
      candidates: chatCompletionCandidates,
      databaseUrl: input.databaseUrl,
      masterKeySource: input.masterKeySource ?? readGatewayMasterKeySource(),
    });
    const result = await executeFallbackChain({
      adapter: input.adapter,
      candidates,
      databaseUrl: input.databaseUrl,
      finalizeAttempt: (r, success) =>
        finalizeGatewayBudgetReservation({
          actual: buildGatewayBudgetActualUsage({
            price: success.candidate.price,
            providerUsage: readGatewayProviderTokenUsage(success.body),
          }),
          databaseUrl: input.databaseUrl,
          reservation: r,
        }),
      recordFailedAttempt: async (attempt) => {
        fallbackAttempts.push(attempt);
      },
      releaseAttempt: (r) =>
        releaseGatewayBudgetReservation({ databaseUrl: input.databaseUrl, reservation: r }),
      reserveAttempt: async (candidate) => {
        const d = await reserveGatewayBudget({
          agentApiKeyId: input.agentApiKeyId,
          databaseUrl: input.databaseUrl,
          price: candidate.price,
          requestId: input.requestId,
          requestMetadata,
        });
        if (!d.ok) {
          throw new GatewayBudgetRejectedError(d.body, d.statusCode);
        }
        return d.reservation;
      },
      request: normalized.request,
      requestActivityId: input.requestActivityId,
      requestId: input.requestId,
    });
    await recordGatewayProviderApiKeyLastUsed({
      databaseUrl: input.databaseUrl,
      providerApiKeyId: result.selectedCandidate.providerApiKeyId,
    });
    activity = buildGatewayRequestActivityRoute({
      candidate: result.selectedCandidate,
      fallbackAttempts: result.failedAttempts,
      routeDecision,
    });

    return {
      activity,
      body: result.result.body,
      requestMetadata,
      statusCode: result.result.statusCode,
      usageCost: {
        actualPrice: result.selectedCandidate.price,
        baselinePrice: baselineCandidate.price,
        baselineProviderModelId: baselineCandidate.providerModelId,
        estimatedInputTokens: requestMetadata.estimatedInputTokens,
        estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
        providerUsage: readGatewayProviderTokenUsage(result.result.body),
        providerModelId: result.selectedCandidate.providerModelId,
      },
    };
  } catch (error) {
    if (error instanceof GatewayBudgetRejectedError) {
      return {
        activity,
        body: error.body,
        requestMetadata,
        statusCode: error.statusCode,
      };
    }
    const parts = toGatewayErrorResponseParts(error, "provider_request_failed");
    return {
      activity,
      body: createGatewayChatCompletionErrorBody(
        parts.code as GatewayChatCompletionErrorCode,
        input.requestId,
        parts.message,
      ),
      requestMetadata,
      statusCode: parts.statusCode,
    };
  } finally {
    await releaseGatewayConcurrency({
      databaseUrl: input.databaseUrl,
      lease: concurrencyLease,
    }).catch(() => undefined);
  }
}

export function createGatewayChatCompletionErrorBody(
  code: GatewayChatCompletionErrorCode,
  requestId: string,
  message = chatCompletionErrorMessage(code),
): GatewayChatCompletionErrorBody {
  return {
    error: {
      code,
      message,
    },
    requestId,
  };
}

function invalidChatRequest(requestId: string): GatewayChatCompletionRequestFailure {
  return {
    body: createGatewayChatCompletionErrorBody("invalid_chat_request", requestId),
    ok: false,
    statusCode: 400,
  };
}

function readOpenAIChatMessage(value: unknown): NormalizedOpenAIChatMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const role = value.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
    return null;
  }

  const content = readOpenAIChatMessageContent(value.content);
  const toolCalls = readOptionalObjectArray(value.tool_calls);
  if (toolCalls === null) {
    return null;
  }
  if (role === "assistant" && !content && (!toolCalls || toolCalls.length === 0)) {
    return null;
  }
  if (role !== "assistant" && !content) {
    return null;
  }
  if (role === "tool" && typeof value.tool_call_id !== "string") {
    return null;
  }
  if (value.name !== undefined && typeof value.name !== "string") {
    return null;
  }

  return omitUndefined({
    content: content ?? null,
    name: value.name,
    role,
    tool_call_id: role === "tool" ? value.tool_call_id : undefined,
    tool_calls: toolCalls,
  }) as NormalizedOpenAIChatMessage;
}

function readOpenAIChatMessageContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const textParts = value.map(readOpenAIChatTextContentPart);
  if (textParts.some((part) => part === null)) {
    return null;
  }
  const text = textParts.join("\n").trim();
  return text || null;
}

function readOpenAIChatTextContentPart(value: unknown): string | null {
  if (!isRecord(value) || typeof value.text !== "string") {
    return null;
  }
  if (value.type !== "text" && value.type !== "input_text" && value.type !== "output_text") {
    return null;
  }
  return value.text;
}

function readOptionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return Math.min(value, maxChatCompletionOutputTokens);
}

function readOptionalFiniteNumber(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function readOptionalObjectArray(value: unknown): Record<string, unknown>[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => !isRecord(entry))) {
    return null;
  }
  return value as Record<string, unknown>[];
}

function readChatPassthroughParameters(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const passthrough: Record<string, unknown> = {};
  for (const key of chatPassthroughParameterKeys) {
    if (body[key] !== undefined) {
      passthrough[key] = body[key];
    }
  }
  return Object.keys(passthrough).length > 0 ? passthrough : undefined;
}

function readOptionalOpenAIToolChoice(
  value: unknown,
): string | Record<string, unknown> | null | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (typeof value === "string") {
    const mode = value.trim();
    return mode === "auto" || mode === "none" || mode === "required" ? mode : null;
  }
  if (isRecord(value)) {
    return value;
  }
  return null;
}

function chatCompletionErrorMessage(code: GatewayChatCompletionErrorCode): string {
  if (code === "invalid_chat_request") {
    return "Chat completion request must include at least one string-content message.";
  }
  if (code === "route_not_found") {
    return "No route policy is available for the selected Virtual Model.";
  }
  if (code === "provider_credentials_missing") {
    return "Provider credentials are not configured for the selected route.";
  }
  if (code === "provider_rate_limited") {
    return "Provider rate limit exceeded.";
  }
  if (code === "provider_rejected_request") {
    return "Provider rejected the request.";
  }
  if (code === "provider_unavailable") {
    return "No eligible provider candidates are available for the selected route.";
  }
  return "Provider request failed.";
}
