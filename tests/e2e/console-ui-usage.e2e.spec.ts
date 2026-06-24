import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { withConsoleDevServer } from "../support/console-dev-server";

test("usage & cost page renders reference filters, KPI cards, charts, savings, and summary table", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.addInitScript(() => {
      const usageWindow = window as unknown as { __usageDatePickerCalls?: string[] };
      usageWindow.__usageDatePickerCalls = [];
      HTMLInputElement.prototype.showPicker = function showPickerSpy() {
        usageWindow.__usageDatePickerCalls?.push(this.id);
      };
    });
    await page.goto(`${baseUrl}/usage`);

    await expect(page.getByRole("heading", { level: 1, name: "Usage & Cost" })).toBeVisible();

    for (const label of ["Start date", "End date", "Agent", "Virtual Model", "Provider"]) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }
    await page.getByLabel("Start date", { exact: true }).click();
    await expect
      .poll(async () =>
        page.evaluate(
          () => (window as unknown as { __usageDatePickerCalls?: string[] }).__usageDatePickerCalls,
        ),
      )
      .toContain("usage-date-from");

    // KPI tiles (scoped to stat-card labels — savings is also repeated in the side panel).
    for (const label of [
      "Total cost",
      "Total tokens",
      "Total requests",
      "Avg latency",
      "Failure rate",
      "Estimated savings",
    ]) {
      await expect(
        page.locator(".stat-card-label", { hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    for (const title of [
      "Cost trend",
      "Tokens trend",
      "Savings overview",
      "Agent cost distribution",
      "Virtual Model cost distribution",
      "Provider cost distribution",
      "Provider / Model summary",
    ]) {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    }

    const table = page.getByRole("table");
    for (const column of [
      "Provider",
      "Model",
      "Requests",
      "Tokens",
      "Cost",
      "Avg latency",
      "Failure rate",
      "Savings",
    ]) {
      await expect(table.getByRole("columnheader", { name: column })).toBeVisible();
    }
  });
});

test("usage date filters show a calendar popover when native date picker is unavailable", async ({
  browser,
}) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.addInitScript(() => {
      Object.defineProperty(HTMLInputElement.prototype, "showPicker", {
        configurable: true,
        value: undefined,
      });
    });
    await page.goto(`${baseUrl}/usage`);

    const startDateInput = page.getByLabel("Start date", { exact: true });
    await startDateInput.click();

    const picker = page.getByRole("dialog", { name: "Start date calendar" });
    await expect(picker).toBeVisible();

    const firstDateButton = picker.locator(".date-picker-day").first();
    const selectedDate = await firstDateButton.getAttribute("data-date");
    expect(selectedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await firstDateButton.click();

    await expect(startDateInput).toHaveValue(selectedDate ?? "");
    await expect(picker).toBeHidden();
  });
});

test("usage virtual model filter shows virtual model names without descriptions", async ({
  browser,
}) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/usage`);

      await expect(page.locator("select#usage-virtual-model option")).toHaveText([
        "All virtual models",
        "gpt55",
        "opus48",
        "random",
      ]);
    },
    { seed: seedUsageVirtualModels },
  );
});

async function seedUsageVirtualModels(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const [name, description] of [
      ["gpt55", "openai codex"],
      ["opus48", "claude opus"],
      ["random", "random open ai completion"],
    ] as const) {
      await client.query(
        "insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)",
        [randomUUID(), name, description],
      );
    }
  } finally {
    await client.end();
  }
}
