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
      // A fresh console leads with the four steps that make it able to serve.
      await expect(page.getByText("Getting started")).toBeVisible();
      await expect(page.getByText("1 · Connect a provider")).toBeVisible();
      await expect(page.getByText("4 · Set limits, then verify")).toBeVisible();
      await expect(page.getByText(/^gw · /)).toBeVisible();
      await expect(
        page.getByRole("navigation", { name: "Console modules" }).getByRole("link"),
      ).toHaveCount(8);

      for (const corePage of [
        { path: "/providers", title: "Providers" },
        { path: "/activity", title: "Activity" },
        { path: "/usage", title: "Usage" },
        { path: "/playground", title: "Playground" },
      ]) {
        await page.goto(`${baseUrl}${corePage.path}`, { waitUntil: "networkidle" });
        await expect(
          page.getByRole("heading", { name: corePage.title, exact: true }),
          corePage.path,
        ).toBeVisible();
      }

      await page.goto(`${baseUrl}/api-keys`, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { name: "No API keys yet" })).toBeVisible();

      await page.goto(`${baseUrl}/limits`, { waitUntil: "networkidle" });
      await expect(page.getByText(/Issue a key first/)).toBeVisible();

      await page.goto(`${baseUrl}/models`, { waitUntil: "networkidle" });
      await expect(
        page.getByRole("heading", { level: 1, name: "Virtual Models", exact: true }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "No virtual models yet" })).toBeVisible();
      // Without a provider there is nothing to route to, and the empty state
      // says so rather than opening an editor that cannot be completed.
      await expect(page.getByRole("link", { name: "Connect a provider first" })).toBeVisible();

      let detailAttempts = 0;
      const corsHeaders = {
        "access-control-allow-headers": "authorization, content-type, x-request-id",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-origin": "*",
      };
      let modelListRequests = 0;
      await page.route("**/v1/models", async (route) => {
        if (route.request().method() === "OPTIONS") {
          await route.fulfill({ headers: corsHeaders, status: 204 });
          return;
        }
        modelListRequests += 1;
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
      const virtualModel = page.getByLabel("Virtual model", { exact: true });
      await expect(virtualModel).toBeDisabled();
      await expect(virtualModel.locator("option")).toHaveText("paste an API key first");
      expect(modelListRequests).toBe(0);

      await page.getByLabel("API key", { exact: true }).fill("llmi_test_key");
      await expect
        .poll(() => modelListRequests, { message: "model list is requested after a key is pasted" })
        .toBe(1);
      await expect(virtualModel).toBeEnabled();
      await expect(virtualModel.locator("option")).toHaveText("audit-playground-vm");
      await page.getByRole("button", { name: "Send request" }).click();
      await expect(page.getByText("Playground retry verified")).toBeVisible();
      // The trace reports the gateway's own request id, not the provider's, and
      // waits for the record instead of guessing at it.
      await expect(page.getByText("playground-delayed-detail")).toBeVisible();
      await expect(page.getByText("provider-request-id")).toHaveCount(0);
      await expect(page.getByText("Delayed Provider · Delayed Model")).toBeVisible();
      await expect(page.getByText("cost_first")).toBeVisible();
      // The trace is polled: the first lookup found nothing and it tried again.
      expect(detailAttempts).toBeGreaterThanOrEqual(2);

      // Below the desktop target the module row scrolls rather than collapsing
      // behind a menu, so every module stays reachable.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await expect(page.getByRole("navigation", { name: "Console modules" })).toBeVisible();
      await expect(page.getByText("Getting started")).toBeVisible();
      await expect(page.getByText("1 · Connect a provider")).toBeVisible();
      await expect(page.getByText("4 · Set limits, then verify")).toBeVisible();

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
