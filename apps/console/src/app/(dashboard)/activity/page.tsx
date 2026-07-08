import { PageHeader } from "../../_components/page-header";
import { ActivitySection } from "../../_modules/activity-section";
import type { ConsoleSearchParams } from "../../_modules/sections";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page activity-page">
      <PageHeader
        title="Activity"
        description="Inspect request metadata, routing results, costs, latency, and fallback flow."
      />
      <ActivitySection searchParams={resolved} />
    </div>
  );
}
