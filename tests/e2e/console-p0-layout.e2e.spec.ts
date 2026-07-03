import { randomUUID } from "node:crypto";
import { expect, type Page, test } from "@playwright/test";
import {
  createTestPostgresFixture,
  runMigrations,
  withPostgresClient,
} from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
import { withProcessLock } from "../support/process-lock";

async function pageOverflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// Seeds an agent, a virtual model, recent request activity (wide snapshots),
// and a full set of limit rules — the data shapes that reproduced the
// production layout breakages a fresh database hides.
async function seedConsoleData(databaseUrl: string) {
  const agentId = randomUUID();
  const virtualModelId = randomUUID();

  await withPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into agents (id, name, agent_type, key_prefix, key_hash, enabled)
       values ($1, 'layout-probe-agent', 'terminal', 'llmi_layout_probe', 'test-hash', true)`,
      [agentId],
    );
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'layout-probe-virtual-model', 'Layout probe', true)`,
      [virtualModelId],
    );

    for (let i = 0; i < 8; i++) {
      await client.query(
        `insert into request_activity (
           id, request_id, agent_id, virtual_model_id, agent_key_prefix,
           protocol, model, stream, status, http_status, latency_ms,
           started_at, completed_at,
           agent_name_snapshot, virtual_model_name_snapshot,
           provider_display_name_snapshot, provider_model_display_name_snapshot
         )
         values (
           $1, $2, $3, $4, 'llmi_layout_probe',
           'chat_completions', 'anthropic/claude-sonnet-5-extended-thinking', false,
           $5, $6, 1234,
           now() - make_interval(mins => $7), now() - make_interval(mins => $7),
           'layout-probe-agent', 'layout-probe-virtual-model',
           'Layout Probe Provider Inc.', 'claude-sonnet-5-extended-thinking'
         )`,
        [
          randomUUID(),
          `gw_${randomUUID()}`,
          agentId,
          virtualModelId,
          i === 0 ? "failed" : "succeeded",
          i === 0 ? 502 : 200,
          i * 5,
        ],
      );
    }

    const limitRules = [
      ["budget", "month", 100, "usd"],
      ["rpm", "minute", 600, "requests"],
      ["tpm", "minute", 1_000_000, "tokens"],
      ["concurrency", "request", 100, "requests"],
      ["token", "request", 200_000, "tokens"],
    ] as const;
    for (const [limitType, period, limitValue, unit] of limitRules) {
      await client.query(
        `insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit, alert_threshold)
         values ($1, $2, $3, $4, $5, $6, 80)`,
        [randomUUID(), agentId, limitType, period, limitValue, unit],
      );
    }
  });
}

test("console keeps layout integrity with real data: no overflow, visible limits actions, chart empty states, mobile nav drawer", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_p0_layout_${randomUUID().replaceAll("-", "_")}`,
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
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await signInFromFirstRun(page, baseUrl);
          await expect(
            page.getByRole("heading", { level: 1, name: "Overview", exact: true }),
          ).toBeVisible();

          // --- Empty windows show an explicit chart empty state, not a blank card.
          await expect(
            page
              .locator(".chart-card", { hasText: "Requests & cost trend" })
              .locator(".chart-empty"),
          ).toBeVisible();
          await page.goto(`${baseUrl}/usage`);
          for (const title of ["Cost trend", "Tokens trend"]) {
            await expect(
              page.locator(".chart-card", { hasText: title }).locator(".chart-empty"),
            ).toBeVisible();
          }

          // --- Seed real request + limit data, then re-check the layouts it broke.
          await seedConsoleData(fixture.databaseUrl);

          await page.goto(baseUrl);
          await expect(page.getByText("layout-probe-agent").first()).toBeVisible();

          // Trend window now has data: chart renders instead of the empty state.
          await expect(
            page
              .locator(".chart-card", { hasText: "Requests & cost trend" })
              .locator(".chart-empty"),
          ).toHaveCount(0);

          // Overview stays inside the viewport at both checkpoints; the
          // recent-requests table scrolls inside its card instead of widening
          // the page.
          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 390, height: 844 },
          ]) {
            await page.setViewportSize(viewport);
            await expect.poll(() => pageOverflowPx(page)).toBeLessThanOrEqual(0);
          }
          const recentWrap = page
            .locator(".chart-card", { hasText: "Recent requests" })
            .locator(".data-table-wrap");
          expect(await recentWrap.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);

          // --- Limits rules table fits the 1280 content column, actions included.
          await page.setViewportSize({ width: 1280, height: 800 });
          await page.goto(`${baseUrl}/limits`);
          const limitsWrap = page.locator(".limits-rule-table-wrap");
          await expect(limitsWrap).toBeVisible();
          expect(
            await limitsWrap.evaluate((el) => el.scrollWidth - el.clientWidth),
          ).toBeLessThanOrEqual(0);
          const lastActionCell = page.locator(".limits-rule-action-cell").last();
          const actionBox = await lastActionCell.boundingBox();
          const wrapBox = await limitsWrap.boundingBox();
          expect(actionBox).not.toBeNull();
          expect(wrapBox).not.toBeNull();
          expect((actionBox?.x ?? 0) + (actionBox?.width ?? 0)).toBeLessThanOrEqual(
            (wrapBox?.x ?? 0) + (wrapBox?.width ?? 0) + 1,
          );
          await expect.poll(() => pageOverflowPx(page)).toBeLessThanOrEqual(0);

          // --- Mobile: nav collapses behind a menu toggle; drawer closes on navigate.
          await page.setViewportSize({ width: 390, height: 844 });
          await page.goto(baseUrl);
          const sidebarNav = page.getByRole("navigation", { name: "Console sections" });
          const menuToggle = page.getByRole("button", { name: "Menu" });
          const agentsLink = sidebarNav.getByRole("link", { name: "Agents", exact: true });

          await expect(menuToggle).toBeVisible();
          await expect(menuToggle).toHaveAttribute("aria-expanded", "false");
          await expect(agentsLink).toBeHidden();

          await menuToggle.click();
          await expect(menuToggle).toHaveAttribute("aria-expanded", "true");
          await expect(agentsLink).toBeVisible();

          await agentsLink.click();
          await page.waitForURL((url) => url.pathname === "/agents");
          await expect(menuToggle).toHaveAttribute("aria-expanded", "false");
          await expect(agentsLink).toBeHidden();
          await expect.poll(() => pageOverflowPx(page)).toBeLessThanOrEqual(0);

          // Desktop keeps the always-visible sidebar and hides the toggle.
          await page.setViewportSize({ width: 1280, height: 800 });
          await expect(menuToggle).toBeHidden();
          await expect(agentsLink).toBeVisible();
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});
