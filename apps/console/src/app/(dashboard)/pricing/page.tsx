import { PageHeader } from "../../_components/page-header";
import { PricingSection } from "../../_modules/sections";

export default function PricingPage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Infrastructure"
        title="Pricing"
        description="Model price overrides and sample cost estimates."
      />
      <PricingSection />
    </div>
  );
}
