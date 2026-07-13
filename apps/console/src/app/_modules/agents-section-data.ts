import { listSavedAgentLimits } from "@llmingress/db/console-agent-limits";
import { listAgents, listAgentVirtualModelAccess } from "@llmingress/db/console-agents";
import { getConsoleUsageSummary } from "@llmingress/db/console-usage";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";

export async function loadAgentsSectionData() {
  const [usageToday, agents, agentVirtualModelAccess, agentLimits, virtualModels] =
    await Promise.all([
      getConsoleUsageSummary({ window: "24h" }),
      listAgents(),
      listAgentVirtualModelAccess(),
      listSavedAgentLimits(),
      listVirtualModels(),
    ]);

  return { agentLimits, agentVirtualModelAccess, agents, usageToday, virtualModels };
}

export type AgentsSectionData = Awaited<ReturnType<typeof loadAgentsSectionData>>;
