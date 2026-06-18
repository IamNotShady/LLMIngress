import { PageHeader } from "../../_components/page-header";
import { ModelsSection, PricingSection } from "../../_modules/sections";

export default function ModelsPage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Infrastructure"
        title="Models"
        description="Provider model directory with input / output prices and price source."
      />
      <ModelsSection />
      <PricingSection />
    </div>
  );
}
