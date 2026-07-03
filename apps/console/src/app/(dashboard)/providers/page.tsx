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
        description="Configure provider keys, refresh model lists, and manage model pricing."
        actions={
          <a className="btn" href="?providerDialog=new">
            <span>Add Provider</span>
          </a>
        }
      />
      <ProvidersSection searchParams={resolved} />
    </div>
  );
}
