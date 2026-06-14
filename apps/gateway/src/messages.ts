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
} from "./chat-completions.js";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./config-reload.js";
import {
  type AnthropicContentBlock,
  type AnthropicMessageContent,
  type AnthropicProviderAdapter,
  createAnthropicProviderAdapter,
  type NormalizedAnthropicMessage,
  type NormalizedAnthropicMessagesRequest,
} from "./provider-adapters/anthropic.js";
import { enforceGatewayRateLimits } from "./rate-limits.js";
import {
  buildAnthropicMessagesRequestMetadata,
  type GatewayRequestMetadata,
} from "./request-metadata.js";
import { selectRouteCandidate } from "./route-engine.js";
import { type GatewayUsageCostDetails, selectGatewayBaselineCandidate } from "./usage-recorder.js";
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
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      system: typeof body.system === "string" && body.system.trim() ? body.system : undefined,
      temperature,
      toolChoice,
      tools,
    }),
  };
}

export async function executeGatewayAnthropicMessages(input: {
  agentApiKeyId: string;
  adapter?: AnthropicProviderAdapter;
  databaseUrl: string;
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
      providerId: selectedCandidate.providerId,
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

    const result = await (input.adapter ?? createAnthropicProviderAdapter()).messages({
      request: normalized.request,
      target: {
        apiKey: selected.apiKey,
        baseUrl: selected.baseUrl,
        modelId: selected.modelId,
      },
    });
    if (!result.ok) {
      await releaseGatewayBudgetReservation({
        databaseUrl: input.databaseUrl,
        reservation: budgetReservation,
      });
      budgetReservation = undefined;
      return {
        activity,
        body: createGatewayAnthropicMessagesErrorBody("provider_request_failed", input.requestId),
        requestMetadata,
        statusCode: 502,
      };
    }

    await finalizeGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
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
        providerModelId: selectedCandidate.providerModelId,
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
      statusCode: code === "provider_request_failed" ? 502 : 500,
    };
  }
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
