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

const MODEL_COUNT = 23;
const PAGE_SIZE = 8;

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function seedPaginationModels(databaseUrl: string): Promise<void> {
  const providerId = randomUUID();
  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, enabled)
        values ($1, 'api_key', 'openai', 'OpenAI', true)
      `,
      [providerId],
    );
    for (let index = 1; index <= MODEL_COUNT; index += 1) {
      const label = String(index).padStart(2, "0");
      await client.query(
        `
          insert into provider_models (
            id,
            provider_id,
            model_id,
            display_name,
            input_modalities,
            output_modalities,
            context_window,
            max_output_tokens,
            supports_streaming,
            supports_function_calling,
            supports_reasoning,
            availability
          )
          values ($1, $2, $3, $4, array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')
        `,
        [randomUUID(), providerId, `chat-${label}`, `Chat Model ${label}`],
      );
    }
  });
}

test("route model picker paginates long model lists and resets on filter changes", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_picker_pg_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedPaginationModels(fixture.databaseUrl);
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
        await page.setViewportSize({ width: 1280, height: 900 });
        await signInFromFirstRun(page, baseUrl);
        await page.goto(`${baseUrl}/models?dialog=new`, { waitUntil: "networkidle" });

        const editor = page.getByRole("dialog", { name: "New Virtual Model" });
        const candidates = page.getByTestId("virtual-model-candidates");
        const rows = candidates.getByRole("link");
        const search = editor.getByLabel("Search candidate models");
        const nextPage = editor.getByRole("link", { name: "Next →" });
        const prevPage = editor.getByRole("link", { name: "← Prev" });

        // The header count and the pagination range read off the same total, so
        // an operator can tell how much of the list they are looking at.
        await expect(editor.getByText(`${MODEL_COUNT} matches`)).toBeVisible();
        await expect(rows).toHaveCount(PAGE_SIZE);
        await expect(candidates).toContainText("chat-01");
        await expect(candidates).not.toContainText("chat-09");
        await expect(editor.getByText(`1–${PAGE_SIZE} of ${MODEL_COUNT}`)).toBeVisible();
        await expect(prevPage).toHaveCount(0);

        await nextPage.click();
        await expect(candidates).toContainText("chat-09");
        await expect(candidates).not.toContainText("chat-01");
        await expect(editor.getByText(`9–16 of ${MODEL_COUNT}`)).toBeVisible();

        await nextPage.click();
        await expect(rows).toHaveCount(MODEL_COUNT - PAGE_SIZE * 2);
        await expect(editor.getByText(`17–${MODEL_COUNT} of ${MODEL_COUNT}`)).toBeVisible();
        await expect(nextPage).toHaveCount(0);

        // Typing is the search: it settles and the list re-reads, with no
        // button in between. It also starts from the first page — staying on
        // page 3 of the old result set would show nothing and read as "no
        // matches".
        await search.fill("chat-2");
        await expect(rows).toHaveCount(4);
        await expect(candidates).toContainText("chat-20");
        await expect(editor.getByText("4 matches")).toBeVisible();
        // A result set that fits on one page hides the pager entirely.
        await expect(editor.getByText(/of 4$/)).toHaveCount(0);

        await search.fill("");
        await expect(editor.getByText(`1–${PAGE_SIZE} of ${MODEL_COUNT}`)).toBeVisible();
        await expect(candidates).toContainText("chat-01");

        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await overflowPx(page), `${viewport.width}px`).toBeLessThanOrEqual(0);
        }
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
