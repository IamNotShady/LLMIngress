import { PageHeader } from "../../_components/page-header";
import { SettingsSection } from "../../_modules/sections";

export default function SettingsPage() {
  return (
    <div className="page">
      <PageHeader
        eyebrow="System"
        title="Settings"
        description="Console preferences, security reminders, and notification channels."
      />
      <SettingsSection />
    </div>
  );
}
