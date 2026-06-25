import { PageHeader } from "../../_components/page-header";
import { type ConsoleSearchParams, LimitsSection } from "../../_modules/sections";

export default async function LimitsPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page">
      <PageHeader
        eyebrow="Access"
        title="Limits"
        description="Budgets, token caps, RPM / TPM, and concurrency per Agent."
      />
      <LimitsSection searchParams={resolved} />
    </div>
  );
}
