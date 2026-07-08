import { PageHeader } from "../../_components/page-header";
import type { ConsoleSearchParams } from "../../_modules/sections";
import { UsageSection } from "../../_modules/usage-section";

export default async function UsagePage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page usage-page">
      <PageHeader
        title="Usage & Cost"
        description="Analyze tokens, cost, latency, failure rate, and savings by agent, virtual model, provider, and model."
      />
      <UsageSection searchParams={resolved} />
    </div>
  );
}
