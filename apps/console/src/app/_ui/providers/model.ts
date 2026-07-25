import { resolveProviderRegistryEntry } from "@llmingress/config/provider-registry";
import type { ConsoleProviderHealthSummary } from "@llmingress/db/console-provider-health";
import type { ProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import type { ConsoleProvider } from "@llmingress/db/console-providers";
import type { ProviderOAuthMetadata } from "@llmingress/db/providers";

/**
 * One row of the Connections table. A provider's health belongs to each key or
 * token separately, so this is the unit that gets probed, disabled and deleted —
 * never the provider as a whole.
 */
export type ProviderConnection = {
  credential: string;
  enabled: boolean;
  health: ConsoleProviderHealthSummary | null;
  id: string;
  kind: "api_key" | "local" | "oauth";
  label: string;
  lastUsedAt: Date | null;
  priority: number;
  tokenExpiresAt: Date | null;
};

export function buildProviderConnections(input: {
  apiKeys: ProviderApiKeyMetadata[];
  health: ConsoleProviderHealthSummary[];
  oauth: ProviderOAuthMetadata[];
  provider: ConsoleProvider;
}): ProviderConnection[] {
  const healthById = new Map(input.health.map((entry) => [entry.id, entry]));

  const keyRows: ProviderConnection[] = input.apiKeys
    .filter((key) => key.providerId === input.provider.id)
    .map((key) => ({
      credential: key.keyPrefix,
      enabled: key.enabled,
      health: healthById.get(key.id) ?? null,
      id: key.id,
      kind: "api_key" as const,
      label: key.label ?? key.keyPrefix,
      lastUsedAt: key.lastUsedAt,
      priority: key.priority,
      tokenExpiresAt: null,
    }));

  const oauthRows: ProviderConnection[] = input.oauth
    .filter((connection) => connection.providerId === input.provider.id)
    .map((connection) => ({
      credential: connection.completedAt ? "oauth token" : "authorization pending",
      enabled: connection.enabled,
      health: healthById.get(connection.id) ?? null,
      id: connection.id,
      kind: "oauth" as const,
      label: connection.label ?? "oauth",
      lastUsedAt: null,
      priority: connection.priority,
      tokenExpiresAt: connection.tokenExpiresAt,
    }));

  const localRows: ProviderConnection[] =
    input.provider.providerType === "local"
      ? [
          {
            credential: input.provider.baseUrl ?? "local endpoint",
            enabled: input.provider.enabled,
            // A local provider is probed under its own id — there is no credential row.
            health: healthById.get(input.provider.id) ?? null,
            id: input.provider.id,
            kind: "local" as const,
            label: "local",
            lastUsedAt: null,
            priority: 100,
            tokenExpiresAt: null,
          },
        ]
      : [];

  return [...keyRows, ...oauthRows, ...localRows].sort(
    (a, b) => a.priority - b.priority || a.label.localeCompare(b.label),
  );
}

export type ConnectionHealthView = {
  text: string;
  tone: "amber" | "dim" | "green" | "red";
};

/**
 * provider_health_summary only stores rows that are not healthy, so "no row"
 * means healthy — a disabled connection is neither healthy nor failing.
 */
export function describeConnectionHealth(connection: ProviderConnection): ConnectionHealthView {
  if (!connection.enabled) {
    return { text: "not probed · disabled", tone: "dim" };
  }
  const health = connection.health;
  if (!health || health.status === "healthy") {
    return { text: "healthy", tone: "green" };
  }
  if (health.status === "checking") {
    return { text: "checking", tone: "amber" };
  }
  if (health.status === "disabled") {
    return { text: "not probed · disabled", tone: "dim" };
  }
  const reason = health.reasonCode ?? "probe_failed";
  return { text: `${reason} · ${health.consecutiveFailures} fails`, tone: "red" };
}

/** The provider dot rolls its connections up: any failure wins, else healthy. */
export function describeProviderHealth(connections: ProviderConnection[]): ConnectionHealthView {
  if (connections.length === 0) {
    return { text: "no connections", tone: "dim" };
  }
  const views = connections.map(describeConnectionHealth);
  const failing = views.filter((view) => view.tone === "red");
  if (failing.length > 0) {
    return { text: `${failing.length} of ${views.length} unhealthy`, tone: "red" };
  }
  if (views.some((view) => view.tone === "amber")) {
    return { text: "checking", tone: "amber" };
  }
  if (views.every((view) => view.tone === "dim")) {
    return { text: "disabled", tone: "dim" };
  }
  return { text: "healthy", tone: "green" };
}

/** Endpoint protocols and quota capability come from the provider registry. */
export function describeProviderCapabilities(providerKey: string): {
  endpoints: Array<{ path: string; protocol: string }>;
  quotaNote: string;
} {
  const entry = resolveProviderRegistryEntry(providerKey);
  if (!entry) {
    return { endpoints: [], quotaNote: "quota probe: unknown template" };
  }
  const endpoints = Object.entries(entry.endpoints ?? {}).map(([protocol, endpoint]) => ({
    path: `${endpoint.method} ${endpoint.path}`,
    protocol,
  }));
  const quota = entry.behavior?.quotaSource;
  const quotaNote = quota?.supported
    ? "quota probe: supported"
    : quota?.reason === "requires_separate_credential"
      ? "quota probe: needs a separate credential"
      : "quota probe: not supported";
  return { endpoints, quotaNote };
}

/** Subscription plans are not metered — their requests carry no cost at all. */
export function providerIsMetered(provider: ConsoleProvider): boolean {
  return provider.providerType === "api_key";
}
