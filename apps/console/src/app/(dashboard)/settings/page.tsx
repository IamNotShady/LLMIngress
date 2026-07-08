import { PageHeader } from "../../_components/page-header";
import { SettingsSection } from "../../_modules/settings-section";

export default function SettingsPage() {
  return (
    <div className="page settings-page">
      <PageHeader
        title="Settings"
        description="Console preferences, security reminders, and notification channels."
      />
      <SettingsSection />
    </div>
  );
}
