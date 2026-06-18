import { PageHeader } from "../../_components/page-header";
import { AgentsSection, type ConsoleSearchParams } from "../../_modules/sections";

export default async function AgentsPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page">
      <PageHeader
        eyebrow="Access"
        title="Agents"
        description="Agents, their API keys, virtual model access, and per-key limits."
      />
      <AgentsSection searchParams={resolved} />
    </div>
  );
}
