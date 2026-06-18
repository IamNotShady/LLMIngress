import type { GatewayRequestActivityRoute } from "./activity-recorder.js";
import {
  finalizeGatewayBudgetReservation,
  type GatewayBudgetReservation,
  releaseGatewayBudgetReservation,
  reserveGatewayBudget,
} from "./budgets.js";
import {
  attachGatewayProviderCredentials,
  readGatewayMasterKeySource,
  recordGatewayProviderApiKeyLastUsed,
} from "./chat-completions.js";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./config-reload.js";
import { mapGatewayErrorStatus } from "./error-mapping.js";
import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIResponsesInputMessage,
  type NormalizedOpenAIResponsesRequest,
  type OpenAIProviderAdapter,
} from "./provider-adapters/openai.js";
import { enforceGatewayRateLimits } from "./rate-limits.js";
import {
  buildOpenAIResponsesRequestMetadata,
  type GatewayRequestMetadata,
} from "./request-metadata.js";
import { selectRouteCandidate } from "./route-engine.js";
import { recordGatewayProviderTrace } from "./tracing.js";
import {
  type GatewayUsageCostDetails,
  readGatewayProviderTokenUsage,
  selectGatewayBaselineCandidate,
} from "./usage-recorder.js";
import type { GatewayVirtualModel } from "./virtual-model-access.js";

export type GatewayResponsesErrorCode =
  | "invalid_responses_request"
  | "provider_credentials_missing"
  | "provider_request_failed"
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
      maxOutputTokens,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      temperature,
    }),
  };
}

export async function executeGatewayOpenAIResponse(input: {
  agentApiKeyId: string;
  adapter?: OpenAIProviderAdapter;
  databaseUrl: string;
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

  let budgetReservation: GatewayBudgetReservation | undefined;
  let activity: GatewayRequestActivityRoute | undefined;
  try {
    const routeDecision = selectRouteCandidate({
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      snapshot: input.snapshot,
      virtualModelId: input.virtualModel.id,
    });
    const routePolicy = requireRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);
    const selectedCandidate = requireSelectedCandidate(routePolicy, routeDecision.providerModelId);
    activity = {
      fallbackAttempts: [],
      modelId: selectedCandidate.modelId,
      providerId: selectedCandidate.providerId,
      providerKey: selectedCandidate.providerKey,
      providerModelId: selectedCandidate.providerModelId,
      routePolicyId: routeDecision.routePolicyId,
      routeReason: routeDecision.routeReason,
    };
    const budget = await reserveGatewayBudget({
      agentApiKeyId: input.agentApiKeyId,
      databaseUrl: input.databaseUrl,
      price: selectedCandidate.price,
      requestId: input.requestId,
      requestMetadata,
    });
    if (!budget.ok) {
      return {
        activity,
        body: budget.body,
        requestMetadata,
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

    const adapter = input.adapter ?? createOpenAIProviderAdapter();
    if (!adapter.response) {
      throw new Error("OpenAI responses provider adapter is not configured.");
    }

    const providerStartedAt = new Date();
    const result = await adapter.response({
      request: normalized.request,
      target: {
        apiKey: selected.apiKey,
        baseUrl: selected.baseUrl,
        modelId: selected.modelId,
      },
    });
    await recordGatewayProviderTrace({
      errorCode: result.ok ? null : result.errorCode,
      modelId: selected.modelId,
      providerKey: selected.providerKey,
      requestId: input.requestId,
      startedAt: providerStartedAt,
      status: result.ok ? "succeeded" : "failed",
    });
    if (!result.ok) {
      await releaseGatewayBudgetReservation({
        databaseUrl: input.databaseUrl,
        reservation: budgetReservation,
      });
      budgetReservation = undefined;
      return {
        activity,
        body: createGatewayResponsesErrorBody("provider_request_failed", input.requestId),
        requestMetadata,
        statusCode: 502,
      };
    }

    await finalizeGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
    });
    await recordGatewayProviderApiKeyLastUsed({
      databaseUrl: input.databaseUrl,
      providerApiKeyId: selected.providerApiKeyId,
    });

    return {
      activity,
      body: result.body,
      requestMetadata,
      statusCode: result.statusCode,
      usageCost: {
        actualPrice: selectedCandidate.price,
        baselinePrice: baselineCandidate.price,
        baselineProviderModelId: baselineCandidate.providerModelId,
        estimatedInputTokens: requestMetadata.estimatedInputTokens,
        estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
        providerUsage: readGatewayProviderTokenUsage(result.body),
        providerModelId: selectedCandidate.providerModelId,
      },
    };
  } catch (error) {
    await releaseGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
    });
    const message = error instanceof Error ? error.message : "Provider request failed.";
    const code = classifyResponsesError(message);
    return {
      activity,
      body: createGatewayResponsesErrorBody(code, input.requestId),
      requestMetadata,
      statusCode: mapGatewayErrorStatus(code),
    };
  }
}

export function createGatewayResponsesErrorBody(
  code: GatewayResponsesErrorCode,
  requestId: string,
): GatewayResponsesErrorBody {
  return {
    error: {
      code,
      message: responsesErrorMessage(code),
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
  if (!isRecord(value) || typeof value.content !== "string" || !value.content.trim()) {
    return null;
  }
  if (value.role !== "system" && value.role !== "user" && value.role !== "assistant") {
    return null;
  }

  return {
    content: value.content,
    role: value.role,
  };
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

function classifyResponsesError(message: string): GatewayResponsesErrorCode {
  if (message.includes("No route policy") || message.includes("Route policy")) {
    return "route_not_found";
  }
  if (message.includes("Provider credentials") || message.includes("Provider base URL")) {
    return "provider_credentials_missing";
  }
  return "provider_request_failed";
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
