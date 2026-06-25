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
        description="管理 Agent API Key 的预算、Token、RPM、TPM 与并发限制"
      />
      <LimitsSection searchParams={resolved} />
    </div>
  );
}
