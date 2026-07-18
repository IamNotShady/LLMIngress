import { PageHeader } from "../../_components/page-header";
import { LimitsSection } from "../../_modules/limits-section";
import type { ConsoleSearchParams } from "../../_modules/sections";

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
        description="Manage API key budgets, tokens, RPM, TPM, and concurrency limits."
      />
      <LimitsSection searchParams={resolved} />
    </div>
  );
}
