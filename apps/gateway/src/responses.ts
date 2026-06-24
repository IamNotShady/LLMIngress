import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIResponsesInputMessage,
  type NormalizedOpenAIResponsesRequest,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "@llmingress/provider/openai";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import { createCodexSubscriptionAdapter } from "@llmingress/provider/subscription-adapters";
import type { GatewayRequestActivityRoute } from "./activity-recorder.js";
import {
  finalizeGatewayBudgetReservation,
  GatewayBudgetRejectedError,
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
  buildFallbackFailedAttempt,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  readFallbackProviderApiKeys,
  recordFailedAttemptInDatabase,
  recordSucceededAttemptInDatabase,
} from "./fallback-chain.js";
import { enforceGatewayRateLimits, releaseGatewayConcurrency } from "./rate-limits.js";
import {
  buildOpenAIResponsesRequestMetadata,
  type GatewayRequestMetadata,
} from "./request-metadata.js";
import { type RouteDecision, selectRouteAttempts } from "./route-engine.js";
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
  | "provider_protocol_unsupported"
  | "provider_request_failed"
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
  databaseUrl: string;
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
    const routePolicy = requireRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);

    const headOrder = routeResult.chain[0]?.candidateOrder;
    const selectedCandidate =
      routePolicy.candidates.find((c) => c.candidateOrder === headOrder) ??
      routePolicy.candidates.find((c) => c.providerModelId === routeDecision.providerModelId);
    if (!selectedCandidate) {
      throw new Error("Selected route candidate was not found in route policy.");
    }
    activity = buildRequestActivityRoute({
      candidate: selectedCandidate,
      fallbackAttempts,
      routeDecision,
    });

    const chainOrderMap = new Map(routeResult.chain.map((c, idx) => [c.candidateOrder, idx]));
    const gatewayChain = routePolicy.candidates
      .filter((c) => chainOrderMap.has(c.candidateOrder))
      .sort((a, b) => {
        const ia = chainOrderMap.get(a.candidateOrder) ?? Number.MAX_SAFE_INTEGER;
        const ib = chainOrderMap.get(b.candidateOrder) ?? Number.MAX_SAFE_INTEGER;
        return ia - ib;
      });

    const candidates = await attachGatewayProviderCredentials({
      candidates: gatewayChain,
      databaseUrl: input.databaseUrl,
      masterKeySource: readGatewayMasterKeySource(),
    });
    const success = await executeResponsesFallback({
      adapter: input.adapter,
      candidates,
      databaseUrl: input.databaseUrl,
      fallbackAttempts,
      finalizeAttempt: (r) =>
        finalizeGatewayBudgetReservation({ databaseUrl: input.databaseUrl, reservation: r }),
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
    if (!success) {
      throw new Error("Provider request failed.");
    }

    await recordGatewayProviderApiKeyLastUsed({
      databaseUrl: input.databaseUrl,
      providerApiKeyId: success.candidate.providerApiKeyId,
    });
    activity = buildRequestActivityRoute({
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
    const message = error instanceof Error ? error.message : "Provider request failed.";
    const code = classifyResponsesError(message);
    return {
      activity,
      body: createGatewayResponsesErrorBody(
        code,
        input.requestId,
        code === "provider_protocol_unsupported" || code === "provider_request_failed"
          ? message
          : undefined,
      ),
      requestMetadata,
      statusCode: mapGatewayErrorStatus(code),
    };
  } finally {
    await releaseGatewayConcurrency({
      databaseUrl: input.databaseUrl,
      lease: concurrencyLease,
    });
  }
}

async function executeResponsesFallback(input: {
  adapter?: OpenAIProviderAdapter;
  candidates: readonly FallbackChainCandidate[];
  databaseUrl: string;
  fallbackAttempts: FallbackFailedAttempt[];
  finalizeAttempt: (reservation: GatewayBudgetReservation | undefined) => Promise<void>;
  releaseAttempt: (reservation: GatewayBudgetReservation | undefined) => Promise<void>;
  reserveAttempt: (
    candidate: FallbackChainCandidate,
  ) => Promise<GatewayBudgetReservation | undefined>;
  request: NormalizedOpenAIResponsesRequest;
  requestActivityId?: string;
  requestId: string;
}): Promise<
  | {
      candidate: FallbackChainCandidate & {
        providerApiKeyId?: string;
        providerApiKeyPrefix?: string;
      };
      result: OpenAIAdapterSuccess;
    }
  | undefined
> {
  const genericAdapter = input.adapter ?? createOpenAIProviderAdapter();
  if (!genericAdapter.response) {
    throw new Error("OpenAI responses provider adapter is not configured.");
  }

  let attemptOrder = 0;
  const codexAdapter = input.adapter ? null : createCodexSubscriptionAdapter();
  const unsupportedProviders = new Set<string>();
  for (const candidate of input.candidates) {
    if (
      isSubscriptionProviderKey(candidate.providerKey) &&
      candidate.providerKey !== "openai_codex"
    ) {
      unsupportedProviders.add(candidate.providerKey);
      continue;
    }
    const adapter =
      candidate.providerKey === "openai_codex" && codexAdapter ? codexAdapter : genericAdapter;
    if (!adapter.response) {
      throw new Error("OpenAI responses provider adapter is not configured.");
    }
    const reservation = await input.reserveAttempt(candidate);
    for (const providerApiKey of readFallbackProviderApiKeys(candidate)) {
      attemptOrder += 1;
      const providerStartedAt = new Date();
      const result = await adapter.response({
        request: input.request,
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

      if (result.ok) {
        await input.finalizeAttempt(reservation);
        await recordSucceededAttemptInDatabase(input, {
          attemptOrder,
          ...(providerApiKey.providerApiKeyId
            ? { providerApiKeyId: providerApiKey.providerApiKeyId }
            : {}),
          ...(providerApiKey.keyPrefix ? { providerApiKeyPrefix: providerApiKey.keyPrefix } : {}),
          providerModelId: candidate.providerModelId,
        });
        return {
          candidate: {
            ...candidate,
            apiKey: providerApiKey.apiKey,
            providerApiKeyId: providerApiKey.providerApiKeyId,
            providerApiKeyPrefix: providerApiKey.keyPrefix,
          },
          result,
        };
      }

      const failedAttempt = buildFallbackFailedAttempt({
        attemptOrder,
        providerApiKey,
        providerModelId: candidate.providerModelId,
        result,
      });
      input.fallbackAttempts.push(failedAttempt);
      await recordFailedAttemptInDatabase(input, failedAttempt);
      if (!failedAttempt.retryable) {
        await input.releaseAttempt(reservation);
        return undefined;
      }
    }
    await input.releaseAttempt(reservation);
  }
  if (attemptOrder === 0 && unsupportedProviders.size > 0) {
    throw new Error(
      `Responses API cannot use provider ${Array.from(unsupportedProviders).join(", ")}.`,
    );
  }
  return undefined;
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

function buildRequestActivityRoute(input: {
  candidate: GatewayRouteCandidateSnapshot & {
    providerApiKeyId?: string;
    providerApiKeyPrefix?: string;
  };
  fallbackAttempts: FallbackFailedAttempt[];
  routeDecision: RouteDecision;
}): GatewayRequestActivityRoute {
  return {
    fallbackAttempts: input.fallbackAttempts,
    modelId: input.candidate.modelId,
    providerApiKeyId: input.candidate.providerApiKeyId,
    providerApiKeyPrefix: input.candidate.providerApiKeyPrefix,
    providerId: input.candidate.providerId,
    providerKey: input.candidate.providerKey,
    providerModelId: input.candidate.providerModelId,
    routePolicyId: input.routeDecision.routePolicyId,
    routeReason: input.routeDecision.routeReason,
  };
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
  if (message.includes("Responses API cannot use provider")) {
    return "provider_protocol_unsupported";
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
  if (code === "provider_protocol_unsupported") {
    return "The selected provider cannot serve Responses API requests.";
  }
  if (code === "provider_unavailable") {
    return "No eligible provider candidates are available for the selected route.";
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
