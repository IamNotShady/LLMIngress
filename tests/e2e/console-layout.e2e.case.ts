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

async function expectRowCellsContained(page: Page, label: string) {
  // Every cell of a fixed-track row either fits or clips; a cell that overflows
  // with visible overflow paints across the column beside it.
  const spilling = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('[style*="grid-template-columns"]'),
    );
    const offenders: string[] = [];
    for (const row of rows) {
      for (const cell of Array.from(row.children) as HTMLElement[]) {
        if (cell.scrollWidth <= cell.clientWidth + 1) {
          continue;
        }
        if (getComputedStyle(cell).overflowX !== "visible") {
          continue;
        }
        offenders.push((cell.textContent ?? "").trim().slice(0, 60));
      }
    }
    return offenders;
  });
  expect(spilling, label).toEqual([]);
}

// Seeds an apiKey, a virtual model, recent request activity (wide snapshots),
// and a full set of limit rules — the data shapes that reproduced the
// production layout breakages a fresh database hides.
async function seedConsoleData(databaseUrl: string) {
  const apiKeyId = randomUUID();
  const virtualModelId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const routePolicyId = randomUUID();
  const apiKeyName = "layout-probe-api-key-with-a-name-that-must-not-overlap-adjacent-columns";
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
      `insert into api_keys (
         id, name, key_prefix, key_hash, default_virtual_model_id, enabled, limits_enabled
       ) values ($1, $2, 'llmi_layout_probe', 'test-hash', $3, true, true)`,
      [apiKeyId, apiKeyName, virtualModelId],
    );
    await client.query(
      `insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)`,
      [apiKeyId, virtualModelId],
    );

    for (let i = 0; i < 8; i++) {
      const activityId = randomUUID();
      await client.query(
        `insert into request_activity (
           id, request_id, api_key_id, virtual_model_id, route_policy_id,
           provider_id, provider_model_id, api_key_prefix,
           protocol, model, stream, status, http_status, latency_ms,
           started_at, completed_at,
           api_key_name_snapshot, virtual_model_name_snapshot,
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
          apiKeyId,
          virtualModelId,
          routePolicyId,
          providerId,
          providerModelId,
          providerModelKey,
          i === 0 ? "failed" : "succeeded",
          i === 0 ? 502 : 200,
          i * 5,
          apiKeyName,
          virtualModelName,
          providerName,
          providerModelName,
        ],
      );
      await client.query(
        `insert into request_usage (
           id, request_activity_id, api_key_id, virtual_model_id, provider_model_id,
           input_tokens, output_tokens, total_tokens, token_source
         ) values ($1, $2, $3, $4, $5, 12000, 345, 12345, 'provider')`,
        [randomUUID(), activityId, apiKeyId, virtualModelId, providerModelId],
      );
      await client.query(
        `insert into request_costs (
           id, request_activity_id, api_key_id, provider_model_id, total_cost_usd, cost_source
         ) values ($1, $2, $3, $4, '0.42', 'provider')`,
        [randomUUID(), activityId, apiKeyId, providerModelId],
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
        `insert into api_key_limits (id, api_key_id, limit_type, period, limit_value, unit)
         values ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), apiKeyId, limitType, period, limitValue, unit],
      );
    }
  });

  return { apiKeyId, apiKeyName, providerId, virtualModelId, virtualModelName };
}

test("console keeps layout integrity with real data: cells clip, no page overflow, empty states are explicit, and every module stays reachable below the target width", async ({
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

        // --- An empty window states that it is empty rather than drawing a
        // blank card.
        await expect(page.getByRole("heading", { name: "No traffic yet" })).toBeVisible();
        await page.goto(`${baseUrl}/usage`);
        await expect(page.getByRole("heading", { name: "Nothing to report yet" })).toBeVisible();

        // --- Seed real request + limit data, then re-check the layouts.
        const seeded = await seedConsoleData(fixture.databaseUrl);

        await page.goto(baseUrl);
        await expect(page.getByText("layout-probe-api-key").first()).toBeVisible();
        await expect(page.getByRole("heading", { name: "No traffic yet" })).toHaveCount(0);

        // Every list contains its own long text at the desktop target and above.
        await page.setViewportSize({ width: 1904, height: 1080 });
        await expectRowCellsContained(page, "overview");
        for (const path of [
          "/api-keys",
          `/providers?selected=${seeded.providerId}`,
          "/models",
          "/usage",
          "/limits",
          "/activity",
        ]) {
          await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
          await expectRowCellsContained(page, path);
        }

        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(`${baseUrl}/models?selected=${seeded.virtualModelId}&dialog=edit`, {
          waitUntil: "networkidle",
        });
        const routeDialog = page.getByRole("dialog", { name: /Virtual Model/ });
        await expect(routeDialog).toBeVisible();
        // The editor states the strategy and its consequence, and the candidate
        // browser lives in the same dialog.
        await expect(routeDialog.getByLabel("STRATEGY")).toBeVisible();
        await expect(routeDialog.getByText("ADD FROM MATCHING MODELS")).toBeVisible();
        await expectRowCellsContained(page, "virtual model editor");

        // --- No page overflow at either checkpoint, with data on the page.
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          for (const path of ["/", "/limits", "/activity"]) {
            await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle" });
            await expect.poll(() => pageOverflowPx(page)).toBeLessThanOrEqual(0);
          }
        }

        // --- Limits: the row action stays reachable inside the scroll box.
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`${baseUrl}/limits`, { waitUntil: "networkidle" });
        await expect(page.getByText("Edit ▸").first()).toBeVisible();

        // --- The Playground knows which endpoint a model is routed to, so it
        // says so rather than letting the gateway refuse the request and
        // leaving the operator to guess which control was wrong.
        await page.route("**/v1/models", async (route) => {
          await route.fulfill({
            body: JSON.stringify({
              data: [{ id: seeded.virtualModelName }],
              object: "list",
            }),
            contentType: "application/json",
            headers: { "access-control-allow-origin": "*" },
            status: 200,
          });
        });
        await page.goto(`${baseUrl}/playground`, { waitUntil: "networkidle" });
        await page.getByLabel("API key", { exact: true }).fill("llmi_layout_probe_secret");
        await expect(page.getByLabel("Virtual model")).toHaveValue(seeded.virtualModelName);
        await expect(page.getByText("is routed to")).toHaveCount(0);
        await page.getByRole("button", { name: "messages", exact: true }).click();
        const mismatch = page.getByText("is routed to /v1/chat/completions");
        await expect(mismatch).toBeVisible();
        await expect(mismatch).toContainText("/v1/messages request for it is refused");
        await page.getByRole("button", { name: "chat_completions", exact: true }).click();
        await expect(page.getByText("is routed to")).toHaveCount(0);

        // --- A jump between modules carries the subject it was standing next
        // to: arriving unfiltered would make the operator pick the same key
        // again from a list that can be pages long.
        await page.goto(`${baseUrl}/api-keys?selected=${seeded.apiKeyId}`, {
          waitUntil: "networkidle",
        });
        await page.getByRole("link", { name: "→ Activity" }).click();
        await page.waitForURL((url) => url.pathname === "/activity");
        expect(new URL(page.url()).searchParams.get("apiKey")).toBe(seeded.apiKeyId);
        await expect(page.getByLabel("Filter by API key")).toHaveValue(seeded.apiKeyId);
        // The rows below are that key's, not every key's.
        await expect(page.locator("a[href*='request=']").first()).toContainText(seeded.apiKeyName);

        await page.goto(`${baseUrl}/api-keys?selected=${seeded.apiKeyId}`, {
          waitUntil: "networkidle",
        });
        await page.getByRole("link", { name: "edit → Limits" }).click();
        await page.waitForURL((url) => url.pathname === "/limits");
        expect(new URL(page.url()).searchParams.get("selected")).toBe(seeded.apiKeyId);
        // The key's own rules are open, not the list of every key's.
        await expect(page.getByLabel("Filter by API key name")).toHaveValue(seeded.apiKeyName);
        await expect(page.getByText("RULES", { exact: true })).toBeVisible();

        // --- Below the desktop target the module row scrolls; every module
        // stays reachable without a menu.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(baseUrl, { waitUntil: "networkidle" });
        const nav = page.getByRole("navigation", { name: "Console modules" });
        await expect(nav).toBeVisible();
        const apiKeysLink = nav.getByRole("link", { name: "API Keys", exact: true });
        await apiKeysLink.scrollIntoViewIfNeeded();
        await apiKeysLink.click();
        await page.waitForURL((url) => url.pathname === "/api-keys");
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
