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

test("fresh Console guides users through only the retained core workflow", async ({ page }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_post_slim_ui_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
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

      await page.goto(`${baseUrl}/api-keys`, { waitUntil: "networkidle" });
      await expect(page.getByText(/Create an API Key to issue an API key/)).toBeVisible();

      await page.goto(`${baseUrl}/limits`, { waitUntil: "networkidle" });
      await expect(page.getByText(/Create an API Key and enable limits/)).toBeVisible();

      await page.goto(`${baseUrl}/models`, { waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", { name: "Virtual Models", exact: true }),
      ).toBeVisible();
      await expect(page.getByText(/Add a Provider and refresh its models/)).toBeVisible();
      await page.getByRole("link", { name: "Create Virtual Model" }).click();
      await page.getByRole("button", { name: "Add Model" }).click();
      await expect(page.getByText("No Provider Models found.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Open Providers" })).toBeVisible();

      let detailAttempts = 0;
      const corsHeaders = {
        "access-control-allow-headers": "authorization, content-type, x-request-id",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-origin": "*",
      };
      await page.route("**/v1/models", async (route) => {
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({ headers: corsHeaders, status: 204 });
          return;
        }
        await route.fulfill({
          body: JSON.stringify({ data: [{ id: "audit-playground-vm" }] }),
          contentType: "application/json",
          headers: corsHeaders,
          status: 200,
        });
      });
      await page.route("**/v1/chat/completions", async (route) => {
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({ headers: corsHeaders, status: 204 });
          return;
        }
        await route.fulfill({
          body: JSON.stringify({
            choices: [{ message: { content: "Playground retry verified" } }],
            usage: { total_tokens: 42 },
          }),
          contentType: "application/json",
          headers: {
            ...corsHeaders,
            "access-control-expose-headers": "x-llmingress-request-id, x-request-id",
            "x-llmingress-request-id": "playground-delayed-detail",
            "x-request-id": "provider-request-id",
          },
          status: 200,
        });
      });
      await page.route("**/api/playground/result?*", async (route) => {
        detailAttempts += 1;
        const requestId = new URL(route.request().url()).searchParams.get("requestId");
        if (requestId !== "playground-delayed-detail") {
          await route.fulfill({
            body: JSON.stringify({ detail: null }),
            contentType: "application/json",
            status: 404,
          });
          return;
        }
        if (detailAttempts === 1) {
          await route.fulfill({
            body: JSON.stringify({ detail: null }),
            contentType: "application/json",
            status: 404,
          });
          return;
        }
        await route.fulfill({
          body: JSON.stringify({
            detail: {
              latencyMs: 125,
              providerDisplayName: "Delayed Provider",
              providerKey: "openai",
              providerModelDisplayName: "Delayed Model",
              providerModelName: "delayed-model",
              requestId: "playground-delayed-detail",
              routePolicyStrategy: "cost_first",
              status: "succeeded",
              totalCostUsd: "0.00042",
              totalTokens: 42,
              virtualModelName: "audit-playground-vm",
            },
          }),
          contentType: "application/json",
          status: 200,
        });
      });
      await page.goto(`${baseUrl}/playground`, { waitUntil: "networkidle" });
      await page.getByLabel("1. API Key").fill("llmi_test_key");
      await expect(page.getByLabel("3. Virtual Model").locator("option")).toHaveCount(2);
      await page.getByLabel("3. Virtual Model").selectOption("audit-playground-vm");
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText("Playground retry verified")).toBeVisible();
      const requestDetails = page.getByRole("region", { name: "Request and routing details" });
      await expect(requestDetails).toContainText("playground-delayed-detail");
      await expect(requestDetails).not.toContainText("provider-request-id");
      await expect(requestDetails).toContainText("Delayed Provider / Delayed Model");
      await expect(requestDetails).toContainText("cost first");
      expect(detailAttempts).toBeGreaterThanOrEqual(2);

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
  } finally {
    await fixture.dispose();
  }
});
