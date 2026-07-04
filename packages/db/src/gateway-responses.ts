import { selectRouteAttempts } from "@llmingress/domain";
import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIResponsesInputMessage,
  type NormalizedOpenAIResponsesRequest,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "@llmingress/provider/openai";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import { createCodexSubscriptionAdapter } from "@llmingress/provider/subscription-adapters";
import type { GatewayRequestActivityRoute } from "./gateway-activity-recorder.ts";
import {
  finalizeGatewayBudgetReservation,
  GatewayBudgetRejectedError,
  releaseGatewayBudgetReservation,
  reserveGatewayBudget,
} from "./gateway-budgets.ts";
import {
  attachGatewayProviderCredentialsLeniently,
  readGatewayMasterKeySource,
  recordGatewayProviderApiKeyLastUsed,
} from "./gateway-chat-completions.ts";
import type { GatewayConfigSnapshot } from "./gateway-config-reload.ts";
import { mapGatewayErrorStatus } from "./gateway-error-mapping.ts";
import { GatewayPipelineError, toGatewayErrorResponseParts } from "./gateway-errors.ts";
import {
  executeProviderFallbackAttempts,
  type FallbackFailedAttempt,
} from "./gateway-fallback-chain.ts";
import { enforceGatewayRateLimits, releaseGatewayConcurrency } from "./gateway-rate-limits.ts";
import {
  buildOpenAIResponsesRequestMetadata,
  type GatewayRequestMetadata,
} from "./gateway-request-metadata.ts";
import {
  buildGatewayRequestActivityRoute,
  isRecord,
  omitUndefined,
  requireGatewayRoutePolicy,
} from "./gateway-runtime-helpers.ts";
import { recordGatewayProviderTrace } from "./gateway-tracing.ts";
import {
  buildGatewayBudgetActualUsage,
  type GatewayUsageCostDetails,
  readGatewayProviderTokenUsage,
  selectGatewayBaselineCandidate,
} from "./gateway-usage-recorder.ts";
import type { GatewayVirtualModel } from "./gateway-virtual-model-access.ts";

export type GatewayResponsesErrorCode =
  | "invalid_responses_request"
  | "provider_credentials_missing"
  | "provider_protocol_unsupported"
  | "provider_request_failed"
  | "provider_rate_limited"
  | "provider_rejected_request"
  | "provider_unavailable"
  | "route_not_found"
  | "unsupported_stateful_responses";

export type GatewayResponsesErrorBody = {
  error: {
    code: GatewayResponsesErrorCode;
    message: string;
  };
  requestId: string;
};

export type GatewayResponsesResponse = {
  activity?: GatewayRequestActivityRoute;
  body: unknown;
  headers?: Record<string, string>;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
  usageCost?: GatewayUsageCostDetails;
};

export type GatewayResponsesRequestSuccess = {
  ok: true;
  request: NormalizedOpenAIResponsesRequest;
};

export type GatewayResponsesRequestFailure = {
  body: GatewayResponsesErrorBody;
  ok: false;
  statusCode: 400;
};

export type GatewayResponsesRequestResult =
  | GatewayResponsesRequestFailure
  | GatewayResponsesRequestSuccess;

export function normalizeOpenAIResponsesRequest(
  body: unknown,
  requestId: string,
): GatewayResponsesRequestResult {
  if (!isRecord(body)) {
    return invalidResponsesRequest(requestId);
  }

  if (typeof body.previous_response_id === "string" && body.previous_response_id.trim()) {
    return unsupportedStatefulResponses(requestId);
  }
  if (body.store === true) {
    return unsupportedStatefulResponses(requestId);
  }
  if (body.store !== undefined && typeof body.store !== "boolean") {
    return invalidResponsesRequest(requestId);
  }

  const input = readResponsesInput(body.input);
  if (!input) {
    return invalidResponsesRequest(requestId);
  }

  const instructions = readOptionalNonEmptyString(body.instructions);
  if (instructions === null) {
    return invalidResponsesRequest(requestId);
  }

  const maxOutputTokens = readOptionalPositiveInteger(body.max_output_tokens);
  if (maxOutputTokens === null) {
    return invalidResponsesRequest(requestId);
  }

  const temperature = readOptionalFiniteNumber(body.temperature);
  if (temperature === null) {
    return invalidResponsesRequest(requestId);
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return invalidResponsesRequest(requestId);
  }

  return {
    ok: true,
    request: omitUndefined({
      input,
      instructions,
      maxOutputTokens,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      temperature,
    }),
  };
}

export async function executeGatewayOpenAIResponse(input: {
  agentApiKeyId: string;
  adapter?: OpenAIProviderAdapter;
  databaseUrl?: string;
  requestActivityId?: string;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayResponsesResponse> {
  const normalized = normalizeOpenAIResponsesRequest(input.requestBody, input.requestId);
  if (!normalized.ok) {
    return {
      body: normalized.body,
      statusCode: normalized.statusCode,
    };
  }

  const requestMetadata = buildOpenAIResponsesRequestMetadata({
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
        body: createGatewayResponsesErrorBody("provider_unavailable", input.requestId),
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

    const candidates = await attachGatewayProviderCredentialsLeniently({
      candidates: gatewayChain,
      databaseUrl: input.databaseUrl,
      masterKeySource: readGatewayMasterKeySource(),
    });
    const genericAdapter = input.adapter ?? createOpenAIProviderAdapter();
    if (!genericAdapter.response) {
      throw new GatewayPipelineError(
        "provider_protocol_unsupported",
        "OpenAI responses provider adapter is not configured.",
      );
    }
    const codexAdapter = input.adapter ? null : createCodexSubscriptionAdapter();
    const unsupportedProviders = new Set<string>();
    const supportedCandidates = candidates.filter((candidate) => {
      if (
        isSubscriptionProviderKey(candidate.providerKey) &&
        candidate.providerKey !== "openai_codex"
      ) {
        unsupportedProviders.add(candidate.providerKey);
        return false;
      }
      return true;
    });
    const success = await executeProviderFallbackAttempts<OpenAIAdapterSuccess>({
      callProvider: async ({ candidate, providerApiKey }) => {
        const adapter =
          candidate.providerKey === "openai_codex" && codexAdapter ? codexAdapter : genericAdapter;
        if (!adapter.response) {
          throw new GatewayPipelineError(
            "provider_protocol_unsupported",
            "OpenAI responses provider adapter is not configured.",
          );
        }
        const providerStartedAt = new Date();
        const result = await adapter.response({
          request: normalized.request,
          target: {
            apiKey: providerApiKey.apiKey,
            baseUrl: candidate.baseUrl,
            modelId: candidate.modelId,
          },
        });
        await recordGatewayProviderTrace({
          errorCode: result.ok ? null : result.errorCode,
          modelId: candidate.modelId,
          providerKey: candidate.providerKey,
          requestId: input.requestId,
          startedAt: providerStartedAt,
          status: result.ok ? "succeeded" : "failed",
        });
        return result;
      },
      candidates: supportedCandidates,
      databaseUrl: input.databaseUrl,
      fallbackAttempts,
      finalizeAttempt: (r, success) =>
        finalizeGatewayBudgetReservation({
          actual: buildGatewayBudgetActualUsage({
            price: success.candidate.price,
            providerUsage: readGatewayProviderTokenUsage(success.body),
          }),
          databaseUrl: input.databaseUrl,
          reservation: r,
        }),
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
      requestActivityId: input.requestActivityId,
      requestId: input.requestId,
    });
    if (!success && supportedCandidates.length === 0 && unsupportedProviders.size > 0) {
      throw new GatewayPipelineError(
        "provider_protocol_unsupported",
        `Responses API cannot use provider ${Array.from(unsupportedProviders).join(", ")}.`,
      );
    }
    if (!success) {
      throw new GatewayPipelineError("provider_request_failed", "Provider request failed.");
    }

    await recordGatewayProviderApiKeyLastUsed({
      databaseUrl: input.databaseUrl,
      providerApiKeyId: success.candidate.providerApiKeyId,
    });
    activity = buildGatewayRequestActivityRoute({
      candidate: success.candidate,
      fallbackAttempts,
      routeDecision,
    });

    return {
      activity,
      body: success.result.body,
      requestMetadata,
      statusCode: success.result.statusCode,
      usageCost: {
        actualPrice: success.candidate.price,
        baselinePrice: baselineCandidate.price,
        baselineProviderModelId: baselineCandidate.providerModelId,
        estimatedInputTokens: requestMetadata.estimatedInputTokens,
        estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
        providerUsage: readGatewayProviderTokenUsage(success.result.body),
        providerModelId: success.candidate.providerModelId,
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
      body: createGatewayResponsesErrorBody(
        parts.code as GatewayResponsesErrorCode,
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
    });
  }
}

export function createGatewayResponsesErrorBody(
  code: GatewayResponsesErrorCode,
  requestId: string,
  message?: string,
): GatewayResponsesErrorBody {
  return {
    error: {
      code,
      message: message ?? responsesErrorMessage(code),
    },
    requestId,
  };
}

function readResponsesInput(
  value: unknown,
): string | NormalizedOpenAIResponsesInputMessage[] | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const messages = value.map(readResponsesInputMessage);
  if (messages.some((message) => !message)) {
    return null;
  }
  return messages as NormalizedOpenAIResponsesInputMessage[];
}

function readResponsesInputMessage(value: unknown): NormalizedOpenAIResponsesInputMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  const content = readResponsesMessageContent(value.content);
  if (!content) {
    return null;
  }
  if (
    value.role !== "developer" &&
    value.role !== "system" &&
    value.role !== "user" &&
    value.role !== "assistant"
  ) {
    return null;
  }

  return {
    content,
    role: value.role,
  };
}

function readResponsesMessageContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const textParts = value.map(readResponsesTextContentPart);
  if (textParts.some((part) => part === null)) {
    return null;
  }
  const text = textParts.join("\n").trim();
  return text || null;
}

function readResponsesTextContentPart(value: unknown): string | null {
  if (!isRecord(value) || typeof value.text !== "string") {
    return null;
  }
  if (value.type !== "input_text" && value.type !== "output_text") {
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
  return value;
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

function readOptionalNonEmptyString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && value.trim() ? value : null;
}

function invalidResponsesRequest(requestId: string): GatewayResponsesRequestFailure {
  return {
    body: createGatewayResponsesErrorBody("invalid_responses_request", requestId),
    ok: false,
    statusCode: 400,
  };
}

function unsupportedStatefulResponses(requestId: string): GatewayResponsesRequestFailure {
  return {
    body: createGatewayResponsesErrorBody("unsupported_stateful_responses", requestId),
    ok: false,
    statusCode: 400,
  };
}

function responsesErrorMessage(code: GatewayResponsesErrorCode): string {
  if (code === "unsupported_stateful_responses") {
    return "Stateful Responses API fields are not supported by this Gateway.";
  }
  if (code === "invalid_responses_request") {
    return "Responses request must include stateless string input or message input.";
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
  if (code === "provider_protocol_unsupported") {
    return "The selected provider cannot serve Responses API requests.";
  }
  if (code === "provider_unavailable") {
    return "No eligible provider candidates are available for the selected route.";
  }
  return "Provider request failed.";
}
