import {
  type AnthropicAdapterSuccess,
  type AnthropicContentBlock,
  type AnthropicMessageContent,
  type AnthropicProviderAdapter,
  createAnthropicProviderAdapter,
  type NormalizedAnthropicMessage,
  type NormalizedAnthropicMessagesRequest,
} from "@llmingress/provider/anthropic";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import { createClaudeCodeProviderAdapter } from "@llmingress/provider/subscription-adapters";
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
  buildFallbackAttemptCandidates,
  buildFallbackFailedAttempt,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  readFallbackProviderApiKeys,
  recordFailedAttemptInDatabase,
  recordSucceededAttemptInDatabase,
} from "./fallback-chain.js";
import { enforceGatewayRateLimits, releaseGatewayConcurrency } from "./rate-limits.js";
import {
  buildAnthropicMessagesRequestMetadata,
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

export type GatewayAnthropicMessagesErrorCode =
  | "invalid_messages_request"
  | "provider_credentials_missing"
  | "provider_request_failed"
  | "route_not_found";

export type GatewayAnthropicMessagesErrorBody = {
  error: {
    code: GatewayAnthropicMessagesErrorCode;
    message: string;
  };
  requestId: string;
};

export type GatewayAnthropicMessagesResponse = {
  activity?: GatewayRequestActivityRoute;
  body: unknown;
  headers?: Record<string, string>;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
  usageCost?: GatewayUsageCostDetails;
};

export type GatewayAnthropicMessagesRequestSuccess = {
  ok: true;
  request: NormalizedAnthropicMessagesRequest;
};

export type GatewayAnthropicMessagesRequestFailure = {
  body: GatewayAnthropicMessagesErrorBody;
  ok: false;
  statusCode: 400;
};

export type GatewayAnthropicMessagesRequestResult =
  | GatewayAnthropicMessagesRequestFailure
  | GatewayAnthropicMessagesRequestSuccess;

export function normalizeAnthropicMessagesRequest(
  body: unknown,
  requestId: string,
): GatewayAnthropicMessagesRequestResult {
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidMessagesRequest(requestId);
  }

  const maxOutputTokens = readRequiredPositiveInteger(body.max_tokens);
  if (maxOutputTokens === null) {
    return invalidMessagesRequest(requestId);
  }

  const messages = body.messages.map(readAnthropicMessage);
  if (messages.some((message) => !message)) {
    return invalidMessagesRequest(requestId);
  }

  const temperature = readOptionalFiniteNumber(body.temperature);
  if (temperature === null) {
    return invalidMessagesRequest(requestId);
  }
  const topP = readOptionalFiniteNumber(body.top_p);
  if (topP === null) {
    return invalidMessagesRequest(requestId);
  }
  const topK = readOptionalPositiveInteger(body.top_k);
  if (topK === null) {
    return invalidMessagesRequest(requestId);
  }
  const stopSequences = readOptionalNonEmptyStringArray(body.stop_sequences);
  if (stopSequences === null) {
    return invalidMessagesRequest(requestId);
  }
  const metadata = readOptionalRecord(body.metadata);
  if (metadata === null) {
    return invalidMessagesRequest(requestId);
  }
  const thinking = readOptionalRecord(body.thinking);
  if (thinking === null) {
    return invalidMessagesRequest(requestId);
  }
  const serviceTier = readOptionalNonEmptyString(body.service_tier);
  if (serviceTier === null) {
    return invalidMessagesRequest(requestId);
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return invalidMessagesRequest(requestId);
  }
  if (body.system !== undefined && typeof body.system !== "string") {
    return invalidMessagesRequest(requestId);
  }
  const tools = readOptionalObjectArray(body.tools);
  if (tools === null) {
    return invalidMessagesRequest(requestId);
  }
  const toolChoice = readOptionalToolChoice(body.tool_choice);
  if (toolChoice === null) {
    return invalidMessagesRequest(requestId);
  }

  return {
    ok: true,
    request: omitUndefined({
      maxOutputTokens,
      messages: messages as NormalizedAnthropicMessage[],
      metadata,
      serviceTier,
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      stopSequences,
      system: typeof body.system === "string" && body.system.trim() ? body.system : undefined,
      temperature,
      thinking,
      toolChoice,
      tools,
      topK,
      topP,
    }),
  };
}

export async function executeGatewayAnthropicMessages(input: {
  agentApiKeyId: string;
  adapter?: AnthropicProviderAdapter;
  databaseUrl: string;
  requestActivityId?: string;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayAnthropicMessagesResponse> {
  const normalized = normalizeAnthropicMessagesRequest(input.requestBody, input.requestId);
  if (!normalized.ok) {
    return {
      body: normalized.body,
      statusCode: normalized.statusCode,
    };
  }

  const requestMetadata = buildAnthropicMessagesRequestMetadata({
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
  let budgetReservation: GatewayBudgetReservation | undefined;
  let activity: GatewayRequestActivityRoute | undefined;
  const fallbackAttempts: FallbackFailedAttempt[] = [];
  try {
    const routeDecision = selectRouteCandidate({
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      snapshot: input.snapshot,
      usesTools: requestMetadata.usesTools,
      virtualModelId: input.virtualModel.id,
    });
    const routePolicy = requireRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);
    const attemptCandidates = buildFallbackAttemptCandidates({
      routePolicy,
      selectedProviderModelId: routeDecision.providerModelId,
    });
    const selectedCandidate = requireFirstCandidate(attemptCandidates);
    activity = buildRequestActivityRoute({
      candidate: selectedCandidate,
      fallbackAttempts,
      routeDecision,
    });
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
      candidates: attemptCandidates,
      databaseUrl: input.databaseUrl,
      masterKeySource: readGatewayMasterKeySource(),
    });
    const success = await executeMessagesFallback({
      adapter: input.adapter ?? createAnthropicProviderAdapter(),
      candidates,
      databaseUrl: input.databaseUrl,
      fallbackAttempts,
      request: normalized.request,
      requestActivityId: input.requestActivityId,
      requestId: input.requestId,
    });
    if (!success) {
      throw new Error("Provider request failed.");
    }

    await finalizeGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
    });
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
    await releaseGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
    });
    const message = error instanceof Error ? error.message : "Provider request failed.";
    const code = classifyMessagesError(message);
    return {
      activity,
      body: createGatewayAnthropicMessagesErrorBody(code, input.requestId),
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

async function executeMessagesFallback(input: {
  adapter: AnthropicProviderAdapter;
  candidates: readonly FallbackChainCandidate[];
  databaseUrl: string;
  fallbackAttempts: FallbackFailedAttempt[];
  request: NormalizedAnthropicMessagesRequest;
  requestActivityId?: string;
  requestId: string;
}): Promise<
  | {
      candidate: FallbackChainCandidate & {
        providerApiKeyId?: string;
        providerApiKeyPrefix?: string;
      };
      result: AnthropicAdapterSuccess;
    }
  | undefined
> {
  let attemptOrder = 0;
  const claudeCodeAdapter = input.adapter ? null : createClaudeCodeProviderAdapter();
  for (const candidate of input.candidates) {
    if (
      isSubscriptionProviderKey(candidate.providerKey) &&
      candidate.providerKey !== "claude_code"
    ) {
      continue;
    }
    const adapter =
      candidate.providerKey === "claude_code" && claudeCodeAdapter
        ? claudeCodeAdapter
        : input.adapter;
    for (const providerApiKey of readFallbackProviderApiKeys(candidate)) {
      attemptOrder += 1;
      const providerStartedAt = new Date();
      const result = await adapter.messages({
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
      if (!failedAttempt.failedBeforeFirstByte) {
        return undefined;
      }
    }
  }
  return undefined;
}

export function createGatewayAnthropicMessagesErrorBody(
  code: GatewayAnthropicMessagesErrorCode,
  requestId: string,
): GatewayAnthropicMessagesErrorBody {
  return {
    error: {
      code,
      message: messagesErrorMessage(code),
    },
    requestId,
  };
}

function readAnthropicMessage(value: unknown): NormalizedAnthropicMessage | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.role !== "user" && value.role !== "assistant") {
    return null;
  }
  const content = readAnthropicMessageContent(value.content);
  if (!content) {
    return null;
  }

  return {
    content,
    role: value.role,
  };
}

function readAnthropicMessageContent(value: unknown): AnthropicMessageContent | null {
  if (typeof value === "string") {
    return value.trim() ? value : null;
  }
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const blocks = value.map(readAnthropicContentBlock);
  if (blocks.some((block) => !block)) {
    return null;
  }
  return blocks as AnthropicContentBlock[];
}

function readAnthropicContentBlock(value: unknown): AnthropicContentBlock | null {
  if (!isRecord(value) || typeof value.type !== "string" || !value.type.trim()) {
    return null;
  }
  return value as AnthropicContentBlock;
}

function readRequiredPositiveInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

function readOptionalPositiveInteger(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return readRequiredPositiveInteger(value);
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

function readOptionalRecord(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  return value;
}

function readOptionalNonEmptyString(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  return value;
}

function readOptionalNonEmptyStringArray(value: unknown): string[] | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "string" || !entry.trim())
  ) {
    return null;
  }
  return value;
}

function readOptionalToolChoice(value: unknown): Record<string, unknown> | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== "string" || !value.type.trim()) {
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

function requireFirstCandidate(
  candidates: readonly GatewayRouteCandidateSnapshot[],
): GatewayRouteCandidateSnapshot {
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error("Selected route candidate was not found in route policy.");
  }
  return candidate;
}

function buildRequestActivityRoute(input: {
  candidate: GatewayRouteCandidateSnapshot & {
    providerApiKeyId?: string;
    providerApiKeyPrefix?: string;
  };
  fallbackAttempts: FallbackFailedAttempt[];
  routeDecision: ReturnType<typeof selectRouteCandidate>;
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

function invalidMessagesRequest(requestId: string): GatewayAnthropicMessagesRequestFailure {
  return {
    body: createGatewayAnthropicMessagesErrorBody("invalid_messages_request", requestId),
    ok: false,
    statusCode: 400,
  };
}

function classifyMessagesError(message: string): GatewayAnthropicMessagesErrorCode {
  if (message.includes("No route policy") || message.includes("Route policy")) {
    return "route_not_found";
  }
  if (message.includes("Provider credentials") || message.includes("Provider base URL")) {
    return "provider_credentials_missing";
  }
  return "provider_request_failed";
}

function messagesErrorMessage(code: GatewayAnthropicMessagesErrorCode): string {
  if (code === "invalid_messages_request") {
    return "Anthropic messages request must include max_tokens and at least one message.";
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
