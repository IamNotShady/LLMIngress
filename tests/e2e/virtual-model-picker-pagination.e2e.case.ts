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
const PAGE_SIZE = 10;

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
        await page.goto(`${baseUrl}/models?virtualModelDialog=new`, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Add Model" }).click();

        const picker = page.locator(".vm-model-picker");
        const rows = picker.locator(".vm-model-picker-table tbody tr");
        const pagination = picker.locator(".list-pagination");

        await expect(rows).toHaveCount(PAGE_SIZE);
        await expect(picker).toContainText("Chat Model 01");
        await expect(picker).not.toContainText("Chat Model 11");
        await expect(pagination).toContainText("Page 1 of 3");
        await expect(pagination).toContainText("1–10 of 23 models");
        await expect(pagination.getByRole("button", { name: "Previous page" })).toBeDisabled();

        await pagination.getByRole("button", { name: "Next page" }).click();
        await expect(pagination).toContainText("Page 2 of 3");
        await expect(picker).toContainText("Chat Model 11");
        await expect(picker).not.toContainText("Chat Model 01");

        await pagination.getByRole("button", { name: "Next page" }).click();
        await expect(pagination).toContainText("Page 3 of 3");
        await expect(rows).toHaveCount(MODEL_COUNT - PAGE_SIZE * 2);
        await expect(pagination.getByRole("button", { name: "Next page" })).toBeDisabled();

        // Search resets to the first page; short result sets drop the footer.
        await picker.getByLabel("Model name").fill("chat-2");
        await expect(rows).toHaveCount(4);
        await expect(pagination).toHaveCount(0);
        await expect(picker).toContainText("Chat Model 20");

        await picker.getByLabel("Model name").fill("");
        await expect(pagination).toContainText("Page 1 of 3");
        await expect(picker).toContainText("Chat Model 01");

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
