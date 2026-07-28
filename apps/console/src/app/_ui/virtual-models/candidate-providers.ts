import { listProviderRouteEndpointProtocols } from "@llmingress/config/provider-registry";
import type { ConsoleProvider } from "@llmingress/db/console-providers";

export const ROUTE_PROTOCOLS = ["chat_completions", "messages", "responses"] as const;

export type RouteProtocol = (typeof ROUTE_PROTOCOLS)[number];

export function readRouteProtocol(value: string | undefined): RouteProtocol | null {
  return ROUTE_PROTOCOLS.find((entry) => entry === value) ?? null;
}

/**
 * The providers a route on this protocol could actually use. A provider that
 * does not speak the protocol has nothing to offer the route — listing it means
 * a page of models that all say "does not serve this", which is a dead end
 * dressed up as a choice.
 */
export function providersServingProtocol(
  providers: readonly ConsoleProvider[],
  protocol: string,
): ConsoleProvider[] {
  return providers.filter((provider) =>
    listProviderRouteEndpointProtocols(provider.providerKey).some((entry) => entry === protocol),
  );
}

/**
 * Which provider's models the browser is showing. A stored choice survives only
 * while it still serves the protocol — switching the protocol has to move the
 * browser somewhere it can list something.
 */
export function activeCandidateProviderId(
  providers: readonly ConsoleProvider[],
  protocol: string,
  requested: string | undefined,
): string | undefined {
  const serving = providersServingProtocol(providers, protocol);
  const kept = serving.find((provider) => provider.id === requested);
  return (kept ?? serving[0])?.id;
}
