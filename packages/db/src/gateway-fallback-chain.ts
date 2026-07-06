import { recordProviderHealthEvent } from "@llmingress/db/provider-health";
import {
  classifyProviderFailureStatus,
  shouldRecordProviderRequestPathHealthFailure,
} from "@llmingress/provider/connectivity";
import type { GatewayRouteCandidateSnapshot } from "./gateway-config-reload.ts";
import { GatewayPipelineError, truncateProviderMessage } from "./gateway-errors.ts";

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
    recordFailedAttempt?: (attempt: FallbackFailedAttempt) => Promise<void> | void;
    recordHealthEvent?: typeof recordProviderHealthEvent;
    requestId?: string;
  };

export type FallbackAttemptErrorLike = {
  body?: unknown;
  errorCode: string;
  errorMessage: string;
  statusCode: number | null;
};

export function buildFallbackExhaustionError(
  lastError: FallbackAttemptErrorLike | undefined,
): GatewayPipelineError {
  const status = lastError?.statusCode ?? null;
  if (status !== null && status >= 400 && status < 500 && status !== 429) {
    return new GatewayPipelineError(
      "provider_rejected_request",
      truncateProviderMessage(lastError?.errorMessage ?? "Provider rejected the request."),
      status,
    );
  }
  if (status === 429) {
    return new GatewayPipelineError("provider_rate_limited", "Provider rate limit exceeded.", 429);
  }
  return new GatewayPipelineError(
    "provider_request_failed",
    lastError?.errorMessage ?? "All fallback candidates failed.",
    status,
  );
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
      const result = await input.callProvider({ candidate, providerApiKey });

      if (result.ok) {
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
      candidateFailedAttempts.push(failedAttempt);
      await input.recordFailedAttempt?.(failedAttempt);
    }

    if (candidateFailedAttempts.some((attempt) => !attempt.retryable)) {
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

export async function recordCandidateHealthFailure(
  input: {
    databaseUrl?: string;
    recordHealthEvent?: typeof recordProviderHealthEvent;
  },
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
