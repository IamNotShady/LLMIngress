import { PageHeader } from "../../_components/page-header";
import { type ConsoleSearchParams, RoutePoliciesSection } from "../../_modules/sections";

export default async function RoutingPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page">
      <PageHeader
        eyebrow="Routing"
        title="Route Policies"
        description="Map virtual models to primary and fallback provider models."
      />
      <RoutePoliciesSection searchParams={resolved} />
    </div>
  );
}
