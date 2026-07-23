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
          // Row 1 mirrors real catalogs where the display name IS the model id,
          // pinning the single-line rendering of the model-id cell.
          i === 0 ? "IA Needle Model" : i === 1 ? "ia-model-001" : `IA Model ${i}`,
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

        // The mono id line renders only when it differs from the display name:
        // ia-model-001's display name IS its id, so its cell is a single line.
        await page.goto(`${baseUrl}/providers?selected=${providerId}&modelQuery=ia-model-001`, {
          waitUntil: "networkidle",
        });
        await expect(libraryRows).toHaveCount(1);
        const sameNameCell = libraryRows.first().locator(".model-id-cell");
        await expect(sameNameCell.locator("strong")).toHaveText("ia-model-001");
        await expect(sameNameCell.locator("small")).toHaveCount(0);
        // A distinct display name keeps the mono id line.
        await page.goto(`${baseUrl}/providers?selected=${providerId}&modelQuery=ia-model-002`, {
          waitUntil: "networkidle",
        });
        await expect(libraryRows).toHaveCount(1);
        await expect(libraryRows.first().locator(".model-id-cell small")).toHaveText(
          "ia-model-002",
        );

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

test("Add Provider API Keys group carries the Batch 3 paste-key templates", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_batch3_${randomUUID().replaceAll("-", "_")}`,
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

        // All four Batch 3 providers live in the API Keys template group
        // (remote_api_key), the editable paste-key base URL mode.
        await dialog.getByRole("tab", { name: "API Keys" }).click();
        const providerType = dialog.getByLabel("Provider type", { exact: true });
        const baseUrlField = dialog.getByLabel("Provider base URL", { exact: true });
        const endpointChips = dialog.locator(".provider-supported-endpoints .tag-chip");

        // Command Code: dual endpoints — Chat Completions + Messages chips, in
        // registry endpoint-key order, prefilled /provider/v1 base.
        await providerType.selectOption({ label: "Command Code" });
        await expect(baseUrlField).toHaveValue("https://api.commandcode.ai/provider/v1");
        await expect(endpointChips).toHaveText(["Chat Completions", "Messages"]);

        // NousResearch: OpenAI chat_completions only.
        await providerType.selectOption({ label: "NousResearch" });
        await expect(baseUrlField).toHaveValue("https://inference-api.nousresearch.com/v1");
        await expect(endpointChips).toHaveText(["Chat Completions"]);

        // ClinePass: OpenAI chat_completions only, /api/v1 base.
        await providerType.selectOption({ label: "ClinePass" });
        await expect(baseUrlField).toHaveValue("https://api.cline.bot/api/v1");
        await expect(endpointChips).toHaveText(["Chat Completions"]);

        // BytePlus ModelArk: OpenAI chat_completions only on the /v3 base
        // (chat-only; no Messages chip).
        await providerType.selectOption({ label: "BytePlus ModelArk" });
        await expect(baseUrlField).toHaveValue(
          "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
        );
        await expect(endpointChips).toHaveText(["Chat Completions"]);

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

test("Add Provider API Keys group carries the Batch 4 inference cloud templates", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_batch4_${randomUUID().replaceAll("-", "_")}`,
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

        // All seven Batch 4 inference clouds live in the API Keys template group
        // (remote_api_key), the editable paste-key base URL mode, each OpenAI
        // chat_completions-only (a single Chat Completions chip).
        await dialog.getByRole("tab", { name: "API Keys" }).click();
        const providerType = dialog.getByLabel("Provider type", { exact: true });
        const baseUrlField = dialog.getByLabel("Provider base URL", { exact: true });
        const endpointChips = dialog.locator(".provider-supported-endpoints .tag-chip");

        const batch4Templates = [
          { baseUrl: "https://api.groq.com/openai/v1", label: "Groq" },
          { baseUrl: "https://api.cerebras.ai/v1", label: "Cerebras" },
          { baseUrl: "https://api.fireworks.ai/inference/v1", label: "Fireworks AI" },
          { baseUrl: "https://api.mistral.ai/v1", label: "Mistral" },
          { baseUrl: "https://integrate.api.nvidia.com/v1", label: "NVIDIA NIM" },
          { baseUrl: "https://api.xiaomimimo.com/v1", label: "Xiaomi MiMo" },
          { baseUrl: "https://ollama.com/v1", label: "Ollama Cloud" },
        ];

        for (const template of batch4Templates) {
          await providerType.selectOption({ label: template.label });
          await expect(baseUrlField, template.label).toHaveValue(template.baseUrl);
          await expect(endpointChips, template.label).toHaveText(["Chat Completions"]);
        }

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

test("device-code provider shows the user code and polls to complete; the authorization-code dialog links out without printing the URL", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_device_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const providerId = randomUUID();
    await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
      await client.query(
        `insert into providers (id, provider_type, provider_key, display_name, enabled)
         values ($1, 'subscription', 'minimax_coding', 'MiniMax Coding Plan', true)`,
        [providerId],
      );
    });

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

        // Drive the device dialog straight from the start-redirect query params
        // (one-time semantics — no DB re-read). Poll is intercepted so no real
        // upstream is contacted: first pending, then complete.
        let pollCount = 0;
        await page.route("**/api/provider-oauth", async (route) => {
          pollCount += 1;
          await route.fulfill({
            body: JSON.stringify({ status: pollCount >= 2 ? "complete" : "pending" }),
            contentType: "application/json",
            status: 200,
          });
        });

        const oauthId = randomUUID();
        const dialogUrl =
          `${baseUrl}/providers?selected=${providerId}` +
          `&providerKeyDialog=${providerId}` +
          `&providerOAuthId=${oauthId}` +
          `&providerOAuthUserCode=WDJB-MJHT` +
          `&providerOAuthVerificationUri=${encodeURIComponent("https://platform.minimax.io/oauth-authorize")}` +
          `&providerOAuthInterval=1`;
        await page.goto(dialogUrl, { waitUntil: "networkidle" });

        const dialog = page.getByRole("dialog", { name: "Connect MiniMax Coding Plan" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel("Your code")).toHaveText("WDJB-MJHT");
        await expect(dialog.getByRole("link", { name: "Open verification page" })).toHaveAttribute(
          "href",
          "https://platform.minimax.io/oauth-authorize",
        );

        // The client polls (interval 1s) and, on the second reply, completes.
        await expect(dialog.getByText(/is connected/)).toBeVisible({ timeout: 15_000 });
        expect(pollCount).toBeGreaterThanOrEqual(2);

        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await overflowPx(page), `${viewport.width}px`).toBeLessThanOrEqual(0);
        }

        // The authorization-code dialog (claude_code) links out to the
        // authorization page instead of printing the long URL in a textarea.
        await page.setViewportSize({ width: 1280, height: 900 });
        const codeProviderId = randomUUID();
        await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
          await client.query(
            `insert into providers (id, provider_type, provider_key, display_name, enabled)
             values ($1, 'subscription', 'claude_code', 'Claude Code', true)`,
            [codeProviderId],
          );
        });
        const authorizeUrl = "https://claude.ai/oauth/authorize?client_id=e2e-client&state=abc";
        await page.goto(
          `${baseUrl}/providers?selected=${codeProviderId}` +
            `&providerKeyDialog=${codeProviderId}` +
            `&providerOAuthId=${randomUUID()}` +
            `&providerAuthorizeUrl=${encodeURIComponent(authorizeUrl)}`,
          { waitUntil: "networkidle" },
        );
        const codeDialog = page.getByRole("dialog", { name: "New Claude Code OAuth connection" });
        await expect(codeDialog).toBeVisible();
        await expect(
          codeDialog.getByRole("link", { name: "Open authorization URL" }),
        ).toHaveAttribute("href", authorizeUrl);
        await expect(codeDialog.locator("#provider-oauth-authorize-url")).toHaveCount(0);
        await expect(codeDialog.locator("#provider-oauth-callback-input")).toBeVisible();
        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await overflowPx(page), `code-dialog ${viewport.width}px`).toBeLessThanOrEqual(0);
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

test("device-code dialog surfaces the upstream error message and stops polling", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_device_err_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const providerId = randomUUID();
    await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
      await client.query(
        `insert into providers (id, provider_type, provider_key, display_name, enabled)
         values ($1, 'subscription', 'minimax_coding', 'MiniMax Coding Plan', true)`,
        [providerId],
      );
    });

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

        let pollCount = 0;
        await page.route("**/api/provider-oauth", async (route) => {
          pollCount += 1;
          await route.fulfill({
            body: JSON.stringify({
              message: "The authorization was denied upstream.",
              status: "error",
            }),
            contentType: "application/json",
            status: 200,
          });
        });

        const oauthId = randomUUID();
        await page.goto(
          `${baseUrl}/providers?selected=${providerId}` +
            `&providerKeyDialog=${providerId}` +
            `&providerOAuthId=${oauthId}` +
            `&providerOAuthUserCode=ZZZZ-9999` +
            `&providerOAuthVerificationUri=${encodeURIComponent("https://platform.minimax.io/oauth-authorize")}` +
            `&providerOAuthInterval=1`,
          { waitUntil: "networkidle" },
        );

        const dialog = page.getByRole("dialog", { name: "Connect MiniMax Coding Plan" });
        await expect(dialog).toBeVisible();
        // The concrete upstream message is shown, not a generic fallback.
        await expect(dialog.getByText("The authorization was denied upstream.")).toBeVisible({
          timeout: 15_000,
        });

        // Polling stops after the error (a single poll, no further calls).
        const seen = pollCount;
        await page.waitForTimeout(2500);
        expect(pollCount).toBe(seen);
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
