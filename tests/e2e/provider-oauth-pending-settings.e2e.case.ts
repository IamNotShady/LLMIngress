import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  createTestPostgresFixture,
  runMigrations,
  withDedicatedPostgresClient,
} from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

/**
 * Starting an authorization stores the label and priority the operator typed on
 * the pending connection, and redirects to a screen that names that connection
 * by providerOAuthId. The settings form on that screen is submitted again when
 * the provider confirms, so it has to hold what is stored — a form that renders
 * its defaults instead writes them over the operator's answers.
 */
type Seeded = { oauthId: string; providerId: string };

async function seedPendingAuthorization(databaseUrl: string): Promise<Seeded> {
  const providerId = randomUUID();
  const oauthId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, enabled)
       values ($1, 'subscription', 'claude_code', 'Pending Authorization', true)`,
      [providerId],
    );
    await client.query(
      `insert into provider_oauth (
         id, provider_id, label, priority, enabled, pending_state, pending_expires_at, quota_probe_enabled
       )
       values ($1, $2, 'team-token', 10, true, $3, now() + interval '10 minutes', true)`,
      [oauthId, providerId, `pending-${randomUUID()}`],
    );
  });

  return { oauthId, providerId };
}

test("the screen waiting on an authorization holds the connection's own settings, and completing keeps them", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_oauth_pending_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedPendingAuthorization(fixture.databaseUrl);
    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();

      try {
        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);

        // The URL a device-code start redirects to.
        const expiresAt = new Date(Date.now() + 600_000).toISOString();
        await page.goto(
          `${baseUrl}/providers?selected=${seeded.providerId}` +
            `&providerKeyDialog=${seeded.providerId}&providerOAuthId=${seeded.oauthId}` +
            `&providerOAuthUserCode=WDJB-MJHT` +
            `&providerOAuthLabelValue=team-token&providerOAuthPriorityValue=10` +
            `&providerOAuthVerificationUri=${encodeURIComponent("https://example.test/device")}` +
            `&providerOAuthInterval=5&providerOAuthExpiresAt=${encodeURIComponent(expiresAt)}`,
        );

        const dialog = page.locator("dialog[open]");
        await expect(dialog.locator('input[name="label"]')).toHaveValue("team-token");
        await expect(dialog.locator('input[name="priority"]')).toHaveValue("10");

        // What the poller submits once the provider confirms.
        await page.evaluate(() => {
          const form = document.getElementById(
            "provider-oauth-device-settings",
          ) as HTMLFormElement | null;
          form?.requestSubmit();
        });
        await page.waitForTimeout(2_500);

        const stored = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client
            .query<{ label: string | null; priority: number; probe: boolean }>(
              "select label, priority, quota_probe_enabled as probe from provider_oauth where id = $1",
              [seeded.oauthId],
            )
            .then((result) => result.rows[0]),
        );
        expect(stored?.label).toBe("team-token");
        expect(stored?.priority).toBe(10);
        expect(stored?.probe).toBe(true);
      } finally {
        await context.close();
      }
    } finally {
      await stopConsoleProcess(consoleApp);
    }
  } finally {
    await fixture.dispose();
  }
});
