import { PageHeader } from "../_components/page-header";
import { RuntimeSection } from "../_modules/sections";

export default function OverviewPage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Monitor"
        title="Overview"
        description="Gateway runtime health, migration status, and recent errors."
      />
      <RuntimeSection />
    </div>
  );
}
