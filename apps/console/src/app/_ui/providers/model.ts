import { resolveProviderRegistryEntry } from "@llmingress/config/provider-registry";
import type { ConsoleProviderHealthSummary } from "@llmingress/db/console-provider-health";
import type { ProviderApiKeyMetadata } from "@llmingress/db/console-provider-keys";
import type { ConsoleProvider } from "@llmingress/db/console-providers";
import type { ProviderOAuthMetadata } from "@llmingress/db/providers";
import { endpointPathByProtocol } from "../api-keys/integration-guide";
import { aggregateProviderConnectionHealthStatus } from "../provider-health";
import { formatRelativeDateTime } from "../provider-relative-time";

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
/**
 * When the console last heard from the provider, and when it will ask again.
 * "healthy" on its own does not say whether it is a fresh answer or one from
 * this morning, which is the difference between trusting it and re-checking.
 */
export function describeProbeSchedule(
  connection: ProviderConnection,
  now: Date = new Date(),
): string | null {
  const health = connection.health;
  if (!health) {
    return null;
  }
  const parts: string[] = [];
  if (health.latestProbeAt) {
    parts.push(formatRelativeDateTime(health.latestProbeAt, now.getTime()));
  }
  if (health.nextProbeAt && health.nextProbeAt.getTime() > now.getTime()) {
    const seconds = Math.round((health.nextProbeAt.getTime() - now.getTime()) / 1000);
    parts.push(seconds < 90 ? `next ${seconds}s` : `next ${Math.round(seconds / 60)}m`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

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

/**
 * The provider dot rolls its connections up. One healthy connection is enough
 * for the provider to keep serving, so a provider with a working fallback is
 * healthy rather than red — the failing connection is still named beside it so
 * the problem is not hidden.
 */
export function describeProviderHealth(connections: ProviderConnection[]): ConnectionHealthView {
  if (connections.length === 0) {
    return { text: "no connections", tone: "dim" };
  }
  const status = aggregateProviderConnectionHealthStatus(
    connections.map((connection) => ({
      enabled: connection.enabled,
      providerId: "provider",
      status: describeConnectionHealth(connection).tone === "green" ? "healthy" : "unhealthy",
    })),
  );
  const failing = connections.filter(
    (connection) => describeConnectionHealth(connection).tone === "red",
  ).length;

  if (status === "unknown") {
    return { text: "disabled", tone: "dim" };
  }
  if (status === "unhealthy") {
    return { text: failing === 1 ? "unhealthy" : `${failing} unhealthy`, tone: "red" };
  }
  if (status === "checking") {
    return { text: "checking", tone: "amber" };
  }
  return {
    text: failing > 0 ? `healthy · ${failing} failing` : "healthy",
    tone: failing > 0 ? "amber" : "green",
  };
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
  // The chip states the route a client calls on the gateway, not the provider's
  // own relative path — that is what a virtual model has to match.
  const endpoints = Object.keys(entry.endpoints ?? {}).map((protocol) => ({
    path: `POST ${
      endpointPathByProtocol[protocol as keyof typeof endpointPathByProtocol] ?? `/v1/${protocol}`
    }`,
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

/**
 * Everything the Add Provider dialog can create. Most providers are templates,
 * but OpenAI and Anthropic are registered as direct entries with a fixed base
 * url — they belong in the same picker, or they cannot be added at all.
 */
export type AddProviderChoice = {
  baseUrl: string;
  displayName: string;
  id: string;
  mode: "direct" | "template";
  providerKey: string;
  providerType: string;
};

export type AddProviderGroup = {
  id: string;
  label: string;
  items: AddProviderChoice[];
};

export function listAddProviderGroups(
  templateGroups: ReadonlyArray<{
    id: string;
    label: string;
    templates: ReadonlyArray<{
      displayName: string;
      fixedBaseUrl?: string;
      id: string;
      providerKey: string;
      providerType: string;
    }>;
  }>,
  directEntries: ReadonlyArray<{
    creation: { fixedBaseUrl?: string } | Record<string, unknown>;
    displayName: string;
    providerKey: string;
    providerType: string;
  }>,
): AddProviderGroup[] {
  return templateGroups.map((group) => ({
    id: group.id,
    items: [
      ...group.templates.map((template) => ({
        baseUrl: template.fixedBaseUrl ?? "",
        displayName: template.displayName,
        id: template.id,
        mode: "template" as const,
        providerKey: template.providerKey,
        providerType: template.providerType,
      })),
      ...(group.id === "remote_api_key"
        ? directEntries.map((entry) => ({
            baseUrl:
              typeof (entry.creation as { fixedBaseUrl?: string }).fixedBaseUrl === "string"
                ? ((entry.creation as { fixedBaseUrl?: string }).fixedBaseUrl ?? "")
                : "",
            displayName: entry.displayName,
            id: entry.providerKey,
            mode: "direct" as const,
            providerKey: entry.providerKey,
            providerType: entry.providerType,
          }))
        : []),
    ].sort((a, b) => a.displayName.localeCompare(b.displayName)),
    label: group.label,
  }));
}
