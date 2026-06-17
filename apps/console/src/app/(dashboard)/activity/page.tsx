import { PageHeader } from "../../_components/page-header";
import { ActivitySection, type ConsoleSearchParams } from "../../_modules/sections";

export default async function ActivityPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page">
      <PageHeader
        eyebrow="Monitor"
        title="Activity"
        description="Recent gateway requests with provider, model, cost, and routing detail."
      />
      <ActivitySection searchParams={resolved} />
    </div>
  );
}
