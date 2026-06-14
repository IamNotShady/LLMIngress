import { randomUUID } from "node:crypto";
import { Client } from "pg";
import type { GatewayRouteCandidateSnapshot, GatewayRoutePolicySnapshot } from "./config-reload.js";
import {
  createOpenAIProviderAdapter,
  type NormalizedOpenAIChatRequest,
  type OpenAIAdapterError,
  type OpenAIAdapterSuccess,
  type OpenAIProviderAdapter,
} from "./provider-adapters/openai.js";

export type FallbackChainCandidate = GatewayRouteCandidateSnapshot & {
  apiKey: string;
  baseUrl: string;
};

export type FallbackFailedAttempt = {
  attemptOrder: number;
  errorCode: string;
  errorMessage: string;
  failedBeforeFirstByte: boolean;
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

  const adapter = input.adapter ?? createOpenAIProviderAdapter();
  const failedAttempts: FallbackFailedAttempt[] = [];
  let lastError: OpenAIAdapterError | undefined;

  for (const [index, candidate] of input.candidates.entries()) {
    const result = await adapter.chatCompletion({
      request: input.request,
      target: {
        apiKey: candidate.apiKey,
        baseUrl: candidate.baseUrl,
        modelId: candidate.modelId,
      },
    });

    if (result.ok) {
      return {
        failedAttempts,
        result,
        selectedCandidate: candidate,
      };
    }

    lastError = result;
    const failedAttempt = {
      attemptOrder: index + 1,
      errorCode: result.errorCode,
      errorMessage: result.errorMessage,
      failedBeforeFirstByte: result.statusCode === null,
      providerModelId: candidate.providerModelId,
    };
    failedAttempts.push(failedAttempt);
    await input.recordFailedAttempt?.(failedAttempt);
    await recordFailedAttemptInDatabase(input, failedAttempt);

    if (!failedAttempt.failedBeforeFirstByte) {
      throw new Error(result.errorMessage);
    }
  }

  throw new Error(lastError?.errorMessage ?? "All fallback candidates failed.");
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
          attempt_order,
          status,
          error_code,
          error_message,
          failed_before_first_byte
        )
        values ($1, $2, $3, $4, 'failed', $5, $6, $7)
      `,
      [
        randomUUID(),
        input.requestActivityId,
        attempt.providerModelId,
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
