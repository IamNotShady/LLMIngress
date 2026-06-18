import { PageHeader } from "../_components/page-header";
import { OverviewSection } from "../_modules/sections";

export default function OverviewPage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Monitor"
        title="Overview"
        description="Gateway status and today's key metrics at a glance."
      />
      <OverviewSection />
    </div>
  );
}
