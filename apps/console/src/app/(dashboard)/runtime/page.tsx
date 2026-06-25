import { PageHeader } from "../../_components/page-header";
import { RuntimeSection } from "../../_modules/sections";

export default function GatewayRuntimePage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Infrastructure"
        title="Gateway Runtime"
        description="Read-only Gateway status, provider connectivity, and recent runtime errors."
      />
      <RuntimeSection />
    </div>
  );
}
