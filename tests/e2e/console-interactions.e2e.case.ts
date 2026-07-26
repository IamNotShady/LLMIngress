import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
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

async function seedAuditData(databaseUrl: string) {
  const apiKeyId = randomUUID();
  const otherApiKeyId = randomUUID();
  const virtualModelId = randomUUID();
  const activityId = randomUUID();
  const otherActivityId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into api_keys (id, name, key_prefix, key_hash, enabled)
       values
         ($1, 'audit-old-apiKey', 'llmi_audit_old', 'test-hash', true),
         ($2, 'audit-other-apiKey', 'llmi_audit_other', 'test-hash-other', true)`,
      [apiKeyId, otherApiKeyId],
    );
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'audit-probe-vm', 'Audit probe', true)`,
      [virtualModelId],
    );
    await client.query(
      `insert into request_activity (
         id, request_id, api_key_id, virtual_model_id, api_key_prefix,
         protocol, model, stream, status, http_status, latency_ms,
         route_reason,
         started_at, completed_at,
         api_key_name_snapshot, virtual_model_name_snapshot
       )
       values (
         $1, 'gw_audit_old_request', $2, $3, 'llmi_audit_old',
         'chat_completions', 'audit-model', false, 'succeeded', 200, 1200,
         '{"strategy":"cost_first"}'::jsonb,
         now() - interval '3 days', now() - interval '3 days',
         'audit-old-apiKey', 'audit-probe-vm'
       )`,
      [activityId, apiKeyId, virtualModelId],
    );
    await client.query(
      `insert into request_activity (
         id, request_id, api_key_id, virtual_model_id, api_key_prefix,
         protocol, model, stream, status, http_status, latency_ms,
         started_at, completed_at,
         api_key_name_snapshot, virtual_model_name_snapshot
       )
       values (
         $1, 'gw_audit_other_request', $2, $3, 'llmi_audit_other',
         'chat_completions', 'audit-model', false, 'succeeded', 200, 800,
         now() - interval '3 days', now() - interval '3 days',
         'audit-other-apiKey', 'audit-probe-vm'
       )`,
      [otherActivityId, otherApiKeyId, virtualModelId],
    );
    await client.query(
      `insert into request_activity (
         id, request_id, api_key_id, virtual_model_id, api_key_prefix,
         protocol, model, stream, status, http_status, latency_ms,
         started_at, completed_at,
         api_key_name_snapshot, virtual_model_name_snapshot
       )
       select
         gen_random_uuid(),
         'gw_audit_page_' || page_number,
         $1,
         $2,
         'llmi_audit_other',
         'chat_completions',
         'audit-model',
         false,
         'succeeded',
         200,
         800,
         now() - interval '4 days' - page_number * interval '1 minute',
         now() - interval '4 days' - page_number * interval '1 minute',
         'audit-other-apiKey',
         'audit-probe-vm'
       from generate_series(1, 19) as page_number`,
      [otherApiKeyId, virtualModelId],
    );
    await client.query(
      `insert into request_usage (
         id, request_activity_id, api_key_id, virtual_model_id,
         input_tokens, output_tokens, total_tokens, token_source
       )
       values ($1, $2, $3, $4, 12000, 345, 12345, 'provider')`,
      [randomUUID(), activityId, apiKeyId, virtualModelId],
    );
    await client.query(
      `insert into request_costs (
         id, request_activity_id, api_key_id, total_cost_usd, cost_source
       )
       values ($1, $2, $3, '0.42', 'provider')`,
      [randomUUID(), activityId, apiKeyId],
    );
  });

  return { apiKeyId };
}

async function seedProviderApiKeyInteractionData(databaseUrl: string) {
  const providerId = randomUUID();
  const lifecycleKeyId = randomUUID();
  const failureKeyId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (
         id, provider_type, provider_key, display_name, base_url, enabled
       )
       values ($1, 'api_key', 'openai', 'Console Key Actions', 'https://provider.test/v1', true)`,
      [providerId],
    );
    await client.query(
      `insert into provider_api_keys (
         id, provider_id, key_prefix, encrypted_key, key_id, label, priority, enabled
       )
       values
         ($1, $2, 'life-key', '{}'::jsonb, 'test-key', 'Lifecycle key', 100, true),
         ($3, $2, 'fail-key', '{}'::jsonb, 'test-key', 'Failure key', 90, true)`,
      [lifecycleKeyId, providerId, failureKeyId],
    );
  });

  return { failureKeyId, lifecycleKeyId, providerId };
}

// The timestamp is the one cell that must never be cut: a clipped clock reads
// as a different time. Long free-text cells beside it clip instead.
async function expectActivityTimeCellContained(page: Page) {
  const row = page.getByRole("link", { name: /gw_audit_old_request/ }).first();
  const metrics = await row.evaluate((element) => {
    const [timeCell, requestCell] = Array.from(element.children) as HTMLElement[];
    return {
      requestCellOverflow: getComputedStyle(requestCell).overflow,
      timeCellClientWidth: timeCell.clientWidth,
      timeCellScrollWidth: timeCell.scrollWidth,
    };
  });
  expect(metrics.requestCellOverflow).toBe("hidden");
  expect(metrics.timeCellScrollWidth).toBeLessThanOrEqual(metrics.timeCellClientWidth);
}

test("console audit fixes keep time windows honest and prevent activity timestamp overlap", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_audit_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedAuditData(fixture.databaseUrl);

    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      const consoleErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });

      try {
        await page.addInitScript(() => {
          const applyCaretMutation = () => {
            const input = document.querySelector<HTMLInputElement>('input[name="vmQuery"]');
            if (input) {
              input.style.caretColor = "transparent";
            }
          };

          new MutationObserver(applyCaretMutation).observe(document, {
            childList: true,
            subtree: true,
          });
          applyCaretMutation();
        });

        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);

        // --- A window means what it says: a request older than 24h is absent
        // from the 24h board and present once the window is widened.
        await page.goto(baseUrl, { waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { name: "No traffic yet" })).toBeVisible();
        await expect(page.getByText("$0.42")).toHaveCount(0);

        await page.goto(`${baseUrl}/usage?window=7d`, { waitUntil: "networkidle" });
        await expect(page.getByText("$0.42").first()).toBeVisible();
        await expect(page.getByText("buckets are daily")).toBeVisible();

        await page.goto(`${baseUrl}/activity?window=7d`, { waitUntil: "networkidle" });
        await expect(page.getByRole("link", { name: /gw_audit_old_request/ })).toBeVisible();
        await expectActivityTimeCellContained(page);
        await page.goto(`${baseUrl}/activity`, { waitUntil: "networkidle" });
        await expect(page.getByRole("link", { name: /gw_audit_old_request/ })).toHaveCount(0);
        await expect(page.getByText("No requests match these filters")).toBeVisible();

        // --- A filter that matches nothing is not the same as nothing being
        // configured, and says so.
        await page.goto(`${baseUrl}/models?strategy=cost_first`, { waitUntil: "networkidle" });
        await expect(page.getByText("No virtual model uses this strategy.")).toBeVisible();
        await expect(page.getByRole("heading", { name: "No virtual models yet" })).toHaveCount(0);
        expect(consoleErrors.filter((error) => error.includes("hydration"))).toEqual([]);

        // --- New API key: a key with no grant cannot be created, and the
        // default follows the grants rather than outliving them. (Creating one
        // end to end is covered by the api-key suites.)
        await page.goto(`${baseUrl}/api-keys?dialog=new`, { waitUntil: "networkidle" });
        const dialog = page.getByRole("dialog", { name: "New API Key" });
        await expect(dialog.getByRole("button", { name: "Create key" })).toBeDisabled();

        await dialog.getByRole("link", { name: "Grant audit-probe-vm" }).click();
        await page.waitForURL((url) => url.searchParams.get("grantIds") !== null);
        await expect(page.getByRole("button", { name: "Create key" })).toBeEnabled();

        await page.getByRole("link", { name: "☆ set default" }).click();
        await page.waitForURL((url) => Boolean(url.searchParams.get("defaultGrant")));
        await expect(page.getByRole("link", { name: "★ default" })).toBeVisible();

        // Revoking the grant that was the default drops the default with it.
        await page.getByRole("link", { name: "Revoke audit-probe-vm" }).click();
        await page.waitForURL((url) => url.searchParams.get("defaultGrant") === "");
        await expect(page.getByRole("link", { name: "★ default" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Create key" })).toBeDisabled();
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

test("a connection state change and its deletion are driven from the connection dialog, which reports refusals in place", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_key_actions_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedProviderApiKeyInteractionData(fixture.databaseUrl);
    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext({ viewport: { height: 800, width: 1280 } });
      const page = await context.newPage();
      const browserErrors: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "warning" && isUnusedNextFontPreloadWarning(message.text())) {
          return;
        }
        if (message.type() === "error" || message.type() === "warning") {
          browserErrors.push(message.text());
        }
      });
      page.on("pageerror", (error) => browserErrors.push(error.message));

      try {
        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);
        await page.goto(`${baseUrl}/providers?selected=${seeded.providerId}`, {
          waitUntil: "networkidle",
        });

        // A connection's state lives with the connection, in the dialog that
        // holds its credential — the row itself only reports.
        await page.goto(
          `${baseUrl}/providers?selected=${seeded.providerId}` +
            `&providerKeyDialog=${seeded.providerId}&connection=${seeded.lifecycleKeyId}`,
          { waitUntil: "networkidle" },
        );
        const dialog = page.getByRole("dialog", { name: "Edit connection" });
        // State is part of what a connection is, so it is a field of the form
        // that holds the credential — saved with everything else, in one post.
        await dialog.getByLabel("STATE").selectOption("false");
        await dialog.getByRole("button", { name: "Save connection" }).click();

        await expect
          .poll(async () => {
            const result = await fixture.query<{ enabled: boolean }>(
              "select enabled from provider_api_keys where id = $1",
              [seeded.lifecycleKeyId],
            );
            return result.rows[0]?.enabled;
          })
          .toBe(false);
        // (Scoped to the dialog: `next dev` injects its own alert region.)
        await expect(dialog.getByRole("alert")).toHaveCount(0);

        // Saving without pasting a key keeps the stored one — a rename must not
        // cost a rotation.
        const storedBefore = await fixture.query<{ key_prefix: string }>(
          "select key_prefix from provider_api_keys where id = $1",
          [seeded.lifecycleKeyId],
        );
        await page.goto(
          `${baseUrl}/providers?selected=${seeded.providerId}` +
            `&providerKeyDialog=${seeded.providerId}&connection=${seeded.lifecycleKeyId}`,
          { waitUntil: "networkidle" },
        );
        await dialog.getByLabel(/LABEL/).fill("renamed-key");
        await dialog.getByLabel("STATE").selectOption("true");
        await dialog.getByRole("button", { name: "Save connection" }).click();

        await expect
          .poll(async () => {
            const result = await fixture.query<{ enabled: boolean; label: string | null }>(
              "select enabled, label from provider_api_keys where id = $1",
              [seeded.lifecycleKeyId],
            );
            return result.rows[0];
          })
          .toEqual({ enabled: true, label: "renamed-key" });
        const storedAfter = await fixture.query<{ key_prefix: string }>(
          "select key_prefix from provider_api_keys where id = $1",
          [seeded.lifecycleKeyId],
        );
        expect(storedAfter.rows[0]?.key_prefix).toBe(storedBefore.rows[0]?.key_prefix);

        // Deleting says what is lost, then closes back onto the provider.
        await page.goto(
          `${baseUrl}/providers?selected=${seeded.providerId}` +
            `&dialog=deleteConnection&connection=${seeded.lifecycleKeyId}`,
          { waitUntil: "networkidle" },
        );
        const deleteDialog = page.getByRole("dialog", { name: "Delete connection" });
        await expect(deleteDialog).toContainText("cannot be recovered");
        await deleteDialog.getByRole("button", { name: "Delete connection" }).click();
        await expect(deleteDialog).toBeHidden();
        await expect
          .poll(async () => {
            const result = await fixture.query<{ deleted: boolean }>(
              "select deleted_at is not null as deleted from provider_api_keys where id = $1",
              [seeded.lifecycleKeyId],
            );
            return result.rows[0]?.deleted;
          })
          .toBe(true);

        // A connection that disappears from under the operator is stated, not
        // ignored: the click has somewhere to land and says nothing changed.
        await page.goto(
          `${baseUrl}/providers?selected=${seeded.providerId}` +
            `&providerKeyDialog=${seeded.providerId}&connection=${seeded.failureKeyId}`,
          { waitUntil: "networkidle" },
        );
        const failureDialog = page.getByRole("dialog", { name: "Edit connection" });
        await fixture.query("delete from provider_api_keys where id = $1", [seeded.failureKeyId]);
        await failureDialog.getByRole("button", { name: "Save connection" }).click();

        // The connection is gone from under the operator: the refusal is stated
        // where they were working, not in a toast and not by silence.
        const refusal = failureDialog.getByRole("alert");
        await expect(refusal).toBeVisible();
        await expect(refusal).toContainText(/not found|could not be saved/i);
        await expect(page.getByRole("status")).toHaveCount(0);

        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await expect
            .poll(() =>
              page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
              ),
            )
            .toBeLessThanOrEqual(0);
        }

        expect(
          browserErrors.filter(
            (message) => !message.startsWith("Failed to load resource: the server responded with"),
          ),
        ).toEqual([]);
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

function isUnusedNextFontPreloadWarning(message: string): boolean {
  return (
    message.includes("/_next/static/media/") &&
    message.includes(".woff2") &&
    message.includes("was preloaded using link preload but not used within a few seconds")
  );
}
