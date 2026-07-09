import { listAgentLimits } from "@llmingress/db/console-agent-limits";
import { listAgents, listAgentVirtualModelAccess } from "@llmingress/db/console-agents";
import { getConsoleUsageSummary } from "@llmingress/db/console-usage";
import { listVirtualModels } from "@llmingress/db/console-virtual-models";

export async function loadAgentsSectionData() {
  const usageToday = await getConsoleUsageSummary({ window: "24h" });
  const agents = await listAgents();
  const agentVirtualModelAccess = await listAgentVirtualModelAccess();
  const agentLimits = await listAgentLimits();
  const virtualModels = await listVirtualModels();

  return { agentLimits, agentVirtualModelAccess, agents, usageToday, virtualModels };
}

export type AgentsSectionData = Awaited<ReturnType<typeof loadAgentsSectionData>>;
