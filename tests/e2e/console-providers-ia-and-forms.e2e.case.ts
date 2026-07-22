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

const MODEL_COUNT = 60;

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

// Seeds a provider with 60 models (the shape that rendered an 8500px page),
// plus api_keys so the ApiKeys KPI cards carry real values on mobile.
async function seedIaData(databaseUrl: string) {
  const providerId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, enabled)
       values ($1, 'api_key', 'ia-probe-provider', 'IA Probe Provider', true)`,
      [providerId],
    );
    for (let i = 0; i < MODEL_COUNT; i++) {
      await client.query(
        `insert into provider_models (id, provider_id, model_id, display_name)
         values ($1, $2, $3, $4)`,
        [
          randomUUID(),
          providerId,
          i === 0 ? "ia-needle-model" : `ia-model-${String(i).padStart(3, "0")}`,
          i === 0 ? "IA Needle Model" : `IA Model ${i}`,
        ],
      );
    }
    for (let i = 0; i < 3; i++) {
      await client.query(
        `insert into api_keys (id, name, key_prefix, key_hash, enabled)
         values ($1, $2, $3, $4, true)`,
        [randomUUID(), `ia-probe-api-key-${i}`, `llmi_ia_probe_${i}`, `test-hash-${i}`],
      );
    }
  });
  return providerId;
}

test("providers page shows one provider representation with a searchable capped model library; api_keys KPIs and settings forms behave on mobile", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_ia_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const providerId = await seedIaData(fixture.databaseUrl);

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

        // --- Providers: no duplicate card grid; the list is the single
        // representation and the model library is capped and searchable.
        await page.goto(`${baseUrl}/providers`, { waitUntil: "networkidle" });
        await expect(page.locator(".provider-card-grid")).toHaveCount(0);
        await expect(page.locator(".provider-summary-card")).toHaveCount(0);
        const hydrationErrors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error" && message.text().includes("Hydration failed")) {
            hydrationErrors.push(message.text());
          }
        });
        await expect(
          page.locator(".providers-list-card tr", { hasText: "IA Probe Provider" }).first(),
        ).toBeVisible();

        // Collapsed list renders no model library; selecting the provider does.
        await expect(page.locator(".model-library-card")).toHaveCount(0);
        await page.goto(`${baseUrl}/providers?selected=${providerId}`, {
          waitUntil: "networkidle",
        });
        const libraryRows = page.locator(".model-library-table tbody tr");
        await expect(libraryRows).toHaveCount(50);
        const modelPagination = page.getByRole("navigation", { name: "Model pages" });
        await expect(modelPagination).toHaveClass(/list-pagination/);
        await expect(modelPagination.locator(".list-pagination-summary strong")).toHaveText(
          "Page 1 of 2",
        );
        await expect(modelPagination.locator(".list-pagination-range")).toHaveText(
          `${MODEL_COUNT} models`,
        );
        await expect(modelPagination.getByRole("button", { name: "Previous page" })).toBeDisabled();
        await modelPagination.getByRole("link", { name: "Next page" }).click();
        await expect(page).toHaveURL(`${baseUrl}/providers?selected=${providerId}&modelPage=2`);
        await expect(libraryRows).toHaveCount(10);
        await expect(modelPagination.locator(".list-pagination-summary strong")).toHaveText(
          "Page 2 of 2",
        );
        await modelPagination.getByRole("link", { name: "Previous page" }).click();
        await expect(page).toHaveURL(`${baseUrl}/providers?selected=${providerId}`);
        await expect(libraryRows).toHaveCount(50);

        await page.goto(`${baseUrl}/providers?selected=${providerId}&modelQuery=ia-needle`, {
          waitUntil: "networkidle",
        });
        await expect(libraryRows).toHaveCount(1);
        await expect(libraryRows.first()).toContainText("ia-needle-model");
        expect(new URL(page.url()).searchParams.get("modelQuery")).toBe("ia-needle");
        expect(hydrationErrors).toEqual([]);

        // The page no longer balloons to thousands of pixels.
        const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        expect(pageHeight).toBeLessThan(4500);

        // Saving a Provider API key stays on the Providers page and reveals
        // the one-time plaintext in a modal instead of navigating away.
        const addApiKey = page.getByRole("link", { name: "Add API key" });
        await expect(addApiKey).toHaveCount(1);
        await addApiKey.click();
        const createKeyDialog = page.getByRole("dialog", {
          name: "New IA Probe Provider API key",
        });
        await expect(createKeyDialog).toBeVisible();
        await createKeyDialog.getByLabel("Provider API key").fill("provider-key-dialog-e2e");
        await createKeyDialog.getByLabel("Label").fill("E2E key");
        await createKeyDialog.getByRole("button", { name: "Save" }).click();

        const savedKeyDialog = page.getByRole("dialog", { name: "Provider API key saved" });
        await expect(savedKeyDialog).toBeVisible();
        await expect(
          page.getByRole("heading", { level: 1, name: "Providers & Models", exact: true }),
        ).toBeVisible();
        await expect(savedKeyDialog.getByLabel("Provider API key")).toHaveValue(
          "provider-key-dialog-e2e",
        );
        await savedKeyDialog.getByRole("link", { name: "Close" }).click();
        await expect(savedKeyDialog).toHaveCount(0);

        await page.goto(
          `${baseUrl}/providers?selected=${providerId}&providerDelete=${providerId}`,
          {
            waitUntil: "networkidle",
          },
        );
        const deleteProviderDialog = page.getByRole("dialog", { name: "Delete provider?" });
        await expect(deleteProviderDialog).toBeVisible();
        await addProviderDeleteRaceBlocker(fixture.databaseUrl, providerId);
        await deleteProviderDialog.getByRole("button", { name: "Delete provider" }).click();
        await expect(page).toHaveURL(
          `${baseUrl}/providers?selected=${providerId}&providerDelete=${providerId}`,
        );
        await expect(
          deleteProviderDialog.getByText("Provider is still used by active route policies."),
        ).toBeVisible();

        // --- ApiKeys KPIs on mobile: two columns, no truncated values.
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${baseUrl}/api-keys`, { waitUntil: "networkidle" });
        const columns = await page
          .locator(".api-keys-stat-grid")
          .evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
        expect(columns).toBe(2);
        const truncated = await page
          .locator(".api-keys-stat-grid .stat-card-value")
          .evaluateAll((els) => els.filter((el) => el.scrollWidth > el.clientWidth).length);
        expect(truncated).toBe(0);

        // --- Virtual model dialog: create mode says Create.
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`${baseUrl}/models?virtualModelDialog=new`, {
          waitUntil: "networkidle",
        });
        await expect(page.locator(".vm-dialog-actions button[type=submit]")).toHaveText("Create");
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

test("provider create dialog shows registry-derived supported endpoints", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_endpoints_${randomUUID().replaceAll("-", "_")}`,
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
        await page.setViewportSize({ width: 1280, height: 900 });
        await signInFromFirstRun(page, baseUrl);
        await page.goto(`${baseUrl}/providers?providerDialog=new`, { waitUntil: "networkidle" });

        const dialog = page.getByRole("dialog", { name: "Add Provider" });
        await expect(dialog).toBeVisible();

        const endpointChips = dialog.locator(".provider-supported-endpoints .tag-chip");
        // OpenAI is the default direct choice: Chat Completions + Responses, never Messages.
        await expect(endpointChips).toHaveText(["Chat Completions", "Responses"]);
        await expect(endpointChips.filter({ hasText: "Messages" })).toHaveCount(0);

        // Switch to the Claude Code subscription template: Messages only.
        await dialog.getByRole("tab", { name: "Subscription" }).click();
        await dialog
          .getByLabel("Provider type", { exact: true })
          .selectOption({ label: "Claude Code" });
        await expect(endpointChips).toHaveText(["Messages"]);

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

test("Add Provider API Keys group carries the Batch 1 GLM, Qwen, and Kimi paste-key templates", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_batch1_${randomUUID().replaceAll("-", "_")}`,
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
        await page.setViewportSize({ width: 1280, height: 900 });
        await signInFromFirstRun(page, baseUrl);
        await page.goto(`${baseUrl}/providers?providerDialog=new`, { waitUntil: "networkidle" });

        const dialog = page.getByRole("dialog", { name: "Add Provider" });
        await expect(dialog).toBeVisible();

        // Both new providers live in the API Keys template group (remote_api_key),
        // which uses the editable paste-key base URL, never the local-private mode.
        await dialog.getByRole("tab", { name: "API Keys" }).click();
        const providerType = dialog.getByLabel("Provider type", { exact: true });
        const baseUrlField = dialog.getByLabel("Provider base URL", { exact: true });
        const endpointChips = dialog.locator(".provider-supported-endpoints .tag-chip");

        // GLM Coding Plan: /api/coding/paas/v4 base, OpenAI chat_completions only.
        await providerType.selectOption({ label: "GLM Coding Plan" });
        await expect(baseUrlField).toHaveValue("https://api.z.ai/api/coding/paas/v4");
        await expect(endpointChips).toHaveText(["Chat Completions"]);

        // Qwen Token Plan: token-plan base, chat_completions only (no Responses).
        await providerType.selectOption({ label: "Qwen Token Plan" });
        await expect(baseUrlField).toHaveValue(
          "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
        );
        await expect(endpointChips).toHaveText(["Chat Completions"]);

        // Kimi Coding Plan: /coding/v1 base (Anthropic protocol), Messages only.
        await providerType.selectOption({ label: "Kimi Coding Plan" });
        await expect(baseUrlField).toHaveValue("https://api.kimi.com/coding/v1");
        await expect(endpointChips).toHaveText(["Messages"]);

        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await overflowPx(page), `${viewport.width}px`).toBeLessThanOrEqual(0);
        }

        // Creating one of the templates must land on a provider whose
        // credential section is the api_key paste branch — the "Add API key"
        // link whose dialog flow is exercised elsewhere in this suite.
        await page.setViewportSize({ width: 1280, height: 900 });
        await providerType.selectOption({ label: "Kimi Coding Plan" });
        await dialog
          .getByLabel("Provider display name", { exact: true })
          .fill("Kimi Coding Plan E2E");
        await dialog.locator("button[type=submit]").click();
        await expect(page.getByRole("dialog", { name: "Add Provider" })).toHaveCount(0);
        // Create redirects to the bare /providers list (rows collapsed);
        // expanding the new row reveals the api_key credential section.
        await page
          .locator(".providers-table a.table-row-link", { hasText: "Kimi Coding Plan E2E" })
          .first()
          .click();
        await expect(page.getByRole("link", { name: "Add API key" })).toHaveCount(1);
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

async function addProviderDeleteRaceBlocker(databaseUrl: string, providerId: string) {
  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    const providerModel = await client.query<{ id: string }>(
      "select id::text from provider_models where provider_id = $1 order by model_id limit 1",
      [providerId],
    );
    const providerModelId = providerModel.rows[0]?.id;
    if (!providerModelId) {
      throw new Error("Provider model is required for delete race fixture.");
    }
    const virtualModelId = randomUUID();
    const routePolicyId = randomUUID();
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, $2, 'Provider delete race', true)`,
      [virtualModelId, `provider-delete-race-${virtualModelId}`],
    );
    await client.query(
      `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
       values ($1, $2, 'fixed', 'chat_completions')`,
      [routePolicyId, virtualModelId],
    );
    await client.query(
      `insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
       values ($1, $2, $3, 1)`,
      [randomUUID(), routePolicyId, providerModelId],
    );
  });
}
