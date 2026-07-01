import type { RouteDecision } from "@llmingress/domain";
import type { GatewayRequestActivityRoute } from "./gateway-activity-recorder.ts";
import type {
  GatewayConfigSnapshot,
  GatewayRouteCandidateSnapshot,
  GatewayRoutePolicySnapshot,
} from "./gateway-config-reload.ts";
import type { FallbackFailedAttempt } from "./gateway-fallback-chain.ts";

export type GatewayActivityRouteCandidate = GatewayRouteCandidateSnapshot & {
  providerApiKeyId?: string;
  providerApiKeyPrefix?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function omitUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
  ) as T;
}

export function requireGatewayRoutePolicy(
  snapshot: GatewayConfigSnapshot,
  routePolicyId: string,
): GatewayRoutePolicySnapshot {
  const routePolicy = snapshot.routePolicies.find((candidate) => candidate.id === routePolicyId);
  if (!routePolicy) {
    throw new Error(`Route policy ${routePolicyId} was not found.`);
  }
  return routePolicy;
}

export function buildGatewayRequestActivityRoute(input: {
  candidate: GatewayActivityRouteCandidate;
  fallbackAttempts: FallbackFailedAttempt[];
  routeDecision: RouteDecision;
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
