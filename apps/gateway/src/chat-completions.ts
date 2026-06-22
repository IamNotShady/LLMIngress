import {
  completeProviderOAuthConnection,
  PostgresClient,
  type PostgresQueryResultRow,
  readEnabledCompletedProviderOAuthConnections,
} from "@llmingress/db/providers";
import { type ProviderOAuthTokenBlob, refreshProviderOAuthToken } from "@llmingress/provider/oauth";
import type {
  NormalizedOpenAIChatMessage,
  NormalizedOpenAIChatRequest,
  OpenAIProviderAdapter,
} from "@llmingress/provider/openai";
import { isSubscriptionProviderKey } from "@llmingress/provider/subscription";
import type { MasterKeySource } from "@llmingress/security/master-key";
import {
  createSecretEncryption,
  type EncryptedSecret,
} from "@llmingress/security/secret-encryption";
import type { GatewayRequestActivityRoute } from "./activity-recorder.js";
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
import { mapGatewayErrorStatus } from "./error-mapping.js";
import {
  buildFallbackAttemptCandidates,
  executeFallbackChain,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  type FallbackProviderApiKey,
} from "./fallback-chain.js";
import { enforceGatewayRateLimits, releaseGatewayConcurrency } from "./rate-limits.js";
import {
  buildOpenAIChatCompletionRequestMetadata,
  type GatewayRequestMetadata,
} from "./request-metadata.js";
import { selectRouteCandidate } from "./route-engine.js";
import {
  type GatewayUsageCostDetails,
  readGatewayProviderTokenUsage,
  selectGatewayBaselineCandidate,
} from "./usage-recorder.js";
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
  activity?: GatewayRequestActivityRoute;
  body: unknown;
  headers?: Record<string, string>;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
  usageCost?: GatewayUsageCostDetails;
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

type ProviderCredentialRow = PostgresQueryResultRow & {
  base_url: string | null;
  encrypted_key: unknown;
  key_prefix: string;
  provider_api_key_id: string;
  provider_id: string;
};

type ProviderCredentialProviderRow = PostgresQueryResultRow & {
  base_url: string | null;
  provider_id: string;
  provider_key: string;
  provider_type: "api_key" | "local" | "subscription";
};

type ProviderCredentials = {
  baseUrl: string;
  keys: FallbackProviderApiKey[];
};

const maxChatCompletionOutputTokens = 16_384;

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
  const tools = readOptionalObjectArray(body.tools);
  if (tools === null) {
    return invalidChatRequest(requestId);
  }
  const toolChoice = readOptionalOpenAIToolChoice(body.tool_choice);
  if (toolChoice === null) {
    return invalidChatRequest(requestId);
  }

  return {
    ok: true,
    request: omitUndefined({
      maxOutputTokens,
      messages: messages as NormalizedOpenAIChatMessage[],
      stream: typeof body.stream === "boolean" ? body.stream : undefined,
      temperature,
      toolChoice,
      tools,
    }),
  };
}

export async function executeGatewayOpenAIChatCompletion(input: {
  agentApiKeyId: string;
  adapter?: OpenAIProviderAdapter;
  databaseUrl: string;
  masterKeySource?: MasterKeySource;
  requestActivityId?: string;
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

  const concurrencyLease = rateLimit.concurrencyLease;
  let budgetReservation: GatewayBudgetReservation | undefined;
  let activity: GatewayRequestActivityRoute | undefined;
  let selectedActivityCandidate: GatewayRouteCandidateSnapshot | undefined;
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
    const selectedCandidate = attemptCandidates[0];
    if (!selectedCandidate) {
      throw new Error("Selected route candidate was not found in route policy.");
    }
    selectedActivityCandidate = selectedCandidate;
    activity = buildRequestActivityRoute({
      candidate: selectedActivityCandidate,
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

    const chatCompletionCandidates = attemptCandidates.filter(
      (candidate) => !isSubscriptionProviderKey(candidate.providerKey),
    );
    if (chatCompletionCandidates.length === 0) {
      throw new Error("Provider credentials are missing for chat completions route.");
    }
    const candidates = await attachGatewayProviderCredentials({
      candidates: chatCompletionCandidates,
      databaseUrl: input.databaseUrl,
      masterKeySource: input.masterKeySource ?? readGatewayMasterKeySource(),
    });
    const result = await executeFallbackChain({
      adapter: input.adapter,
      candidates,
      databaseUrl: input.databaseUrl,
      recordFailedAttempt: async (attempt) => {
        fallbackAttempts.push(attempt);
      },
      request: normalized.request,
      requestActivityId: input.requestActivityId,
      requestId: input.requestId,
    });
    await recordGatewayProviderApiKeyLastUsed({
      databaseUrl: input.databaseUrl,
      providerApiKeyId: result.selectedCandidate.providerApiKeyId,
    });
    activity = buildRequestActivityRoute({
      candidate: result.selectedCandidate,
      fallbackAttempts: result.failedAttempts,
      routeDecision,
    });
    await finalizeGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
    });

    return {
      activity,
      body: result.result.body,
      requestMetadata,
      statusCode: result.result.statusCode,
      usageCost: {
        actualPrice: result.selectedCandidate.price,
        baselinePrice: baselineCandidate.price,
        baselineProviderModelId: baselineCandidate.providerModelId,
        estimatedInputTokens: requestMetadata.estimatedInputTokens,
        estimatedOutputTokens: requestMetadata.estimatedOutputTokens,
        providerUsage: readGatewayProviderTokenUsage(result.result.body),
        providerModelId: result.selectedCandidate.providerModelId,
      },
    };
  } catch (error) {
    await releaseGatewayBudgetReservation({
      databaseUrl: input.databaseUrl,
      reservation: budgetReservation,
    });
    const message = error instanceof Error ? error.message : "Provider request failed.";
    const code = classifyChatCompletionError(message);
    return {
      activity,
      body: createGatewayChatCompletionErrorBody(code, input.requestId),
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
    const primaryKey = credential.keys[0];
    if (!primaryKey) {
      throw new Error(`Provider credentials are missing for provider ${candidate.providerId}.`);
    }

    return {
      ...candidate,
      apiKey: primaryKey.apiKey,
      baseUrl: credential.baseUrl,
      providerApiKeyId: primaryKey.providerApiKeyId,
      providerApiKeyPrefix: primaryKey.keyPrefix,
      providerApiKeys: credential.keys,
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
  return Math.min(value, maxChatCompletionOutputTokens);
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

function readOptionalOpenAIToolChoice(
  value: unknown,
): string | Record<string, unknown> | null | undefined {
  if (value === undefined || value === false) {
    return undefined;
  }
  if (typeof value === "string") {
    const mode = value.trim();
    return mode === "auto" || mode === "none" || mode === "required" ? mode : null;
  }
  if (isRecord(value)) {
    return value;
  }
  return null;
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
}): Promise<Map<string, ProviderCredentials>> {
  if (input.providerIds.length === 0) {
    return new Map();
  }

  const encryption = createSecretEncryption(input.masterKeySource);
  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();

  try {
    const providerResult = await client.query<ProviderCredentialProviderRow>(
      `
        select id::text as provider_id,
               provider_type,
               provider_key,
               base_url
        from providers
        where id = any($1::uuid[])
          and enabled = true
          and deleted_at is null
      `,
      [input.providerIds],
    );
    const credentials = new Map<string, ProviderCredentials>();
    for (const row of providerResult.rows) {
      if (!row.base_url?.trim()) {
        throw new Error(`Provider base URL is missing for provider ${row.provider_id}.`);
      }
      credentials.set(row.provider_id, {
        baseUrl: row.base_url,
        keys: row.provider_type === "local" ? [{ apiKey: "" }] : [],
      });
    }

    const result = await client.query<ProviderCredentialRow>(
      `
        select providers.id::text as provider_id,
               providers.base_url,
               provider_api_keys.id::text as provider_api_key_id,
               provider_api_keys.key_prefix,
               provider_api_keys.encrypted_key
        from providers
        join provider_api_keys on provider_api_keys.provider_id = providers.id
        where providers.id = any($1::uuid[])
          and providers.enabled = true
          and providers.deleted_at is null
          and providers.provider_type = 'api_key'
          and provider_api_keys.enabled = true
        order by providers.default_priority asc,
                 providers.id,
                 provider_api_keys.priority asc,
                 provider_api_keys.created_at asc,
                 provider_api_keys.id asc
      `,
      [input.providerIds],
    );
    for (const row of result.rows) {
      if (!row.base_url?.trim()) {
        throw new Error(`Provider base URL is missing for provider ${row.provider_id}.`);
      }

      const existing = credentials.get(row.provider_id);
      const providerCredentials = existing ?? { baseUrl: row.base_url, keys: [] };
      providerCredentials.keys.push({
        apiKey: encryption.decrypt(readEncryptedSecret(row.encrypted_key)),
        credentialKind: "api_key",
        keyPrefix: row.key_prefix,
        providerApiKeyId: row.provider_api_key_id,
      });
      credentials.set(row.provider_id, providerCredentials);
    }

    for (const provider of providerResult.rows) {
      if (provider.provider_type !== "subscription") {
        continue;
      }
      const providerCredentials = credentials.get(provider.provider_id);
      if (!providerCredentials || !isSubscriptionProviderKey(provider.provider_key)) {
        continue;
      }
      const connections = await readEnabledCompletedProviderOAuthConnections({
        databaseUrl: input.databaseUrl,
        providerId: provider.provider_id,
      });
      for (const connection of connections) {
        let token = readProviderOAuthTokenBlob(
          encryption.decrypt(readEncryptedSecret(connection.encryptedToken)),
        );
        if (isProviderOAuthTokenExpired(token)) {
          if (!token.refreshToken) {
            continue;
          }
          token = await refreshProviderOAuthToken({
            providerKey: provider.provider_key,
            refreshToken: token.refreshToken,
          });
          await completeProviderOAuthConnection({
            databaseUrl: input.databaseUrl,
            encryptedToken: encryption.encrypt(JSON.stringify(token)),
            providerOAuthId: connection.id,
            tokenExpiresAt: token.expiresAt === null ? null : new Date(token.expiresAt),
          });
        }
        providerCredentials.keys.push({
          apiKey: token.accessToken,
          credentialKind: "oauth",
          providerOAuthId: connection.id,
        });
      }
    }

    return credentials;
  } finally {
    await client.end();
  }
}

export async function recordGatewayProviderApiKeyLastUsed(input: {
  databaseUrl: string;
  providerApiKeyId?: string;
}): Promise<void> {
  if (!input.providerApiKeyId) {
    return;
  }

  const client = new PostgresClient({ connectionString: input.databaseUrl });
  await client.connect();
  try {
    await client.query(
      `
        update provider_api_keys
        set last_used_at = now(),
            updated_at = now()
        where id = $1
      `,
      [input.providerApiKeyId],
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

  throw new Error("Stored provider credential is not a valid encrypted secret.");
}

function readProviderOAuthTokenBlob(value: string): ProviderOAuthTokenBlob {
  try {
    const parsed = JSON.parse(value);
    if (isRecord(parsed) && typeof parsed.accessToken === "string" && parsed.accessToken.trim()) {
      return {
        accessToken: parsed.accessToken,
        expiresAt:
          typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt)
            ? parsed.expiresAt
            : null,
        refreshToken:
          typeof parsed.refreshToken === "string" && parsed.refreshToken.trim()
            ? parsed.refreshToken
            : null,
        scopes: Array.isArray(parsed.scopes)
          ? parsed.scopes.filter((scope): scope is string => typeof scope === "string")
          : [],
        tokenType:
          typeof parsed.tokenType === "string" && parsed.tokenType.trim()
            ? parsed.tokenType
            : "Bearer",
      };
    }
  } catch {
    // handled by final throw
  }
  throw new Error("Stored provider OAuth token was not recognized.");
}

function isProviderOAuthTokenExpired(token: ProviderOAuthTokenBlob): boolean {
  return token.expiresAt !== null && token.expiresAt <= Date.now() + 60_000;
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
