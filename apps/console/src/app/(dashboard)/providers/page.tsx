import { PageHeader } from "../../_components/page-header";
import { type ConsoleSearchParams, ProvidersSection } from "../../_modules/sections";

export default async function ProvidersPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page">
      <PageHeader
        eyebrow="Infrastructure"
        title="Providers"
        description="Upstream providers, API keys, discovered models, and health."
      />
      <ProvidersSection searchParams={resolved} />
    </div>
  );
}
