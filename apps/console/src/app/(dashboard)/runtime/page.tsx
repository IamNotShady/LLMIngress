import { PageHeader } from "../../_components/page-header";
import { RuntimeSection } from "../../_modules/runtime-section";

export default function GatewayRuntimePage() {
  return (
    <div className="page runtime-page">
      <PageHeader
        title="Gateway Runtime"
        description="Read-only Gateway process status, config reload state, and migration health."
      />
      <RuntimeSection />
    </div>
  );
}
