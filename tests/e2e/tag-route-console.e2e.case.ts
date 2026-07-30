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

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

type Seeded = {
  defaultModelId: string;
  longContextModelId: string;
};

async function seed(databaseUrl: string): Promise<Seeded> {
  const providerId = randomUUID();
  const defaultModelId = randomUUID();
  const longContextModelId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'openai', 'Tag Provider', 'https://tag-provider.test/v1', true)`,
      [providerId],
    );
    // The long-context candidate outreaches the default one, which is exactly the
    // coverage the operator has to be warned about rather than refused for.
    await client.query(
      `insert into provider_models (
         id, provider_id, model_id, display_name,
         input_modalities, output_modalities, context_window, max_output_tokens,
         supports_streaming, supports_function_calling, supports_reasoning, availability
       )
       values ($1, $3, 'tag-default', 'tag-default', array['text']::text[], array['text']::text[],
               128000, 8192, true, true, false, 'available'),
              ($2, $3, 'tag-long-context', 'tag-long-context', array['text']::text[], array['text']::text[],
               1000000, 8192, true, true, false, 'available')`,
      [defaultModelId, longContextModelId, providerId],
    );
  });

  return { defaultModelId, longContextModelId };
}

async function readVirtualModelId(databaseUrl: string, name: string): Promise<string | undefined> {
  return withDedicatedPostgresClient(databaseUrl, (client) =>
    client
      .query<{ id: string }>("select id::text from virtual_models where name = $1", [name])
      .then((result) => result.rows[0]?.id),
  );
}

test("the route editor saves candidate tags, refuses a duplicate, and shows coverage warnings", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_tag_console_${randomUUID().replaceAll("-", "_")}`,
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
      const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
      const page = await context.newPage();

      try {
        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);

        const editorUrl = `${baseUrl}/models?dialog=new&editorStrategy=tag&candidates=${seeded.defaultModelId},${seeded.longContextModelId}`;
        await page.goto(editorUrl);
        const dialog = page.locator("dialog[open]");
        await expect(dialog).toContainText("TAGS ROUTE REQUESTS");
        await expect(dialog).toContainText("ROUTED BY TAG");
        await expect(dialog).toContainText("x-llmingress-route-tag");
        const tagFields = dialog.locator('input[name="candidateTags"]');
        await expect(tagFields).toHaveCount(2);

        // 1. The same tag on two candidates is a refusal, and nothing is written.
        await dialog.locator('input[name="name"]').fill("vm-tag-console");
        await dialog.locator('input[name="description"]').fill("tag routed model");
        await tagFields.nth(0).fill("default");
        await tagFields.nth(1).fill("default");
        await page.getByRole("button", { name: "Create virtual model" }).click();
        await expect(dialog.locator("[role=alert]")).toContainText(/more than one candidate/i);
        expect(await readVirtualModelId(fixture.databaseUrl, "vm-tag-console")).toBeUndefined();

        // 2. A tag route with exactly one default saves, and the tag it stores is
        //    the normalized one so a header never has to match the typed casing.
        await tagFields.nth(1).fill("Long-Context");
        await page.getByRole("button", { name: "Create virtual model" }).click();
        await expect(page.locator("dialog[open]")).toHaveCount(0);
        const virtualModelId = await readVirtualModelId(fixture.databaseUrl, "vm-tag-console");
        expect(virtualModelId).toBeTruthy();

        // 3. The detail view reads the route by tag, and the coverage warning the
        //    save allowed is visible rather than silent.
        await page.goto(`${baseUrl}/models?selected=${virtualModelId}`);
        await expect(page.getByText("TAGS", { exact: true })).toBeVisible();
        await expect(page.getByText("long-context", { exact: true })).toBeVisible();
        const warnings = page.getByTestId("route-warnings");
        await expect(warnings).toBeVisible();
        await expect(warnings).toContainText("Tag coverage warning");
        await expect(warnings).toContainText("context window");
        expect(await overflowPx(page)).toBeLessThanOrEqual(0);

        // At 390 the models page keeps its master/detail grid in a local
        // scroller, so the extra TAGS column and the warning list must not push
        // the page itself sideways.
        await page.setViewportSize({ height: 844, width: 390 });
        await page.goto(`${baseUrl}/models?selected=${virtualModelId}`);
        await expect(page.getByRole("heading", { name: "Virtual Models" })).toBeVisible();
        expect(await overflowPx(page)).toBeLessThanOrEqual(0);
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
