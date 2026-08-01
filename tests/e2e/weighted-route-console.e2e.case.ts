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
  primaryModelId: string;
  secondaryModelId: string;
};

async function seed(databaseUrl: string): Promise<Seeded> {
  const providerId = randomUUID();
  const primaryModelId = randomUUID();
  const secondaryModelId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'openai', 'Weight Provider', 'https://weight-provider.test/v1', true)`,
      [providerId],
    );
    // Weighted keeps the all-candidates capability contract, so both models
    // carry identical known capabilities: the editor must refuse the sum, not
    // a capability mismatch.
    await client.query(
      `insert into provider_models (
         id, provider_id, model_id, display_name,
         input_modalities, output_modalities, context_window, max_output_tokens,
         supports_streaming, supports_function_calling, supports_reasoning, availability
       )
       values ($1, $3, 'weight-primary', 'weight-primary', array['text']::text[], array['text']::text[],
               128000, 8192, true, true, false, 'available'),
              ($2, $3, 'weight-secondary', 'weight-secondary', array['text']::text[], array['text']::text[],
               128000, 8192, true, true, false, 'available')`,
      [primaryModelId, secondaryModelId, providerId],
    );
  });

  return { primaryModelId, secondaryModelId };
}

async function readVirtualModelId(databaseUrl: string, name: string): Promise<string | undefined> {
  return withDedicatedPostgresClient(databaseUrl, (client) =>
    client
      .query<{ id: string }>("select id::text from virtual_models where name = $1", [name])
      .then((result) => result.rows[0]?.id),
  );
}

async function readCandidateWeights(databaseUrl: string): Promise<string[]> {
  return withDedicatedPostgresClient(databaseUrl, (client) =>
    client
      .query<{ weight: string | null }>(
        "select weight::text as weight from route_policy_candidates order by candidate_order",
      )
      .then((result) => result.rows.map((row) => row.weight ?? "")),
  );
}

test("the route editor saves candidate weights, refuses a bad sum, and shows the weight column", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_weighted_console_${randomUUID().replaceAll("-", "_")}`,
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

        const editorUrl = `${baseUrl}/models?dialog=new&editorStrategy=weighted&candidates=${seeded.primaryModelId},${seeded.secondaryModelId}`;
        await page.goto(editorUrl);
        const dialog = page.locator("dialog[open]");
        await expect(dialog).toContainText("WEIGHTS SUM TO 1.00");
        await expect(dialog).toContainText("SPLIT BY WEIGHT");
        const weightFields = dialog.locator('input[name="candidateWeights"]');
        await expect(weightFields).toHaveCount(2);

        // 0. The weight field constrains drafts while typing: a third decimal
        //    digit and non-weight characters are swallowed at the keystroke,
        //    so only the sum rule is left for the server to refuse.
        await weightFields.nth(0).pressSequentially("0.12222");
        await expect(weightFields.nth(0)).toHaveValue("0.12");
        await weightFields.nth(0).fill("");
        await weightFields.nth(0).pressSequentially("abc");
        await expect(weightFields.nth(0)).toHaveValue("");

        // 1. Weights that do not sum to 1.00 are a refusal, and nothing is written.
        await dialog.locator('input[name="name"]').fill("vm-weighted-console");
        await dialog.locator('input[name="description"]').fill("weighted routed model");
        await weightFields.nth(0).fill("0.60");
        await weightFields.nth(1).fill("0.30");
        await page.getByRole("button", { name: "Create virtual model" }).click();
        await expect(dialog.locator("[role=alert]")).toContainText(/sum to exactly 1\.00/i);
        expect(
          await readVirtualModelId(fixture.databaseUrl, "vm-weighted-console"),
        ).toBeUndefined();

        // 2. A 0.75 / 0.25 split saves and lands in the candidate rows.
        await weightFields.nth(0).fill("0.75");
        await weightFields.nth(1).fill("0.25");
        await page.getByRole("button", { name: "Create virtual model" }).click();
        await expect(page.locator("dialog[open]")).toHaveCount(0);
        const virtualModelId = await readVirtualModelId(fixture.databaseUrl, "vm-weighted-console");
        expect(virtualModelId).toBeTruthy();
        expect(await readCandidateWeights(fixture.databaseUrl)).toEqual(["0.75", "0.25"]);

        // 3. The detail view shows the configured share next to observed traffic.
        await page.goto(`${baseUrl}/models?selected=${virtualModelId}`);
        await expect(page.getByText("WEIGHT", { exact: true })).toBeVisible();
        await expect(page.getByText("75%", { exact: true })).toBeVisible();
        await expect(page.getByText("25%", { exact: true })).toBeVisible();
        expect(await overflowPx(page)).toBeLessThanOrEqual(0);

        // 4. Reopening the editor re-displays the stored weights.
        await page.goto(`${baseUrl}/models?selected=${virtualModelId}&dialog=edit`);
        const editFields = page.locator('dialog[open] input[name="candidateWeights"]');
        await expect(editFields.nth(0)).toHaveValue("0.75");
        await expect(editFields.nth(1)).toHaveValue("0.25");

        // 5. At 390 the models page keeps the WEIGHT column inside its local
        //    scroller rather than pushing the page sideways.
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
