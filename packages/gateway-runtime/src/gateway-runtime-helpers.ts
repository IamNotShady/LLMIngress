import type { RouteDecision, RouteEndpointProtocol } from "@llmingress/domain";
import type { GatewayRequestActivityRoute } from "./gateway-activity-recorder.ts";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./gateway-config-reload.ts";
import { GatewayPipelineError } from "./gateway-errors.ts";
import type { FallbackFailedAttempt } from "./gateway-fallback-chain.ts";

export type GatewayActivityRouteCandidate = GatewayRouteCandidateSnapshot & {
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
};

export function requireGatewayRoutePolicyForVirtualModel(
  snapshot: GatewayConfigSnapshot,
  virtualModelId: string,
): GatewayRoutePolicySnapshot {
  const routePolicy = snapshot.routePolicies.find(
    (candidate) => candidate.virtualModelId === virtualModelId,
  );
  if (!routePolicy) {
    throw new GatewayPipelineError(
      "route_not_found",
      `Route policy for Virtual Model ${virtualModelId} was not found.`,
    );
  }
  return routePolicy;
}

export function assertGatewayRoutePolicyEndpointProtocol(input: {
  protocol: RouteEndpointProtocol;
  routePolicy: GatewayRoutePolicySnapshot;
}): void {
  const expectedProtocol = input.routePolicy.endpointProtocol;
  if (expectedProtocol === input.protocol) {
    return;
  }

  throw new GatewayPipelineError(
    "provider_protocol_unsupported",
    `Virtual Model ${input.routePolicy.virtualModelName} is configured for ${expectedProtocol}, not ${input.protocol}.`,
  );
}

export function buildGatewayRequestActivityRoute(input: {
  candidate: GatewayActivityRouteCandidate;
  fallbackAttempts: FallbackFailedAttempt[];
  providerCallDurationMs?: number;
  routeDecision: RouteDecision;
}): GatewayRequestActivityRoute {
  return {
    fallbackAttempts: input.fallbackAttempts,
    modelId: input.candidate.modelId,
    providerApiKeyId: input.candidate.providerApiKeyId,
    providerApiKeyPrefix: input.candidate.providerApiKeyPrefix,
    providerCallDurationMs: input.providerCallDurationMs,
    providerId: input.candidate.providerId,
    providerKey: input.candidate.providerKey,
    providerModelId: input.candidate.providerModelId,
    routePolicyId: input.routeDecision.routePolicyId,
    routeReason: input.routeDecision.routeReason,
  };
}
