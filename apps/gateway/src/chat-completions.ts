import type { MasterKeySource } from "@llmingress/security/master-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";
import { Client, type QueryResultRow } from "pg";
import {
  finalizeGatewayBudgetReservation,
  type GatewayBudgetReservation,
  releaseGatewayBudgetReservation,
  reserveGatewayBudget,
} from "./budgets.js";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./config-reload.js";
import {
  buildFallbackAttemptCandidates,
  executeFallbackChain,
  type FallbackChainCandidate,
} from "./fallback-chain.js";
import type {
  NormalizedOpenAIChatMessage,
  NormalizedOpenAIChatRequest,
  OpenAIProviderAdapter,
} from "./provider-adapters/openai.js";
import { enforceGatewayRateLimits } from "./rate-limits.js";
import {
  buildOpenAIChatCompletionRequestMetadata,
  type GatewayRequestMetadata,
} from "./request-metadata.js";
import { selectRouteCandidate } from "./route-engine.js";
import type { GatewayVirtualModel } from "./virtual-model-access.js";

export type GatewayChatCompletionErrorCode =
  | "invalid_chat_request"
  | "provider_credentials_missing"
  | "provider_request_failed"
  | "route_not_found";

export type GatewayChatCompletionErrorBody = {
  error: {
    code: GatewayChatCompletionErrorCode;
    message: string;
  };
  requestId: string;
};

export type GatewayChatCompletionResponse = {
  body: unknown;
  headers?: Record<string, string>;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
};

export type GatewayChatCompletionRequestSuccess = {
  ok: true;
  request: NormalizedOpenAIChatRequest;
};

export type GatewayChatCompletionRequestFailure = {
  body: GatewayChatCompletionErrorBody;
  ok: false;
  statusCode: 400;
};

export type GatewayChatCompletionRequestResult =
  | GatewayChatCompletionRequestFailure
  | GatewayChatCompletionRequestSuccess;

type ProviderCredentialRow = QueryResultRow & {
  base_url: string | null;
  encrypted_key: unknown;
  provider_id: string;
};

export function normalizeOpenAIChatCompletionRequest(
  body: unknown,
  requestId: string,
): GatewayChatCompletionRequestResult {
  if (!isRecord(body) || !Array.isArray(body.messages) || body.messages.length === 0) {
    return invalidChatRequest(requestId);
  }

  const messages = body.messages.map(readOpenAIChatMessage);
  if (messages.some((message) => !message)) {
    return invalidChatRequest(requestId);
  }

  const maxOutputTokens = readOptionalPositiveInteger(body.max_tokens);
  if (maxOutputTokens === null) {
    return invalidChatRequest(requestId);
  }

  const temperature = readOptionalFiniteNumber(body.temperature);
  if (temperature === null) {
    return invalidChatRequest(requestId);
  }

  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    return invalidChatRequest(requestId);
  }

  return {
    ok: true,
    request: omitUndefined({
      maxOutputTokens,
      messages: messages as NormalizedOpenAIChatMessage[],
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      temperature,
    }),
  };
}

export async function executeGatewayOpenAIChatCompletion(input: {
  agentApiKeyId: string;
  adapter?: OpenAIProviderAdapter;
  databaseUrl: string;
  masterKeySource?: MasterKeySource;
  requestBody: unknown;
  requestId: string;
  snapshot: GatewayConfigSnapshot;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayChatCompletionResponse> {
  const normalized = normalizeOpenAIChatCompletionRequest(input.requestBody, input.requestId);
  if (!normalized.ok) {
    return {
      body: normalized.body,
      statusCode: normalized.statusCode,
    };
  }

  const requestMetadata = buildOpenAIChatCompletionRequestMetadata({
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
  try {
    const routeDecision = selectRouteCandidate({
      estimatedInputTokens: requestMetadata.estimatedInputTokens,
      estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
      snapshot: input.snapshot,
      virtualModelId: input.virtualModel.id,
    });
    const routePolicy = requireRoutePolicy(input.snapshot, routeDecision.routePolicyId);
    const attemptCandidates = buildFallbackAttemptCandidates({
      routePolicy,
      selectedProviderModelId: routeDecision.providerModelId,
    });
    const selectedCandidate = attemptCandidates[0];
    if (!selectedCandidate) {
      throw new Error("Selected route candidate was not found in route policy.");
    }

    const budget = await reserveGatewayBudget({
      agentApiKeyId: input.agentApiKeyId,
      databaseUrl: input.databaseUrl,
      price: selectedCandidate.price,
      requestId: input.requestId,
      requestMetadata,
    });
    if (!budget.ok) {
      return {
        body: budget.body,
        requestMetadata,
        statusCode: budget.statusCode,
      };
    }
    budgetReservation = budget.reservation;

    const candidates = await attachGatewayProviderCredentials({
      candidates: attemptCandidates,
      databaseUrl: input.databaseUrl,
      masterKeySource: input.masterKeySource ?? readGatewayMasterKeySource(),
    });
    const result = await executeFallbackChain({
      adapter: input.adapter,
      candidates,
      request: normalized.request,
    });
    await finalizeGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
    });

    return {
      body: result.result.body,
      requestMetadata,
      statusCode: result.result.statusCode,
    };
  } catch (error) {
    await releaseGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
    });
    const message = error instanceof Error ? error.message : "Provider request failed.";
    const code = classifyChatCompletionError(message);
    return {
      body: createGatewayChatCompletionErrorBody(code, input.requestId),
      requestMetadata,
      statusCode: code === "provider_request_failed" ? 502 : 500,
    };
  }
}

export async function attachGatewayProviderCredentials(input: {
  candidates: readonly GatewayRouteCandidateSnapshot[];
  databaseUrl: string;
  masterKeySource: MasterKeySource;
}): Promise<FallbackChainCandidate[]> {
  const providerIds = [...new Set(input.candidates.map((candidate) => candidate.providerId))];
  const credentials = await readProviderCredentials({
    databaseUrl: input.databaseUrl,
    masterKeySource: input.masterKeySource,
    providerIds,
  });

  return input.candidates.map((candidate) => {
    const credential = credentials.get(candidate.providerId);
    if (!credential) {
      throw new Error(`Provider credentials are missing for provider ${candidate.providerId}.`);
    }

    return {
      ...candidate,
      apiKey: credential.apiKey,
      baseUrl: credential.baseUrl,
    };
  });
}

export function createGatewayChatCompletionErrorBody(
  code: GatewayChatCompletionErrorCode,
  requestId: string,
): GatewayChatCompletionErrorBody {
  return {
    error: {
      code,
      message: chatCompletionErrorMessage(code),
    },
    requestId,
  };
}

export function readGatewayMasterKeySource(
  env: Record<string, string | undefined> = process.env,
): MasterKeySource {
  const inlineKey = env.MASTER_KEY;
  if (inlineKey?.trim()) {
    return { kind: "inline", value: inlineKey };
  }

  const keyFile = env.MASTER_KEY_FILE;
  if (keyFile?.trim()) {
    return { kind: "file", path: keyFile };
  }

  throw new Error("MASTER_KEY or MASTER_KEY_FILE is required for Gateway provider calls.");
}

function invalidChatRequest(requestId: string): GatewayChatCompletionRequestFailure {
  return {
    body: createGatewayChatCompletionErrorBody("invalid_chat_request", requestId),
    ok: false,
    statusCode: 400,
  };
}

function readOpenAIChatMessage(value: unknown): NormalizedOpenAIChatMessage | null {
  if (!isRecord(value) || typeof value.content !== "string" || !value.content.trim()) {
    return null;
  }
  if (
    value.role !== "system" &&
    value.role !== "user" &&
    value.role !== "assistant" &&
    value.role !== "tool"
  ) {
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

async function readProviderCredentials(input: {
  databaseUrl: string;
  masterKeySource: MasterKeySource;
  providerIds: string[];
}): Promise<Map<string, { apiKey: string; baseUrl: string }>> {
  if (input.providerIds.length === 0) {
    return new Map();
  }

  const encryption = createSecretEncryption(input.masterKeySource);
  const client = new Client({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const result = await client.query<ProviderCredentialRow>(
      `
        select providers.id::text as provider_id,
               providers.base_url,
               provider_api_keys.encrypted_key
        from providers
        join provider_api_keys on provider_api_keys.provider_id = providers.id
        where providers.id = any($1::uuid[])
          and providers.enabled = true
      `,
      [input.providerIds],
    );
    return new Map(
      result.rows.map((row) => {
        if (!row.base_url?.trim()) {
          throw new Error(`Provider base URL is missing for provider ${row.provider_id}.`);
        }

        return [
          row.provider_id,
          {
            apiKey: encryption.decrypt(readEncryptedSecret(row.encrypted_key)),
            baseUrl: row.base_url,
          },
        ];
      }),
    );
  } finally {
    await client.end();
  }
}

function readEncryptedSecret(value: unknown): EncryptedSecret {
  if (
    isRecord(value) &&
    value.version === 1 &&
    value.algorithm === "aes-256-gcm" &&
    typeof value.keyId === "string" &&
    typeof value.iv === "string" &&
    typeof value.ciphertext === "string" &&
    typeof value.authTag === "string"
  ) {
    return value as EncryptedSecret;
  }

  throw new Error("Stored provider API key is not a valid encrypted secret.");
}

function classifyChatCompletionError(message: string): GatewayChatCompletionErrorCode {
  if (message.includes("No route policy") || message.includes("Route policy")) {
    return "route_not_found";
  }
  if (message.includes("Provider credentials") || message.includes("Provider base URL")) {
    return "provider_credentials_missing";
  }
  return "provider_request_failed";
}

function chatCompletionErrorMessage(code: GatewayChatCompletionErrorCode): string {
  if (code === "invalid_chat_request") {
    return "Chat completion request must include at least one string-content message.";
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
