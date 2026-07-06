import { type RouteEndpointProtocol, selectRouteAttempts } from "@llmingress/domain";
import type { MasterKeySource } from "@llmingress/security/master-key";
import type { GatewayRequestActivityRoute } from "./gateway-activity-recorder.ts";
import {
  enforceGatewayAgentLimits,
  type GatewayBudgetSettlement,
  type GatewayConcurrencyLease,
  releaseGatewayConcurrency,
} from "./gateway-agent-limits.ts";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
} from "./gateway-config-reload.ts";
import { mapGatewayErrorStatus } from "./gateway-error-mapping.ts";
import {
  createGatewayErrorBody,
  type GatewayErrorBody,
  type GatewayPipelineError,
  toGatewayErrorResponseParts,
} from "./gateway-errors.ts";
import {
  buildFallbackExhaustionError,
  executeProviderFallbackAttempts,
  type FallbackAttemptErrorLike,
  type FallbackChainCandidate,
  type FallbackFailedAttempt,
  type FallbackProviderApiKey,
  type ProviderFallbackAttemptResult,
  type ProviderFallbackAttemptSuccess,
} from "./gateway-fallback-chain.ts";
import {
  attachGatewayProviderCredentialsLeniently,
  readGatewayMasterKeySource,
  recordGatewayProviderApiKeyLastUsed,
} from "./gateway-provider-credentials.ts";
import type { GatewayRequestMetadata } from "./gateway-request-metadata.ts";
import {
  assertGatewayRoutePolicyEndpointProtocol,
  buildGatewayRequestActivityRoute,
  requireGatewayRoutePolicy,
  selectGatewayBaselineCandidate,
} from "./gateway-runtime-helpers.ts";
import { recordGatewayProviderTrace } from "./gateway-tracing.ts";
import { readGatewayProviderTokenUsage } from "./gateway-usage-collector.ts";
import type { GatewayUsageCostDetails } from "./gateway-usage-recorder.ts";
import type { GatewayVirtualModel } from "./gateway-virtual-model-access.ts";

export type GatewayProtocolNormalizeResult<TNormalized> =
  | {
      ok: true;
      request: TNormalized;
    }
  | {
      body: GatewayErrorBody;
      ok: false;
      statusCode: number;
    };

export type GatewayProtocolResponse = {
  activity?: GatewayRequestActivityRoute;
  body: unknown;
  budgetSettlement?: GatewayBudgetSettlement;
  headers?: Record<string, string>;
  requestMetadata?: GatewayRequestMetadata;
  statusCode: number;
  usageCost?: GatewayUsageCostDetails;
};

export type GatewayProtocolSpec<TNormalized, TSuccess extends ProviderFallbackAttemptSuccess> = {
  buildRequestMetadata: (input: {
    model: string;
    rawBody: unknown;
    request: TNormalized;
  }) => GatewayRequestMetadata;
  callProvider: (input: {
    candidate: FallbackChainCandidate;
    providerApiKey: FallbackProviderApiKey;
    providerRequestHeaders: Record<string, string>;
    request: TNormalized;
  }) => Promise<ProviderFallbackAttemptResult<TSuccess>>;
  normalize: (body: unknown, requestId: string) => GatewayProtocolNormalizeResult<TNormalized>;
  planCandidates: (candidates: readonly GatewayRouteCandidateSnapshot[]) => {
    noneSupportedError: () => GatewayPipelineError;
    supported: GatewayRouteCandidateSnapshot[];
  };
};

export async function executeGatewayProtocolRequest<
  TNormalized,
  TSuccess extends ProviderFallbackAttemptSuccess,
>(input: {
  agentId: string;
  databaseUrl?: string;
  masterKeySource?: MasterKeySource;
  requestBody: unknown;
  requestId: string;
  protocol: RouteEndpointProtocol;
  providerRequestHeaders?: Record<string, string>;
  snapshot: GatewayConfigSnapshot;
  spec: GatewayProtocolSpec<TNormalized, TSuccess>;
  virtualModel: GatewayVirtualModel;
}): Promise<GatewayProtocolResponse> {
  const normalized = input.spec.normalize(input.requestBody, input.requestId);
  if (!normalized.ok) {
    return {
      body: normalized.body,
      statusCode: normalized.statusCode,
    };
  }

  const requestMetadata = input.spec.buildRequestMetadata({
    model: input.virtualModel.name,
    rawBody: input.requestBody,
    request: normalized.request,
  });

  let concurrencyLease: GatewayConcurrencyLease | undefined;
  let budgetSettlement: GatewayBudgetSettlement | undefined;
  let activity: GatewayRequestActivityRoute | undefined;
  const fallbackAttempts: FallbackFailedAttempt[] = [];
  let lastError: FallbackAttemptErrorLike | undefined;
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
    assertGatewayRoutePolicyEndpointProtocol({
      protocol: input.protocol,
      routePolicy,
    });
    const baselineCandidate = selectGatewayBaselineCandidate(routePolicy);
    const selectedCandidate = routeResult.chain[0];
    if (!selectedCandidate) {
      throw new Error("Selected route candidate was not found in route policy.");
    }
    activity = buildGatewayRequestActivityRoute({
      candidate: selectedCandidate,
      fallbackAttempts,
      routeDecision,
    });

    const plannedCandidates = input.spec.planCandidates(routeResult.chain);
    if (plannedCandidates.supported.length === 0) {
      throw plannedCandidates.noneSupportedError();
    }

    const candidates = await attachGatewayProviderCredentialsLeniently({
      candidates: plannedCandidates.supported,
      databaseUrl: input.databaseUrl,
      masterKeySource: input.masterKeySource ?? readGatewayMasterKeySource(),
    });

    const limits = await enforceGatewayAgentLimits({
      agentId: input.agentId,
      budgetPrice: candidates[0]?.price,
      databaseUrl: input.databaseUrl,
      requestId: input.requestId,
      requestMetadata,
    });
    if (!limits.ok) {
      return {
        activity,
        body: limits.body,
        ...(limits.retryAfterSeconds
          ? { headers: { "retry-after": String(limits.retryAfterSeconds) } }
          : {}),
        requestMetadata,
        statusCode: limits.statusCode,
      };
    }
    concurrencyLease = limits.concurrencyLease;
    budgetSettlement = limits.budgetSettlement;

    const success = await executeProviderFallbackAttempts<TSuccess>({
      callProvider: async ({ candidate, providerApiKey }) => {
        const providerStartedAt = new Date();
        const result = await input.spec.callProvider({
          candidate,
          providerApiKey,
          providerRequestHeaders: input.providerRequestHeaders ?? {},
          request: normalized.request,
        });
        recordGatewayProviderTrace({
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
      candidates,
      databaseUrl: input.databaseUrl,
      fallbackAttempts,
      requestId: input.requestId,
    });
    if (!success) {
      const providerError = buildProviderErrorPassthrough(lastError);
      if (providerError) {
        return {
          activity,
          body: providerError.body,
          headers: providerError.headers,
          requestMetadata,
          statusCode: providerError.statusCode,
        };
      }
      throw buildFallbackExhaustionError(lastError);
    }

    recordGatewayProviderApiKeyLastUsed({
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
      budgetSettlement,
      headers: success.result.headers,
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
    }).catch(() => undefined);
  }
}

function buildProviderErrorPassthrough(error: FallbackAttemptErrorLike | undefined): {
  body: unknown;
  headers?: Record<string, string>;
  statusCode: number;
} | null {
  const statusCode = error?.statusCode;
  if (statusCode === undefined || statusCode === null) {
    return null;
  }
  if (statusCode < 400 || statusCode >= 500) {
    return null;
  }
  if (!error || !("body" in error)) {
    return null;
  }
  return {
    body: error.body ?? null,
    headers: error.headers,
    statusCode,
  };
}
