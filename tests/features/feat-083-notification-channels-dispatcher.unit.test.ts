import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type NotificationChannelFormInput,
  normalizeNotificationChannelFormInput,
} from "../../apps/console/src/server/notification-channels";
import {
  buildNotificationDeliveryPayload,
  createNotificationDispatchJobHandler,
} from "../../apps/worker/src/notification-dispatcher";
import { loadSqlMigrations } from "../../packages/db/src/index";

const root = resolve(__dirname, "../..");

describe("feat-083 notification channels and dispatcher", () => {
  it("declares notification channels events deliveries and notification dispatch jobs", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0018" && candidate.name === "notification_channels",
    );

    expect(migration?.sql).toContain("create table if not exists notification_channels");
    expect(migration?.sql).toContain("create table if not exists notification_events");
    expect(migration?.sql).toContain("create table if not exists notification_deliveries");
    expect(migration?.sql).toContain("'notification_dispatch'");
    expect(migration?.sql).toContain("channel_type text not null check");
    expect(migration?.sql).toContain("'email'");
    expect(migration?.sql).toContain("'webhook'");
  });

  it("registers notification_dispatch in the default Worker job handlers", () => {
    const workerMain = readFileSync(resolve(root, "apps/worker/src/main.ts"), "utf8");

    expect(workerMain).toContain("createNotificationDispatchJobHandler");
    expect(workerMain).toContain("notification_dispatch:");
  });

  it("normalizes email and webhook channel configuration", () => {
    expect(
      normalizeNotificationChannelFormInput({
        channelType: "email",
        displayName: "  Ops Email  ",
        emailFrom: "alerts@llmingress.local",
        emailTo: " owner@example.com ",
      }),
    ).toEqual({
      channelType: "email",
      config: {
        from: "alerts@llmingress.local",
        to: "owner@example.com",
      },
      displayName: "Ops Email",
      enabled: true,
    });

    expect(
      normalizeNotificationChannelFormInput({
        channelType: "webhook",
        displayName: "Ops Webhook",
        webhookUrl: "http://127.0.0.1:9000/alerts",
      }),
    ).toEqual({
      channelType: "webhook",
      config: {
        url: "http://127.0.0.1:9000/alerts",
      },
      displayName: "Ops Webhook",
      enabled: true,
    });

    const invalidInputs: NotificationChannelFormInput[] = [
      { channelType: "email", displayName: "Missing email to", emailFrom: "from@example.com" },
      { channelType: "webhook", displayName: "Bad webhook", webhookUrl: "notaurl" },
      { channelType: "sms", displayName: "Unsupported" },
    ];

    for (const input of invalidInputs) {
      expect(() => normalizeNotificationChannelFormInput(input)).toThrow();
    }
  });

  it("builds a common delivery payload for email and webhook dispatchers", () => {
    const payload = buildNotificationDeliveryPayload({
      body: "Budget is at 90%.",
      eventId: "event-083",
      eventType: "budget_threshold",
      payload: {
        agentId: "agent-083",
        threshold: 0.9,
      },
      subject: "Budget warning",
    });

    expect(payload).toEqual({
      body: "Budget is at 90%.",
      eventId: "event-083",
      eventType: "budget_threshold",
      payload: {
        agentId: "agent-083",
        threshold: 0.9,
      },
      subject: "Budget warning",
    });
  });

  it("exposes a notification dispatch job handler factory", () => {
    expect(
      createNotificationDispatchJobHandler({
        databaseUrl: "postgresql://example.invalid/llmingress",
      }),
    ).toEqual(expect.any(Function));
  });
});
