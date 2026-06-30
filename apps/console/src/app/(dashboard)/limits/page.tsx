import { PageHeader } from "../../_components/page-header";
import { type ConsoleSearchParams, LimitsSection } from "../../_modules/sections";

export default async function LimitsPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page limits-page">
      <PageHeader
        title="Limits"
        description="Manage Agent API Key budgets, tokens, RPM, TPM, and concurrency limits."
      />
      <LimitsSection searchParams={resolved} />
    </div>
  );
}
