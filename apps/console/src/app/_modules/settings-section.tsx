import { getConsoleSecuritySummary } from "@llmingress/db/console-auth";
import {
  type ConsoleNotificationChannel,
  listNotificationChannels,
} from "@llmingress/db/console-notification-channels";

function formatNotificationChannelConfig(channel: ConsoleNotificationChannel): string {
  const config = channel.config as { url?: string };
  return `Webhook: ${formatWebhookUrlForDisplay(config.url)}`;
}

function formatWebhookUrlForDisplay(rawUrl: string | undefined): string {
  if (!rawUrl) {
    return "Unknown webhook URL";
  }

  try {
    const url = new URL(rawUrl);
    if (url.search) {
      url.search = "?redacted";
    }
    url.password = "";
    url.username = "";
    return url.toString();
  } catch {
    return "Invalid webhook URL";
  }
}
export async function SettingsSection() {
  const securitySummary = await getConsoleSecuritySummary();
  const notificationChannels = await listNotificationChannels();
  return (
    <section className="providers-panel" id="settings" aria-label="Settings">
      <div className="settings-layout">
        <div className="settings-sections">
          <section
            className="settings-panel"
            id="settings-general"
            aria-labelledby="settings-general-title"
          >
            <h3 id="settings-general-title">General</h3>
            <div className="settings-grid">
              <div className="console-field">
                <label htmlFor="settings-language">Default language</label>
                <select id="settings-language" defaultValue="en" disabled>
                  <option value="en">English</option>
                  <option value="zh">Chinese</option>
                </select>
              </div>
              <div className="console-field">
                <label htmlFor="settings-range">Default time range</label>
                <select id="settings-range" defaultValue="7d" disabled>
                  <option value="24h">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                </select>
              </div>
              <div className="console-field">
                <label htmlFor="settings-currency">Default currency</label>
                <select id="settings-currency" defaultValue="usd" disabled>
                  <option value="usd">USD</option>
                </select>
              </div>
            </div>
            <p className="callout">Console preferences are display-only in this build.</p>
          </section>

          <section
            className="settings-panel"
            id="settings-security"
            aria-labelledby="settings-security-title"
          >
            <h3 id="settings-security-title">Security</h3>
            <dl className="detail-field-list">
              <div className="detail-field">
                <dt>Admin password</dt>
                <dd>{securitySummary.adminPasswordSet ? "Set" : "Not set"}</dd>
              </div>
              <div className="detail-field">
                <dt>Active sessions</dt>
                <dd>{securitySummary.activeSessionCount}</dd>
              </div>
            </dl>
            <p className="callout">
              Password change and session management are managed via deployment configuration.
            </p>
          </section>

          <section
            className="settings-panel"
            id="notification-channels"
            aria-labelledby="notification-channels-title"
          >
            <h3 id="notification-channels-title">Notification channels</h3>
            <div className="provider-list">
              {notificationChannels.length === 0 ? (
                <p>No notification channels configured.</p>
              ) : (
                notificationChannels.map((channel) => (
                  <article className="provider-item" key={channel.id}>
                    <header className="provider-header">
                      <div>
                        <p className="eyebrow">{channel.channelType}</p>
                        <h3>{channel.displayName}</h3>
                      </div>
                      <p className={channel.enabled ? "status-enabled" : "status-disabled"}>
                        {channel.enabled ? "Enabled" : "Disabled"}
                      </p>
                    </header>
                    <p>{formatNotificationChannelConfig(channel)}</p>
                  </article>
                ))
              )}
            </div>
            <div className="settings-grid">
              <form
                className="provider-create-form"
                action="/api/notification-channels"
                method="post"
              >
                <input type="hidden" name="action" value="create" />
                <input type="hidden" name="channelType" value="webhook" />
                <label htmlFor="notification-webhook-name">Webhook channel name</label>
                <input
                  id="notification-webhook-name"
                  name="displayName"
                  placeholder="Ops alerts"
                  required
                />
                <label htmlFor="notification-webhook-url">Webhook URL</label>
                <input
                  id="notification-webhook-url"
                  name="webhookUrl"
                  type="url"
                  placeholder="https://hooks.example.com/llmingress"
                  required
                />
                <button className="notification-channel-save-button" type="submit">
                  <span>Save</span>
                </button>
              </form>
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}
