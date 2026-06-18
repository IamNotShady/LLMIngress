import { PageHeader } from "../../_components/page-header";
import { type ConsoleSearchParams, SettingsSection } from "../../_modules/sections";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<ConsoleSearchParams>;
}) {
  const resolved = searchParams ? await searchParams : {};
  return (
    <div className="page">
      <PageHeader
        eyebrow="System"
        title="Settings"
        description="Notification channels and redacted config import/export."
      />
      <SettingsSection searchParams={resolved} />
    </div>
  );
}
