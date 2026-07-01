import { randomUUID } from "node:crypto";
import { PostgresClient } from "@llmingress/db/client";
import { recordProviderHealthEvent } from "@llmingress/db/provider-health";
import {
  classifyProviderFailureStatus,
  shouldRecordProviderRequestPathHealthFailure,
} from "@llmingress/provider/connectivity";
import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIChatRequest,
  type OpenAIAdapterError,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "@llmingress/provider/openai";
import { createOpenRouterProviderAdapter } from "@llmingress/provider/openrouter";
import type { GatewayBudgetReservation } from "./gateway-budgets.ts";
import type { GatewayRouteCandidateSnapshot } from "./gateway-config-reload.ts";
import { recordGatewayProviderTrace } from "./gateway-tracing.ts";

export type FallbackChainCandidate = GatewayRouteCandidateSnapshot & {
  apiKey: string;
  baseUrl: string;
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
  providerApiKeys?: readonly FallbackProviderApiKey[];
};

export type FallbackProviderApiKey = {
  apiKey: string;
  credentialKind?: "api_key" | "oauth";
  keyPrefix?: string;
  providerApiKeyId?: string;
  providerOAuthId?: string;
};

export type FallbackFailedAttempt = {
  attemptOrder: number;
  errorCode: string;
  errorMessage: string;
  failedBeforeFirstByte: boolean;
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
  providerModelId: string;
  retryable: boolean;
  statusCode: number | null;
};

export type FallbackSucceededAttempt = {
  attemptOrder: number;
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
  providerModelId: string;
};

export type FallbackChainResult = {
  failedAttempts: FallbackFailedAttempt[];
  result: OpenAIAdapterSuccess;
  selectedCandidate: FallbackChainCandidate;
};

export type ProviderFallbackAttemptSuccess = {
  body: unknown;
  ok: true;
  statusCode: number;
};

export type ProviderFallbackAttemptResult<TSuccess extends ProviderFallbackAttemptSuccess> =
  | TSuccess
  | (FallbackAttemptErrorLike & { ok: false });

export type ProviderFallbackAttemptsResult<TSuccess extends ProviderFallbackAttemptSuccess> = {
  candidate: FallbackChainCandidate & {
    providerApiKeyId?: string;
    providerApiKeyPrefix?: string;
  };
  result: TSuccess;
};

export type ExecuteProviderFallbackAttemptsInput<TSuccess extends ProviderFallbackAttemptSuccess> =
  {
    callProvider: (input: {
      candidate: FallbackChainCandidate;
      providerApiKey: FallbackProviderApiKey;
    }) => Promise<ProviderFallbackAttemptResult<TSuccess>>;
    candidates: readonly FallbackChainCandidate[];
    databaseUrl?: string;
    fallbackAttempts: FallbackFailedAttempt[];
    finalizeAttempt?: (reservation: GatewayBudgetReservation | undefined) => Promise<void>;
    recordFailedAttempt?: (attempt: FallbackFailedAttempt) => Promise<void>;
    recordHealthEvent?: typeof recordProviderHealthEvent;
    releaseAttempt?: (reservation: GatewayBudgetReservation | undefined) => Promise<void>;
    reserveAttempt?: (
      candidate: FallbackChainCandidate,
    ) => Promise<GatewayBudgetReservation | undefined>;
    requestActivityId?: string;
    requestId?: string;
  };

export type ExecuteFallbackChainInput = {
  adapter?: OpenAIProviderAdapter;
  candidates: readonly FallbackChainCandidate[];
  databaseUrl?: string;
  finalizeAttempt?: (reservation: GatewayBudgetReservation | undefined) => Promise<void>;
  recordFailedAttempt?: (attempt: FallbackFailedAttempt) => Promise<void>;
  recordHealthEvent?: typeof recordProviderHealthEvent;
  releaseAttempt?: (reservation: GatewayBudgetReservation | undefined) => Promise<void>;
  reserveAttempt?: (
    candidate: FallbackChainCandidate,
  ) => Promise<GatewayBudgetReservation | undefined>;
  request: NormalizedOpenAIChatRequest;
  requestActivityId?: string;
  requestId?: string;
};

type FallbackAttemptErrorLike = {
  errorCode: string;
  errorMessage: string;
  statusCode: number | null;
};

export async function executeFallbackChain(
  input: ExecuteFallbackChainInput,
): Promise<FallbackChainResult> {
  if (input.candidates.length === 0) {
    throw new Error("Fallback chain requires at least one candidate.");
  }

  const genericAdapter = input.adapter ?? createOpenAIProviderAdapter();
  const openRouterAdapter = input.adapter ?? createOpenRouterProviderAdapter();
  const failedAttempts: FallbackFailedAttempt[] = [];
  let lastError: OpenAIAdapterError | undefined;

  const fallbackResult = await executeProviderFallbackAttempts<OpenAIAdapterSuccess>({
    callProvider: async ({ candidate, providerApiKey }) => {
      const adapter = candidate.providerKey === "openrouter" ? openRouterAdapter : genericAdapter;
      const providerStartedAt = new Date();
      const result = await adapter.chatCompletion({
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
      if (!result.ok) {
        lastError = result;
      }
      return result;
    },
    candidates: input.candidates,
    databaseUrl: input.databaseUrl,
    fallbackAttempts: failedAttempts,
    finalizeAttempt: input.finalizeAttempt,
    recordFailedAttempt: input.recordFailedAttempt,
    recordHealthEvent: input.recordHealthEvent,
    releaseAttempt: input.releaseAttempt,
    reserveAttempt: input.reserveAttempt,
    requestActivityId: input.requestActivityId,
    requestId: input.requestId,
  });
  if (fallbackResult) {
    return {
      failedAttempts,
      result: fallbackResult.result,
      selectedCandidate: fallbackResult.candidate,
    };
  }

  throw new Error(lastError?.errorMessage ?? "All fallback candidates failed.");
}

export async function executeProviderFallbackAttempts<
  TSuccess extends ProviderFallbackAttemptSuccess,
>(
  input: ExecuteProviderFallbackAttemptsInput<TSuccess>,
): Promise<ProviderFallbackAttemptsResult<TSuccess> | undefined> {
  let attemptOrder = 0;
  for (const candidate of input.candidates) {
    const candidateFailedAttempts: FallbackFailedAttempt[] = [];
    for (const providerApiKey of readFallbackProviderApiKeys(candidate)) {
      attemptOrder += 1;
      const reservation = await input.reserveAttempt?.(candidate);
      let reservationSettled = false;
      try {
        const result = await input.callProvider({ candidate, providerApiKey });

        if (result.ok) {
          await recordSucceededAttemptInDatabase(input, {
            attemptOrder,
            ...(providerApiKey.providerApiKeyId
              ? { providerApiKeyId: providerApiKey.providerApiKeyId }
              : {}),
            ...(providerApiKey.keyPrefix ? { providerApiKeyPrefix: providerApiKey.keyPrefix } : {}),
            providerModelId: candidate.providerModelId,
          });
          reservationSettled = true;
          await input.finalizeAttempt?.(reservation);
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

        reservationSettled = true;
        await input.releaseAttempt?.(reservation);
        const failedAttempt = buildFallbackFailedAttempt({
          attemptOrder,
          providerApiKey,
          providerModelId: candidate.providerModelId,
          result,
        });
        input.fallbackAttempts.push(failedAttempt);
        candidateFailedAttempts.push(failedAttempt);
        await input.recordFailedAttempt?.(failedAttempt);
        await recordFailedAttemptInDatabase(input, failedAttempt);
      } catch (error) {
        if (!reservationSettled) {
          reservationSettled = true;
          await input.releaseAttempt?.(reservation);
        }
        throw error;
      }
    }

    if (candidateFailedAttempts.some((attempt) => !attempt.retryable)) {
      if (!input.requestActivityId && !input.recordHealthEvent) {
        return undefined;
      }
      await recordCandidateHealthFailure(input, candidate, candidateFailedAttempts);
      return undefined;
    }
  }

  return undefined;
}

export function buildFallbackFailedAttempt(input: {
  attemptOrder: number;
  providerApiKey: FallbackProviderApiKey;
  providerModelId: string;
  result: FallbackAttemptErrorLike;
}): FallbackFailedAttempt {
  const { statusCode } = input.result;
  return {
    attemptOrder: input.attemptOrder,
    errorCode: input.result.errorCode,
    errorMessage: input.result.errorMessage,
    failedBeforeFirstByte: statusCode === null,
    ...(input.providerApiKey.providerApiKeyId
      ? { providerApiKeyId: input.providerApiKey.providerApiKeyId }
      : {}),
    ...(input.providerApiKey.keyPrefix
      ? { providerApiKeyPrefix: input.providerApiKey.keyPrefix }
      : {}),
    providerModelId: input.providerModelId,
    retryable: statusCode === null || statusCode === 429 || statusCode >= 500,
    statusCode,
  };
}

export function readFallbackProviderApiKeys(
  candidate: FallbackChainCandidate,
): readonly FallbackProviderApiKey[] {
  if (candidate.providerApiKeys && candidate.providerApiKeys.length > 0) {
    return candidate.providerApiKeys;
  }

  return [
    {
      apiKey: candidate.apiKey,
      ...(candidate.providerApiKeyPrefix ? { keyPrefix: candidate.providerApiKeyPrefix } : {}),
      ...(candidate.providerApiKeyId ? { providerApiKeyId: candidate.providerApiKeyId } : {}),
    },
  ];
}

export async function recordSucceededAttemptInDatabase(
  input: Pick<ExecuteFallbackChainInput, "databaseUrl" | "requestActivityId">,
  attempt: FallbackSucceededAttempt,
): Promise<void> {
  if (!input.requestActivityId) {
    return;
  }

  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `
        insert into fallback_events (
          id,
          request_activity_id,
          provider_model_id,
          provider_api_key_id,
          provider_api_key_prefix,
          attempt_order,
          status,
          failed_before_first_byte
        )
        values ($1, $2, $3, $4, $5, $6, 'succeeded', false)
      `,
      [
        randomUUID(),
        input.requestActivityId,
        attempt.providerModelId,
        attempt.providerApiKeyId || null,
        attempt.providerApiKeyPrefix || null,
        attempt.attemptOrder,
      ],
    );
  } finally {
    await client.end();
  }
}

export async function recordFailedAttemptInDatabase(
  input: Pick<ExecuteFallbackChainInput, "databaseUrl" | "requestActivityId">,
  attempt: FallbackFailedAttempt,
): Promise<void> {
  if (!input.requestActivityId) {
    return;
  }

  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `
        insert into fallback_events (
          id,
          request_activity_id,
          provider_model_id,
          provider_api_key_id,
          provider_api_key_prefix,
          attempt_order,
          status,
          error_code,
          error_message,
          failed_before_first_byte
        )
        values ($1, $2, $3, $4, $5, $6, 'failed', $7, $8, $9)
      `,
      [
        randomUUID(),
        input.requestActivityId,
        attempt.providerModelId,
        attempt.providerApiKeyId || null,
        attempt.providerApiKeyPrefix || null,
        attempt.attemptOrder,
        attempt.errorCode,
        attempt.errorMessage,
        attempt.failedBeforeFirstByte,
      ],
    );
  } finally {
    await client.end();
  }
}

export async function recordCandidateHealthFailure(
  input: Pick<ExecuteFallbackChainInput, "databaseUrl" | "recordHealthEvent">,
  candidate: FallbackChainCandidate,
  failedAttempts: FallbackFailedAttempt[],
): Promise<void> {
  if (failedAttempts.length === 0) {
    return;
  }

  const latestAttempt = failedAttempts[failedAttempts.length - 1];
  if (!latestAttempt) {
    return;
  }
  if (
    !shouldRecordProviderRequestPathHealthFailure({
      errorCode: latestAttempt.errorCode,
      errorMessage: latestAttempt.errorMessage,
      statusCode: latestAttempt.statusCode,
    })
  ) {
    return;
  }

  const healthRecorder = input.recordHealthEvent ?? recordProviderHealthEvent;

  const shared = {
    ...(input.databaseUrl ? { databaseUrl: input.databaseUrl } : {}),
    errorCode: latestAttempt.errorCode,
    errorMessage: latestAttempt.errorMessage,
    metadata: {
      attemptCount: failedAttempts.length,
      failedBeforeFirstByte: latestAttempt.failedBeforeFirstByte,
      providerApiKeyPrefix: latestAttempt.providerApiKeyPrefix ?? null,
    },
    status: classifyProviderFailureStatus({
      errorCode: latestAttempt.errorCode,
      errorMessage: latestAttempt.errorMessage,
      statusCode: latestAttempt.statusCode,
    }),
    trigger: "request_path" as const,
  };

  await healthRecorder({
    ...shared,
    providerId: candidate.providerId,
  });
  await healthRecorder({
    ...shared,
    providerId: candidate.providerId,
    providerModelId: candidate.providerModelId,
  });
}
