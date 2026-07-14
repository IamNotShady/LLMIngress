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

async function pageOverflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function expectTableColumnsContained(page: Page, selectors: string[]) {
  const audits = await page.evaluate((tableSelectors) => {
    return tableSelectors.map((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector);
      if (!table) {
        return { maxColumnShare: 1, selector, unsafeCells: ["missing table"] };
      }

      const tableWidth = table.getBoundingClientRect().width;
      const headers = Array.from(table.querySelectorAll(":scope > thead > tr > th"));
      const unsafeCells = Array.from(
        table.querySelectorAll<HTMLTableCellElement>(":scope > tbody > tr > td"),
      )
        .filter((cell) => cell.scrollWidth > cell.clientWidth + 1)
        .filter((cell) => getComputedStyle(cell).overflowX === "visible")
        .map((cell) => cell.textContent?.trim().slice(0, 80) ?? "");
      const maxColumnShare = Math.max(
        0,
        ...headers.map((header) => header.getBoundingClientRect().width / tableWidth),
      );

      return { maxColumnShare, selector, unsafeCells };
    });
  }, selectors);

  for (const audit of audits) {
    expect(audit.unsafeCells, audit.selector).toEqual([]);
    expect(audit.maxColumnShare, audit.selector).toBeLessThanOrEqual(0.34);
  }
}

// Seeds an agent, a virtual model, recent request activity (wide snapshots),
// and a full set of limit rules — the data shapes that reproduced the
// production layout breakages a fresh database hides.
async function seedConsoleData(databaseUrl: string) {
  const agentId = randomUUID();
  const virtualModelId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const routePolicyId = randomUUID();
  const agentName = "layout-probe-agent-with-a-name-that-must-not-overlap-adjacent-columns";
  const virtualModelName =
    "layout-probe-virtual-model-with-a-name-that-must-not-overlap-adjacent-columns";
  const providerName = "Layout Probe Provider With An Excessively Long Display Name";
  const providerModelName = "claude-sonnet-5-extended-thinking-with-a-long-display-name";
  const providerModelKey = `anthropic/${providerModelName}`;

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, $2, 'Layout probe', true)`,
      [virtualModelId, virtualModelName],
    );
    await client.query(
      `insert into providers (
         id, provider_type, provider_key, display_name, base_url, enabled
       )
       values ($1, 'api_key', 'openai', $2, 'https://example.test/v1', true)`,
      [providerId, providerName],
    );
    await client.query(
      `insert into provider_models (
         id, provider_id, model_id, display_name, context_window,
         max_output_tokens, supports_streaming, supports_function_calling,
         supports_reasoning, availability
       )
       values ($1, $2, $3, $4, 200000, 32000, true, true, true, 'available')`,
      [providerModelId, providerId, providerModelKey, providerModelName],
    );
    await client.query(
      `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
       values ($1, $2, 'fixed', 'chat_completions')`,
      [routePolicyId, virtualModelId],
    );
    await client.query(
      `insert into route_policy_candidates (
         id, route_policy_id, provider_model_id, candidate_order
       ) values ($1, $2, $3, 1)`,
      [randomUUID(), routePolicyId, providerModelId],
    );
    await client.query(
      `insert into agents (
         id, name, key_prefix, key_hash, default_virtual_model_id, enabled, limits_enabled
       ) values ($1, $2, 'llmi_layout_probe', 'test-hash', $3, true, true)`,
      [agentId, agentName, virtualModelId],
    );
    await client.query(
      `insert into agent_virtual_models (agent_id, virtual_model_id) values ($1, $2)`,
      [agentId, virtualModelId],
    );

    for (let i = 0; i < 8; i++) {
      const activityId = randomUUID();
      await client.query(
        `insert into request_activity (
           id, request_id, agent_id, virtual_model_id, route_policy_id,
           provider_id, provider_model_id, agent_key_prefix,
           protocol, model, stream, status, http_status, latency_ms,
           started_at, completed_at,
           agent_name_snapshot, virtual_model_name_snapshot,
           provider_display_name_snapshot, provider_model_display_name_snapshot
         )
         values (
           $1, $2, $3, $4, $5, $6, $7, 'llmi_layout_probe',
           'chat_completions', $8, false, $9, $10, 1234,
           now() - make_interval(mins => $11), now() - make_interval(mins => $11),
           $12, $13, $14, $15
         )`,
        [
          activityId,
          `playground_${Date.now()}_${randomUUID()}_request-id-with-extra-width`,
          agentId,
          virtualModelId,
          routePolicyId,
          providerId,
          providerModelId,
          providerModelKey,
          i === 0 ? "failed" : "succeeded",
          i === 0 ? 502 : 200,
          i * 5,
          agentName,
          virtualModelName,
          providerName,
          providerModelName,
        ],
      );
      await client.query(
        `insert into request_usage (
           id, request_activity_id, agent_id, virtual_model_id, provider_model_id,
           input_tokens, output_tokens, total_tokens, token_source
         ) values ($1, $2, $3, $4, $5, 12000, 345, 12345, 'provider')`,
        [randomUUID(), activityId, agentId, virtualModelId, providerModelId],
      );
      await client.query(
        `insert into request_costs (
           id, request_activity_id, agent_id, provider_model_id, total_cost_usd, cost_source
         ) values ($1, $2, $3, $4, '0.42', 'provider')`,
        [randomUUID(), activityId, agentId, providerModelId],
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
        `insert into agent_limits (id, agent_id, limit_type, period, limit_value, unit)
         values ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), agentId, limitType, period, limitValue, unit],
      );
    }
  });

  return { providerId, virtualModelId };
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
          page.locator(".chart-card", { hasText: "Requests & cost trend" }).locator(".chart-empty"),
        ).toBeVisible();
        await page.goto(`${baseUrl}/usage`);
        for (const title of ["Cost trend", "Tokens trend"]) {
          await expect(
            page.locator(".chart-card", { hasText: title }).locator(".chart-empty"),
          ).toBeVisible();
        }

        // --- Seed real request + limit data, then re-check the layouts it broke.
        const seeded = await seedConsoleData(fixture.databaseUrl);

        await page.goto(baseUrl);
        await expect(page.getByText("layout-probe-agent").first()).toBeVisible();

        // Trend window now has data: chart renders instead of the empty state.
        await expect(
          page.locator(".chart-card", { hasText: "Requests & cost trend" }).locator(".chart-empty"),
        ).toHaveCount(0);

        // Every current list owns its column proportions and contains long
        // text instead of allowing it to paint across adjacent columns.
        await page.setViewportSize({ width: 1904, height: 1080 });
        await expectTableColumnsContained(page, [".overview-requests-table"]);
        await page.goto(`${baseUrl}/agents`);
        await expectTableColumnsContained(page, [".agents-table"]);
        await page.goto(`${baseUrl}/providers?selected=${seeded.providerId}`);
        await expectTableColumnsContained(page, [
          ".providers-table",
          ".provider-key-table",
          ".model-library-table",
        ]);
        await page.goto(`${baseUrl}/models`);
        await expectTableColumnsContained(page, [".vm-table"]);
        await page.goto(`${baseUrl}/usage`);
        await expectTableColumnsContained(page, [".usage-summary-table"]);
        await page.goto(`${baseUrl}/limits`);
        await expectTableColumnsContained(page, [".limits-rule-table"]);
        await page.goto(`${baseUrl}/activity`);
        await expectTableColumnsContained(page, [".activity-table"]);
        await page.goto(`${baseUrl}/models?virtualModelDialog=${seeded.virtualModelId}`);
        await expect(page.locator(".vm-candidate-table")).toBeVisible();
        await expectTableColumnsContained(page, [".vm-candidate-table"]);
        await page.getByRole("button", { name: "Add Model" }).click();
        await expect(page.locator(".vm-model-picker-table")).toBeVisible();
        await expectTableColumnsContained(page, [".vm-model-picker-table"]);

        // Overview stays inside the viewport at both checkpoints; the
        // recent-requests table scrolls inside its card instead of widening
        // the page.
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await page.goto(baseUrl);
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
        ).toBeLessThanOrEqual(1);
        const actionCells = page.locator(".limits-rule-action-cell");
        await expect(actionCells).toHaveCount(1);
        const lastActionCell = actionCells.last();
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
  } finally {
    await fixture.dispose();
  }
});
