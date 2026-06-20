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
        description="以 Virtual Model Name 暴露简单路由策略：strategy + candidates"
        actions={
          <a className="btn" href="/models?virtualModelDialog=new">
            + 创建 Virtual Model
          </a>
        }
      />
      <VirtualModelsSection searchParams={resolved} />
    </div>
  );
}
