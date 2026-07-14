import { PageHeader } from "../../_components/page-header";
import type { ConsoleSearchParams } from "../../_modules/sections";
import { VirtualModelsSection } from "../../_modules/virtual-models-section";

export default async function VirtualModelsPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page models-page">
      <PageHeader
        title="Virtual Models"
        description="Combine compatible Provider Models under one routed model name with credential and candidate fallback."
        actions={
          <a
            className="btn"
            href="/models?virtualModelDialog=new"
            id="virtual-model-create-dialog-trigger"
          >
            <span>Create Virtual Model</span>
          </a>
        }
      />
      <VirtualModelsSection searchParams={resolved} />
    </div>
  );
}
