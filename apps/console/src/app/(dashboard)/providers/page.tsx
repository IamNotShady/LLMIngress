import { PageHeader } from "../../_components/page-header";
import { type ConsoleSearchParams, ProvidersSection } from "../../_modules/sections";

export default async function ProvidersPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page providers-page">
      <PageHeader
        title="Providers & Models"
        description="配置 Provider Key，刷新模型列表并管理模型价格。"
        actions={
          <a className="btn" href="?providerDialog=new">
            + 添加 Provider
          </a>
        }
      />
      <ProvidersSection searchParams={resolved} />
    </div>
  );
}
