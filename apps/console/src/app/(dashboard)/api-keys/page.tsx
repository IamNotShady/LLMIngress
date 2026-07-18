import { PageHeader } from "../../_components/page-header";
import { ApiKeysSection } from "../../_modules/api-keys-section";
import type { ConsoleSearchParams } from "../../_modules/sections";

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page api-keys-page">
      <PageHeader
        title="API Keys"
        description="API keys, their Virtual Model access, and limits."
        actions={
          <a className="btn" href="?apiKeyDialog=new" id="api-key-create-dialog-trigger">
            <span>Create API Key</span>
          </a>
        }
      />
      <ApiKeysSection searchParams={resolved} />
    </div>
  );
}
