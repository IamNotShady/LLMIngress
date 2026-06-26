import { PageHeader } from "../../_components/page-header";
import { RuntimeSection } from "../../_modules/sections";

export default function GatewayRuntimePage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="Infrastructure"
        title="Gateway Runtime"
        description="Read-only Gateway process status, config reload state, and migration health."
      />
      <RuntimeSection />
    </div>
  );
}
