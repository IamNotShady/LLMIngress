import { PageHeader } from "../../_components/page-header";
import { AgentsSection, type ConsoleSearchParams } from "../../_modules/sections";

export default async function AgentsPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page agents-page">
      <PageHeader
        title="Agents"
        description="Agents, their API keys, virtual model access, and per-key limits."
        actions={
          <a className="btn" href="#new-agent">
            + Create Agent
          </a>
        }
      />
      <AgentsSection searchParams={resolved} />
    </div>
  );
}
