import { selectRouteAttempts } from "@llmingress/domain";
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
import type { GatewayRequestActivityRoute } from "./gateway-activity-recorder.ts";
import {
  buildGatewayBudgetActualUsage,
  finalizeGatewayBudgetReservation,
  GatewayBudgetRejectedError,
  releaseGatewayBudgetReservation,
  reserveGatewayBudget,
} from "./gateway-budgets.ts";
import type { GatewayConfigSnapshot } from "./gateway-config-reload.ts";
import { mapGatewayErrorStatus } from "./gateway-error-mapping.ts";
import {
  createGatewayErrorBody,
  type GatewayErrorBody,
  GatewayPipelineError,
  toGatewayErrorResponseParts,
} from "./gateway-errors.ts";
import {
  executeProviderFallbackAttempts,
  type FallbackFailedAttempt,
} from "./gateway-fallback-chain.ts";
import {
  attachGatewayProviderCredentialsLeniently,
  readGatewayMasterKeySource,
  recordGatewayProviderApiKeyLastUsed,
} from "./gateway-provider-credentials.ts";
import { enforceGatewayRateLimits, releaseGatewayConcurrency } from "./gateway-rate-limits.ts";
import {
  buildAnthropicMessagesRequestMetadata,
  type GatewayRequestMetadata,
} from "./gateway-request-metadata.ts";
import {
  buildGatewayRequestActivityRoute,
  isRecord,
  omitUndefined,
  requireGatewayRoutePolicy,
  selectGatewayBaselineCandidate,
} from "./gateway-runtime-helpers.ts";
import { recordGatewayProviderTrace } from "./gateway-tracing.ts";
import { readGatewayProviderTokenUsage } from "./gateway-usage-collector.ts";
import type { GatewayUsageCostDetails } from "./gateway-usage-recorder.ts";
import type { GatewayVirtualModel } from "./gateway-virtual-model-access.ts";

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
  body: GatewayErrorBody;
  ok: false;
  statusCode: 400;
};

export type GatewayAnthropicMessagesRequestResult =
  | GatewayAnthropicMessagesRequestFailure
  | GatewayAnthropicMessagesRequestSuccess;

const maxMessagesOutputTokens = 16_384;

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
  const system = readOptionalSystemPrompt(body.system);
  if (system === null) {
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
      system,
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
  databaseUrl?: string;
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
        body: createGatewayErrorBody("provider_unavailable", input.requestId),
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
    const genericAdapter = input.adapter ?? createAnthropicProviderAdapter();
    const claudeCodeAdapter = input.adapter ? null : createClaudeCodeProviderAdapter();
    const supportedCandidates = candidates.filter(
      (candidate) =>
        !isSubscriptionProviderKey(candidate.providerKey) ||
        candidate.providerKey === "claude_code",
    );
    const success = await executeProviderFallbackAttempts<AnthropicAdapterSuccess>({
      callProvider: async ({ candidate, providerApiKey }) => {
        const adapter =
          candidate.providerKey === "claude_code" && claudeCodeAdapter
            ? claudeCodeAdapter
            : genericAdapter;
        const providerStartedAt = new Date();
        const result = await adapter.messages({
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
      body: createGatewayErrorBody(parts.code, input.requestId, parts.message),
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
  return Math.min(value, maxMessagesOutputTokens);
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

function readOptionalSystemPrompt(value: unknown): AnthropicMessageContent | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value.trim() ? value : undefined;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return undefined;
    }
    if (value.some((block) => !isRecord(block) || typeof block.type !== "string")) {
      return null;
    }
    return value as AnthropicContentBlock[];
  }
  return null;
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

function invalidMessagesRequest(requestId: string): GatewayAnthropicMessagesRequestFailure {
  return {
    body: createGatewayErrorBody("invalid_messages_request", requestId),
    ok: false,
    statusCode: 400,
  };
}
