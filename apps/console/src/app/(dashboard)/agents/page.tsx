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
        description="Agents, their API key, virtual model access, and limits."
        actions={
          <a className="btn" href="?agentDialog=new">
            <span>Create Agent</span>
          </a>
        }
      />
      <AgentsSection searchParams={resolved} />
    </div>
  );
}
