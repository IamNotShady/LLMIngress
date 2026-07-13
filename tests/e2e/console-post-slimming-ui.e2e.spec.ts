import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
import { withProcessLock } from "../support/process-lock";

test("fresh Console guides users through only the retained core workflow", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_post_slim_ui_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });
      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);

        await page.goto(baseUrl, { waitUntil: "networkidle" });
        await expect(page.getByRole("heading", { name: "Route your first request" })).toBeVisible();
        await expect(page.getByText("Gateway target", { exact: true })).toBeVisible();
        await expect(
          page.getByRole("navigation", { name: "Console sections" }).getByRole("link"),
        ).toHaveCount(8);

        for (const corePage of [
          { path: "/providers", title: "Providers & Models" },
          { path: "/activity", title: "Activity" },
          { path: "/usage", title: "Usage & Cost" },
          { path: "/playground", title: "Playground" },
        ]) {
          await page.goto(`${baseUrl}${corePage.path}`, { waitUntil: "networkidle" });
          await expect(
            page.getByRole("heading", { name: corePage.title, exact: true }),
            corePage.path,
          ).toBeVisible();
        }

        await page.goto(`${baseUrl}/agents`, { waitUntil: "networkidle" });
        await expect(page.getByText(/Create an Agent to issue an API key/)).toBeVisible();

        await page.goto(`${baseUrl}/limits`, { waitUntil: "networkidle" });
        await expect(page.getByText(/Create an Agent and enable limits/)).toBeVisible();

        await page.goto(`${baseUrl}/models`, { waitUntil: "networkidle" });
        await expect(
          page.getByRole("heading", { name: "Virtual Models", exact: true }),
        ).toBeVisible();
        await expect(page.getByText(/Add a Provider and refresh its models/)).toBeVisible();
        await page.getByRole("link", { name: "Create Virtual Model" }).click();
        await page.getByRole("button", { name: "Add Model" }).click();
        await expect(
          page.getByText("No compatible models available for this endpoint."),
        ).toBeVisible();
        await expect(page.getByRole("link", { name: "Open Providers" })).toBeVisible();

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(baseUrl, { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Menu" }).click();
        await expect(page.getByRole("navigation", { name: "Console sections" })).toBeVisible();
        await expect(page.getByRole("heading", { name: "Route your first request" })).toBeVisible();

        for (const removedPath of ["/runtime", "/settings", "/routing"]) {
          const response = await page.goto(`${baseUrl}${removedPath}`);
          expect(response?.status(), removedPath).toBe(404);
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});
