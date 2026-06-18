import { PageHeader } from "../../_components/page-header";
import { type ConsoleSearchParams, ModelsSection } from "../../_modules/sections";

export default async function ModelsPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page">
      <PageHeader
        eyebrow="Infrastructure"
        title="Models"
        description="Provider model directory with input / output prices and per-model price override."
      />
      <ModelsSection searchParams={resolved} />
    </div>
  );
}
