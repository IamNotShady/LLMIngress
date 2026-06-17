import { PageHeader } from "../../_components/page-header";
import { type ConsoleSearchParams, UsageSection } from "../../_modules/sections";

export default async function UsagePage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page">
      <PageHeader
        eyebrow="Monitor"
        title="Usage & Cost"
        description="Spend, tokens, savings, and breakdowns across the selected window."
      />
      <UsageSection searchParams={resolved} />
    </div>
  );
}
