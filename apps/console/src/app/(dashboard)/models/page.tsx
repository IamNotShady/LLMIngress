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
        title="Virtual Models / Routes"
        description="Expose simple routing policies under a Virtual Model name: strategy + candidates."
        actions={
          <a className="btn" href="/models?virtualModelDialog=new">
            <span>Create Virtual Model</span>
          </a>
        }
      />
      <VirtualModelsSection searchParams={resolved} />
    </div>
  );
}
