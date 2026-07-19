import {
  listPriceSyncSupportedProviderKeys as listRegistryPriceSyncProviderKeys,
  type ProviderBehavior,
  resolveProviderRegistryEntry,
} from "@llmingress/config";

export type {
  ProviderConnectivityProbeStyle,
  ProviderModelListStyle,
  ProviderSubscriptionAdapter,
} from "@llmingress/config";

/** Runtime behavior facts for a provider. Sourced from the provider registry. */
export type ProviderDescriptor = ProviderBehavior;

export function resolveProviderDescriptor(
  providerKey: string | null | undefined,
): ProviderDescriptor {
  return resolveProviderRegistryEntry(providerKey)?.behavior ?? {};
}

export function listPriceSyncSupportedProviderKeys(): string[] {
  return listRegistryPriceSyncProviderKeys();
}
