import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeNotificationChannelFormInput } from "../../packages/db/src/console-notification-channels.ts";

const channelSqlFiles = [
  "packages/worker-runtime/src/worker-notification-dispatcher.ts",
  "packages/db/src/console-notification-channels.ts",
  "packages/worker-runtime/src/worker-alert-utils.ts",
];

describe("refactor-notification-transport-registry", () => {
  it("hardcodes no channel_type = 'webhook' SQL literal", () => {
    for (const file of channelSqlFiles) {
      expect(readFileSync(file, "utf8")).not.toContain("channel_type = 'webhook'");
    }
  });

  it("owns the channel-type list in packages/domain", () => {
    const domain = readFileSync("packages/domain/src/index.ts", "utf8");
    expect(domain).toContain("export const notificationChannelTypes");
    const dispatcher = readFileSync(
      "packages/worker-runtime/src/worker-notification-dispatcher.ts",
      "utf8",
    );
    expect(dispatcher).not.toMatch(/export type NotificationChannelType = "/);
    const console = readFileSync("packages/db/src/console-notification-channels.ts", "utf8");
    expect(console).not.toMatch(/export type NotificationChannelType = "/);
  });

  it("delivers through a channel-type transport registry", () => {
    const dispatcher = readFileSync(
      "packages/worker-runtime/src/worker-notification-dispatcher.ts",
      "utf8",
    );
    expect(dispatcher).toContain("input.transports[input.event.channelType]");
  });

  it("keeps webhook channel normalization behavior", () => {
    const normalized = normalizeNotificationChannelFormInput({
      channelType: "webhook",
      displayName: "ops hook",
      enabled: true,
      webhookUrl: "https://example.com/hook",
    });
    expect(normalized.channelType).toBe("webhook");
    expect(normalized.config).toEqual({ url: "https://example.com/hook" });
    expect(() =>
      normalizeNotificationChannelFormInput({
        channelType: "carrier-pigeon",
        displayName: "nope",
        enabled: true,
        webhookUrl: "https://example.com/hook",
      }),
    ).toThrow(/webhook/);
  });
});
