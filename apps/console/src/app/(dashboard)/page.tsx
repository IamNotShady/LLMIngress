import { PageHeader } from "../_components/page-header";
import { OverviewSection } from "../_modules/sections";

export default function OverviewPage() {
  return (
    <div className="page overview-page">
      <PageHeader
        title="Overview"
        description="Gateway status and last 24h key metrics at a glance."
      />
      <OverviewSection />
    </div>
  );
}
