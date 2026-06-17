import { PageHeader } from "../../_components/page-header";
import { type ConsoleSearchParams, VirtualModelsSection } from "../../_modules/sections";

export default async function VirtualModelsPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page">
      <PageHeader
        eyebrow="Routing"
        title="Virtual Models"
        description="Public model names agents request, mapped to provider models by route policies."
      />
      <VirtualModelsSection searchParams={resolved} />
    </div>
  );
}
