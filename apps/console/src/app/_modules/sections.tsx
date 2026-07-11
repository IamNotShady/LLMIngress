import type { ConsoleActivity } from "@llmingress/db/console-activity";
import type { ConsoleAgentLimit } from "@llmingress/db/console-agent-limits";
import type { ConsoleProviderHealthSummary } from "@llmingress/db/console-provider-health";
import type {
  ConsoleProviderModelOption,
  listRoutePolicies,
} from "@llmingress/db/console-route-policies";

export type ConsoleSearchParams = Record<string, string | string[] | undefined>;

// Valence per metric: callers say which direction is good (cost down is good,
// requests up is good). Zero change is neutral, never tinted.
export function formatDeltaTone(
  current: number,
  previous: number,
  direction: "up-good" | "down-good",
): "good" | "bad" | "neutral" {
  if (current === previous) {
    return "neutral";
  }
  return current > previous === (direction === "up-good") ? "good" : "bad";
}

// Alert thresholds for failure rates: 5% warns, 20% is dangerous.
export function failureRateTone(
  failureCount: number,
  requestCount: number,
): "danger" | "warn" | undefined {
  if (requestCount <= 0) {
    return undefined;
  }
  const rate = failureCount / requestCount;
  if (rate >= 0.2) {
    return "danger";
  }
  if (rate >= 0.05) {
    return "warn";
  }
  return undefined;
}

export function toneToNumClass(tone: "danger" | "warn" | undefined): string | undefined {
  return tone ? `num-${tone}` : undefined;
}

export function formatActivityVirtualModelLabel(activity: ConsoleActivity): string {
  if (activity.virtualModelDisplayName && activity.virtualModelName) {
    return activity.virtualModelName;
  }
  return activity.virtualModelName ?? activity.model ?? "Unknown virtual model";
}

export function ActivityStatusPill({ status }: { status: string }) {
  const normalized = status.toLowerCase();
  if (normalized === "success" || normalized === "succeeded" || normalized === "ok") {
    return <span className="pill--ok pill">Success</span>;
  }
  if (normalized === "error" || normalized === "failed" || normalized === "failure") {
    return <span className="pill--danger pill">Failed</span>;
  }
  return <span className="pill">{status}</span>;
}

export function formatDateTime(value: Date): string {
  return value.toISOString();
}

export function readSingleSearchParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export function formatActivityProviderLabel(activity: ConsoleActivity): string {
  return activity.providerDisplayName ?? activity.providerKey ?? "Unknown provider";
}

export function formatRouteEndpointProtocolLabel(protocol: string): string {
  if (protocol === "chat_completions") {
    return "Chat Completions";
  }
  if (protocol === "responses") {
    return "Responses";
  }
  if (protocol === "messages") {
    return "Messages";
  }
  if (protocol === "embeddings") {
    return "Embeddings";
  }
  return "Unspecified";
}

export function buildRoutePolicyHealthWarningCandidates(
  routePolicy: Awaited<ReturnType<typeof listRoutePolicies>>[number],
  providerHealthByProviderId: Map<string, ConsoleProviderHealthSummary>,
) {
  return routePolicy.candidates.map((candidate) => {
    const providerHealth = providerHealthByProviderId.get(candidate.providerId);
    const modelHealth = providerHealth?.models.find((model) => model.id === candidate.id);
    return {
      modelHealthStatus: modelHealth?.status ?? null,
      optionLabel: candidate.optionLabel,
      providerHealthStatus: providerHealth?.status ?? null,
    };
  });
}

export function orderProviderModelsForConsole(
  providerModels: ConsoleProviderModelOption[],
): ConsoleProviderModelOption[] {
  return [...providerModels].sort((left, right) => {
    const leftOrder = getConsoleProviderOrder(left.providerKey);
    const rightOrder = getConsoleProviderOrder(right.providerKey);
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder;
    }
    return left.modelDisplayName.localeCompare(right.modelDisplayName);
  });
}

export function getConsoleProviderOrder(providerKey: string): number {
  const preferredOrder = new Map([
    ["openai", 0],
    ["anthropic", 1],
    ["google", 2],
    ["openrouter", 3],
    ["ollama", 4],
  ]);
  return preferredOrder.get(providerKey) ?? 100;
}

export function findAgentLimit(
  limits: readonly ConsoleAgentLimit[],
  limitType: ConsoleAgentLimit["limitType"],
): ConsoleAgentLimit | undefined {
  return limits.find((limit) => limit.limitType === limitType);
}

export function groupByAgentId<T extends { agentId: string }>(values: T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const group = grouped.get(value.agentId) ?? [];
    group.push(value);
    grouped.set(value.agentId, group);
  }
  return grouped;
}
