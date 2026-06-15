import { randomUUID } from "node:crypto";
import { recordProviderHealthEvent } from "@llmingress/db/provider-health";
import { Client } from "pg";
import type { GatewayRouteCandidateSnapshot, GatewayRoutePolicySnapshot } from "./config-reload.js";
import { createGeminiProviderAdapter } from "./provider-adapters/gemini.js";
import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIChatRequest,
  type OpenAIAdapterError,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "./provider-adapters/openai.js";
import { createOpenRouterProviderAdapter } from "./provider-adapters/openrouter.js";

export type FallbackChainCandidate = GatewayRouteCandidateSnapshot & {
  apiKey: string;
  baseUrl: string;
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
  providerApiKeys?: readonly FallbackProviderApiKey[];
};

export type FallbackProviderApiKey = {
  apiKey: string;
  keyPrefix?: string;
  providerApiKeyId?: string;
};

export type FallbackFailedAttempt = {
  attemptOrder: number;
  errorCode: string;
  errorMessage: string;
  failedBeforeFirstByte: boolean;
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
  recordFailedAttempt?: (attempt: FallbackFailedAttempt) => Promise<void>;
  request: NormalizedOpenAIChatRequest;
  requestActivityId?: string;
};

export function buildFallbackAttemptCandidates(input: {
  routePolicy: GatewayRoutePolicySnapshot;
  selectedProviderModelId: string;
}): GatewayRouteCandidateSnapshot[] {
  const selectedCandidate = input.routePolicy.candidates.find(
    (candidate) => candidate.providerModelId === input.selectedProviderModelId,
  );
  if (!selectedCandidate) {
    throw new Error("Selected route candidate was not found in route policy.");
  }

  const fallbackCandidates = input.routePolicy.candidates
    .filter((candidate) => candidate.isFallback)
    .sort((left, right) => left.candidateOrder - right.candidateOrder);

  return [selectedCandidate, ...fallbackCandidates];
}

export async function executeFallbackChain(
  input: ExecuteFallbackChainInput,
): Promise<FallbackChainResult> {
  if (input.candidates.length === 0) {
    throw new Error("Fallback chain requires at least one candidate.");
  }

  const genericAdapter = input.adapter ?? createOpenAIProviderAdapter();
  const geminiAdapter = input.adapter ?? createGeminiProviderAdapter();
  const openRouterAdapter = input.adapter ?? createOpenRouterProviderAdapter();
  const failedAttempts: FallbackFailedAttempt[] = [];
  let lastError: OpenAIAdapterError | undefined;

  let attemptOrder = 0;
  for (const candidate of input.candidates) {
    const adapter =
      candidate.providerKey === "gemini"
        ? geminiAdapter
        : candidate.providerKey === "openrouter"
          ? openRouterAdapter
          : genericAdapter;
    const providerApiKeys = readFallbackProviderApiKeys(candidate);
    const candidateFailedAttempts: FallbackFailedAttempt[] = [];

    for (const providerApiKey of providerApiKeys) {
      attemptOrder += 1;
      const result = await adapter.chatCompletion({
        request: input.request,
        target: {
          apiKey: providerApiKey.apiKey,
          baseUrl: candidate.baseUrl,
          modelId: candidate.modelId,
        },
      });

      if (result.ok) {
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

      lastError = result;
      const failedAttempt: FallbackFailedAttempt = {
        attemptOrder,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        failedBeforeFirstByte: result.statusCode === null,
        ...(providerApiKey.providerApiKeyId
          ? { providerApiKeyId: providerApiKey.providerApiKeyId }
          : {}),
        ...(providerApiKey.keyPrefix ? { providerApiKeyPrefix: providerApiKey.keyPrefix } : {}),
        providerModelId: candidate.providerModelId,
      };
      failedAttempts.push(failedAttempt);
      candidateFailedAttempts.push(failedAttempt);
      await input.recordFailedAttempt?.(failedAttempt);
      await recordFailedAttemptInDatabase(input, failedAttempt);
    }

    await recordCandidateHealthFailure(input, candidate, candidateFailedAttempts);

    if (candidateFailedAttempts.some((attempt) => !attempt.failedBeforeFirstByte)) {
      throw new Error(lastError?.errorMessage ?? "Provider request failed.");
    }
  }

  throw new Error(lastError?.errorMessage ?? "All fallback candidates failed.");
}

function readFallbackProviderApiKeys(
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

async function recordFailedAttemptInDatabase(
  input: ExecuteFallbackChainInput,
  attempt: FallbackFailedAttempt,
): Promise<void> {
  if (!input.databaseUrl || !input.requestActivityId) {
    return;
  }

  const client = new Client({ connectionString: input.databaseUrl });
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

  const shared = {
    databaseUrl: input.databaseUrl,
    errorCode: latestAttempt.errorCode,
    errorMessage: latestAttempt.errorMessage,
    metadata: {
      attemptCount: failedAttempts.length,
      failedBeforeFirstByte: latestAttempt.failedBeforeFirstByte,
      providerApiKeyPrefix: latestAttempt.providerApiKeyPrefix ?? null,
    },
    status: "failed" as const,
    trigger: "request_path" as const,
  };

  await recordProviderHealthEvent({
    ...shared,
    providerId: candidate.providerId,
  });
  await recordProviderHealthEvent({
    ...shared,
    providerId: candidate.providerId,
    providerModelId: candidate.providerModelId,
  });
}
