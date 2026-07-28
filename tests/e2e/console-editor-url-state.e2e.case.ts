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
 * The editors keep their draft in the query string, which is what lets a
 * checkbox be a link and the dialog stay server-rendered. Everything here is a
 * way that carrier can lie: a value that names nothing, a draft that outlives
 * the dialog it belongs to, an empty set that reads as "unset", and a save that
 * is two writes wearing one button.
 */
type Seeded = {
  chatModelId: string;
  messagesOnlyProviderId: string;
  pairedVirtualModelId: string;
  responsesOnlyModelId: string;
  soloVirtualModelId: string;
  subscriptionProviderId: string;
};

async function seed(databaseUrl: string): Promise<Seeded> {
  const messagesOnlyProviderId = randomUUID();
  const subscriptionProviderId = randomUUID();
  const chatModelId = randomUUID();
  const responsesOnlyModelId = randomUUID();
  const pairedVirtualModelId = randomUUID();
  const soloVirtualModelId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    // anthropic serves messages and chat_completions; openai serves chat and
    // responses but not messages — the pair a protocol switch has to refuse.
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'anthropic', 'Editor Provider', 'https://editor.test/v1', true),
              ($2, 'subscription', 'claude_code', 'Editor Subscription', null, true)`,
      [messagesOnlyProviderId, subscriptionProviderId],
    );
    // One connection already exists: the add link has to open the credential
    // form even when the provider's connection list is not empty.
    await client.query(
      `insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, label, enabled)
       values ($1, $2, 'sk-editor', '{"version":1}'::jsonb, 'editor-key', 'first key', true)`,
      [randomUUID(), messagesOnlyProviderId],
    );
    const openAiProviderId = randomUUID();
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'openai', 'Editor OpenAI', 'https://editor-openai.test/v1', true)`,
      [openAiProviderId],
    );
    await client.query(
      `insert into provider_models (
         id, provider_id, model_id, display_name, context_window, supports_streaming, availability
       )
       values ($1, $2, 'editor-chat', 'editor-chat', 200000, true, 'available'),
              ($3, $4, 'editor-responses', 'editor-responses', 200000, true, 'available')`,
      [chatModelId, messagesOnlyProviderId, responsesOnlyModelId, openAiProviderId],
    );

    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'paired-route', 'two candidates', true),
              ($2, 'solo-route', 'one candidate', true)`,
      [pairedVirtualModelId, soloVirtualModelId],
    );
    const pairedPolicyId = randomUUID();
    const soloPolicyId = randomUUID();
    await client.query(
      `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
       values ($1, $2, 'load_balance', 'chat_completions'),
              ($3, $4, 'cost_first', 'chat_completions')`,
      [pairedPolicyId, pairedVirtualModelId, soloPolicyId, soloVirtualModelId],
    );
    await client.query(
      `insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
       values ($1, $2, $3, 1), ($4, $2, $5, 2), ($6, $7, $3, 1)`,
      [
        randomUUID(),
        pairedPolicyId,
        chatModelId,
        randomUUID(),
        responsesOnlyModelId,
        randomUUID(),
        soloPolicyId,
      ],
    );
  });

  return {
    chatModelId,
    messagesOnlyProviderId,
    pairedVirtualModelId,
    responsesOnlyModelId,
    soloVirtualModelId,
    subscriptionProviderId,
  };
}

test("the console's editors carry only the draft they belong to, and a refused save writes nothing", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_editor_url_state_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seed(fixture.databaseUrl);
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

        // 1. Adding a credential is the first thing a new console does, and the
        //    link that starts it names no connection — it is not an edit.
        await page.goto(`${baseUrl}/providers?selected=${seeded.messagesOnlyProviderId}`);
        await page.getByRole("link", { name: "+ Add key" }).click();
        await expect(page.locator('dialog[open] input[name="providerApiKey"]')).toBeVisible();
        await expect(page.locator("dialog[open]")).not.toContainText("Connection not found");

        // The subscription provider's equivalent starts an authorization.
        await page.goto(`${baseUrl}/providers?selected=${seeded.subscriptionProviderId}`);
        await page.getByRole("link", { name: "+ Authorize token" }).click();
        await expect(page.locator("dialog[open]")).not.toContainText("Connection not found");
        await expect(
          page.locator('dialog[open] button, dialog[open] input[name="label"]').first(),
        ).toBeVisible();

        // 2. A provider refusal belongs to the provider and action that caused
        //    it. Switching rows clears both the local MutationForm error and
        //    every provider-scoped URL draft.
        await page.goto(`${baseUrl}/providers?selected=${seeded.subscriptionProviderId}`);
        await page.getByRole("button", { name: "Refresh models" }).click();
        await expect(page.getByRole("alert")).toContainText(
          "Provider credentials are required before refreshing models.",
        );
        await expect(page.getByRole("alert").locator(".text-redtx")).toBeVisible();
        await expect(page.getByTestId("providers-master-detail").getByRole("alert")).toHaveCount(0);
        await page.getByRole("button", { name: "Dismiss notification" }).click();
        await page.getByRole("link", { name: /Editor Provider/ }).click();
        await expect(page).toHaveURL(
          `${baseUrl}/providers?selected=${seeded.messagesOnlyProviderId}`,
        );
        await expect(page.getByRole("alert")).toHaveCount(0);
        await expect(page.locator("dialog[open]")).toHaveCount(0);

        // 3. A draft belongs to the model it was typed for. Closing the editor
        //    drops it, so the next model opens on its own values.
        await page.goto(`${baseUrl}/models?selected=${seeded.pairedVirtualModelId}&dialog=edit`);
        await page.locator('dialog[open] select[name="strategy"]').selectOption("fixed");
        await page.waitForLoadState("networkidle");
        await page.getByRole("link", { name: "Cancel" }).click();
        await page.waitForLoadState("networkidle");
        await page.goto(`${baseUrl}/models?selected=${seeded.soloVirtualModelId}&dialog=edit`);
        await expect(page.locator('dialog[open] input[name="name"]')).toHaveValue("solo-route");
        await expect(page.locator('dialog[open] select[name="strategy"]')).toHaveValue(
          "cost_first",
        );

        // 4. Removing every candidate means the route has none — not that the
        //    URL stopped saying which ones the operator picked.
        await page.goto(`${baseUrl}/models?selected=${seeded.pairedVirtualModelId}&dialog=edit`);
        await expect(page.locator("dialog[open]")).toContainText("2 selected");
        await page.getByRole("link", { name: "Remove editor-chat" }).click();
        await page.waitForLoadState("networkidle");
        await page.getByRole("link", { name: "Remove editor-responses" }).click();
        await page.waitForLoadState("networkidle");
        await expect(page.locator("dialog[open]")).toContainText("0 selected");
        await expect(page.getByRole("button", { name: "Save virtual model" })).toBeDisabled();

        // 5. One button, one outcome: a route the API refuses leaves the name
        //    it was submitted with untouched.
        await page.goto(`${baseUrl}/models?selected=${seeded.pairedVirtualModelId}&dialog=edit`);
        await page.locator('dialog[open] select[name="endpointProtocol"]').selectOption("messages");
        await page.waitForLoadState("networkidle");
        await page.locator('dialog[open] input[name="name"]').fill("paired-route-renamed");
        await page.getByRole("button", { name: "Save virtual model" }).click();
        await expect(page.locator("dialog[open] [role=alert]")).toContainText(
          /not supported|capabilit/i,
        );
        const named = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client
            .query<{ name: string }>("select name from virtual_models where id = $1", [
              seeded.pairedVirtualModelId,
            ])
            .then((result) => result.rows[0]?.name),
        );
        expect(named).toBe("paired-route");

        // 6. The way out of a blocked delete has to be a way that works.
        await page.goto(
          `${baseUrl}/providers?selected=${seeded.messagesOnlyProviderId}&dialog=delete`,
        );
        const deleteDialog = page.locator("dialog[open]");
        await expect(deleteDialog).toContainText("paired-route");
        await expect(deleteDialog).not.toContainText("or disable the provider");
        await page.goto(
          `${baseUrl}/providers?selected=${seeded.messagesOnlyProviderId}&dialog=disable`,
        );
        await expect(page.locator("dialog[open]")).toContainText(/refused|still used/i);
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
