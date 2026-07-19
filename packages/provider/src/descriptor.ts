import {
  listPriceSyncSupportedProviderKeys as listRegistryPriceSyncProviderKeys,
  type ProviderBehavior,
  resolveProviderRegistryEntry,
} from "@llmingress/config/provider-registry";

export type {
  ProviderConnectivityProbeStyle,
  ProviderModelListStyle,
  ProviderSubscriptionAdapter,
} from "@llmingress/config/provider-registry";

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
