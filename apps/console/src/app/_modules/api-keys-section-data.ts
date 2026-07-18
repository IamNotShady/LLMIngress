import { listSavedApiKeyLimits } from "@llmingress/db/console-api-key-limits";
import { listApiKeys, listApiKeyVirtualModelAccess } from "@llmingress/db/console-api-keys";
import { getConsoleUsageSummary } from "@llmingress/db/console-usage";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";

export async function loadApiKeysSectionData() {
  const [usageToday, apiKeys, apiKeyVirtualModelAccess, apiKeyLimits, virtualModels] =
    await Promise.all([
      getConsoleUsageSummary({ window: "24h" }),
      listApiKeys(),
      listApiKeyVirtualModelAccess(),
      listSavedApiKeyLimits(),
      listVirtualModels(),
    ]);

  return { apiKeyLimits, apiKeyVirtualModelAccess, apiKeys, usageToday, virtualModels };
}

export type ApiKeysSectionData = Awaited<ReturnType<typeof loadApiKeysSectionData>>;
