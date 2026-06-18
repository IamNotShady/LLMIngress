import { PageHeader } from "../../_components/page-header";
import { PricingSection } from "../../_modules/sections";

export default function PricingPage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Infrastructure"
        title="Models"
        description="Provider model directory with input / output prices and price source."
      />
      <PricingSection />
    </div>
  );
}
