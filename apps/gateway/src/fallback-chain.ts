import { randomUUID } from "node:crypto";
import { recordProviderHealthEvent } from "@llmingress/db/provider-health";
import { PostgresClient } from "@llmingress/db/providers";
import { classifyProviderFailureStatus } from "@llmingress/provider/connectivity";
import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIChatRequest,
  type OpenAIAdapterError,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "@llmingress/provider/openai";
import { createOpenRouterProviderAdapter } from "@llmingress/provider/openrouter";
import type { GatewayRouteCandidateSnapshot } from "./config-reload.js";
import { recordGatewayProviderTrace } from "./tracing.js";
import type { GatewayBudgetReservation } from "./budgets.js";

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

export type ExecuteFallbackChainInput = {
  adapter?: OpenAIProviderAdapter;
  candidates: readonly FallbackChainCandidate[];
  databaseUrl?: string;
  finalizeAttempt?: (reservation: GatewayBudgetReservation | undefined) => Promise<void>;
  recordFailedAttempt?: (attempt: FallbackFailedAttempt) => Promise<void>;
  recordHealthEvent?: typeof recordProviderHealthEvent;
  releaseAttempt?: (reservation: GatewayBudgetReservation | undefined) => Promise<void>;
  reserveAttempt?: (candidate: FallbackChainCandidate) => Promise<GatewayBudgetReservation | undefined>;
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

  let attemptOrder = 0;
  for (const candidate of input.candidates) {
    const adapter = candidate.providerKey === "openrouter" ? openRouterAdapter : genericAdapter;
    const providerApiKeys = readFallbackProviderApiKeys(candidate);
    const candidateFailedAttempts: FallbackFailedAttempt[] = [];

    for (const providerApiKey of providerApiKeys) {
      attemptOrder += 1;
      const providerStartedAt = new Date();
      const reservation = await input.reserveAttempt?.(candidate);
      // Once a reservation is taken it must be settled exactly once: finalized
      // on success, released on failure, or released on any throw before the
      // outcome is committed. This guarantees a reservation can never leak.
      let reservationSettled = false;
      try {
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
            failedAttempts,
            result,
            selectedCandidate: {
              ...candidate,
              apiKey: providerApiKey.apiKey,
              providerApiKeyId: providerApiKey.providerApiKeyId,
              providerApiKeyPrefix: providerApiKey.keyPrefix,
            },
          };
        }

        reservationSettled = true;
        await input.releaseAttempt?.(reservation);
        lastError = result;
        const failedAttempt = buildFallbackFailedAttempt({
          attemptOrder,
          result,
          providerApiKey,
          providerModelId: candidate.providerModelId,
        });
        failedAttempts.push(failedAttempt);
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

    const hasNonRetryable = candidateFailedAttempts.some((a) => !a.retryable);
    if (hasNonRetryable) {
      await recordCandidateHealthFailure(input, candidate, candidateFailedAttempts);
      throw new Error(lastError?.errorMessage ?? "Provider request failed.");
    }
    // All failures are retryable (429/5xx/network-null): advance to the next candidate.
  }

  throw new Error(lastError?.errorMessage ?? "All fallback candidates failed.");
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
  if (!input.databaseUrl || !input.requestActivityId) {
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
  if (!input.databaseUrl || !input.requestActivityId) {
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

async function recordCandidateHealthFailure(
  input: ExecuteFallbackChainInput,
  candidate: FallbackChainCandidate,
  failedAttempts: FallbackFailedAttempt[],
): Promise<void> {
  if (!input.databaseUrl || failedAttempts.length === 0) {
    return;
  }

  const latestAttempt = failedAttempts[failedAttempts.length - 1];
  if (!latestAttempt) {
    return;
  }

  const healthRecorder = input.recordHealthEvent ?? recordProviderHealthEvent;

  const shared = {
    databaseUrl: input.databaseUrl,
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
      statusCode: latestAttempt.failedBeforeFirstByte ? null : undefined,
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
