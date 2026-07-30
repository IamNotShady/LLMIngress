import type { ConsoleProviderHealthSummary } from "@llmingress/db/console-provider-health";

type ProviderConnectionHealth = Pick<
  ConsoleProviderHealthSummary,
  "enabled" | "providerId" | "status"
>;

export type ProviderAggregateHealthStatus = "checking" | "healthy" | "unhealthy" | "unknown";

export function aggregateProviderConnectionHealthStatus(
  health: readonly ProviderConnectionHealth[],
): ProviderAggregateHealthStatus {
  let hasEnabledConnection = false;
  let hasCheckingConnection = false;

  for (const connection of health) {
    if (!connection.enabled) {
      continue;
    }
    hasEnabledConnection = true;
    if (connection.status === "healthy") {
      return "healthy";
    }
    if (connection.status === "checking") {
      hasCheckingConnection = true;
    }
  }

  if (!hasEnabledConnection) {
    return "unknown";
  }
  return hasCheckingConnection ? "checking" : "unhealthy";
}

export function countProviderAggregateHealthStatuses(
  summaries: readonly ProviderConnectionHealth[],
): { healthy: number; unhealthy: number } {
  const healthByProviderId = new Map<string, ProviderConnectionHealth[]>();
  for (const summary of summaries) {
    const providerHealth = healthByProviderId.get(summary.providerId) ?? [];
    providerHealth.push(summary);
    healthByProviderId.set(summary.providerId, providerHealth);
  }

  let healthy = 0;
  let unhealthy = 0;
  for (const providerHealth of healthByProviderId.values()) {
    const status = aggregateProviderConnectionHealthStatus(providerHealth);
    if (status === "healthy") {
      healthy += 1;
    } else if (status === "unhealthy") {
      unhealthy += 1;
    }
  }
  return { healthy, unhealthy };
}
