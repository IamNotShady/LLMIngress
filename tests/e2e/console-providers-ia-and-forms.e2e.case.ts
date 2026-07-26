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

/**
 * Open the Add Provider dialog on a template and read back what the registry
 * says about it: the default base url and the endpoint protocols it serves.
 */
async function readTemplate(
  page: import("@playwright/test").Page,
  baseUrl: string,
  group: "API Keys" | "Local" | "Subscription",
  templateName: string,
): Promise<{ baseUrlValue: string; endpoints: string[] }> {
  await page.goto(`${baseUrl}/providers?dialog=new`, { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog", { name: "Add Provider" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: group, exact: true }).click();
  await dialog.getByRole("link", { name: templateName, exact: true }).click();
  await expect(dialog.getByRole("link", { name: templateName, exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const endpoints = await dialog
    .locator('[aria-label="Supported endpoints"] > li > span:first-child')
    .allInnerTexts();
  return {
    baseUrlValue: await dialog.getByLabel("Provider base URL").inputValue(),
    endpoints,
  };
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

        const hydrationErrors: string[] = [];
        page.on("console", (message) => {
          if (message.type() === "error" && message.text().includes("Hydration failed")) {
            hydrationErrors.push(message.text());
          }
        });

        // --- Providers: the list and its detail are the only representation.
        await page.goto(`${baseUrl}/providers`, { waitUntil: "networkidle" });
        await expect(page.getByRole("link", { name: /IA Probe Provider/ }).first()).toBeVisible();

        // The model library is paged on the server: the header count and the
        // range share one denominator, and the query runs in the URL.
        await page.goto(`${baseUrl}/providers?selected=${providerId}&modelPageSize=50`, {
          waitUntil: "networkidle",
        });
        await expect(page.getByText(`${MODEL_COUNT} matching`)).toBeVisible();
        await expect(page.getByText(`1–50 of ${MODEL_COUNT}`)).toBeVisible();
        await page.getByRole("link", { name: "Next →" }).click();
        await expect(page.getByText(`51–${MODEL_COUNT} of ${MODEL_COUNT}`)).toBeVisible();

        await page.goto(`${baseUrl}/providers?selected=${providerId}&modelQuery=ia-needle`, {
          waitUntil: "networkidle",
        });
        // One page of results states its count and drops the pager.
        await expect(page.getByText("1 matching")).toBeVisible();
        await expect(page.getByText("1–1 of 1")).toHaveCount(0);
        await expect(page.getByText("ia-needle-model")).toBeVisible();
        expect(new URL(page.url()).searchParams.get("modelQuery")).toBe("ia-needle");
        expect(hydrationErrors).toEqual([]);

        // A search that matches nothing says so and hides the pagination.
        await page.goto(
          `${baseUrl}/providers?selected=${providerId}&modelQuery=nothing-matches-this`,
          { waitUntil: "networkidle" },
        );
        await expect(
          page.getByText("No models match this search and availability filter."),
        ).toBeVisible();
        await expect(page.getByText(/of \d+$/)).toHaveCount(0);

        // The page does not balloon to thousands of pixels.
        const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
        expect(pageHeight).toBeLessThan(4500);

        // --- A route created after the confirm was opened still refuses the
        // delete, and the refusal is stated in the dialog rather than replacing
        // the page with an error body.
        await page.goto(`${baseUrl}/providers?selected=${providerId}&dialog=delete`, {
          waitUntil: "networkidle",
        });
        const deleteDialog = page.getByRole("dialog", { name: "Delete provider" });
        await expect(deleteDialog).toBeVisible();
        await deleteDialog
          .getByLabel("TYPE THE PROVIDER NAME TO CONFIRM")
          .fill("IA Probe Provider");
        await addProviderDeleteRaceBlocker(fixture.databaseUrl, providerId);
        await deleteDialog.getByRole("button", { name: "Delete provider" }).click();
        await expect(
          deleteDialog.getByText("Provider is still used by active route policies."),
        ).toBeVisible();

        // Reopened, the confirm knows about the route and does not offer a
        // delete it cannot carry out.
        await page.goto(`${baseUrl}/providers?selected=${providerId}&dialog=delete`, {
          waitUntil: "networkidle",
        });
        await expect(deleteDialog).toContainText("would be refused");
        await expect(deleteDialog.getByRole("button", { name: "Delete provider" })).toHaveCount(0);

        // --- The virtual model editor says Create when creating.
        await page.goto(`${baseUrl}/models?dialog=new`, { waitUntil: "networkidle" });
        await expect(page.getByRole("button", { name: "Create virtual model" })).toBeVisible();
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
        // OpenAI serves chat completions and responses, never messages.
        const openai = await readTemplate(page, baseUrl, "API Keys", "OpenAI");
        expect(openai.endpoints).toEqual(["chat_completions", "responses"]);
        expect(openai.endpoints).not.toContain("messages");

        // The Claude Code subscription serves messages only.
        const claudeCode = await readTemplate(page, baseUrl, "Subscription", "Claude Code");
        expect(claudeCode.endpoints).toEqual(["messages"]);

        // The chip states the protocol and the path it maps to, so a route can
        // be checked against the provider without leaving the dialog.
        const dialog = page.getByRole("dialog", { name: "Add Provider" });
        await expect(dialog.getByText("POST /v1/messages")).toBeVisible();

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
        {
          const template = await readTemplate(page, baseUrl, "API Keys", "GLM Coding Plan");
          expect(template.baseUrlValue, "GLM Coding Plan").toBe(
            "https://api.z.ai/api/coding/paas/v4",
          );
          expect(template.endpoints, "GLM Coding Plan").toEqual(["chat_completions"]);
        }
        {
          const template = await readTemplate(page, baseUrl, "API Keys", "Qwen Token Plan");
          expect(template.baseUrlValue, "Qwen Token Plan").toBe(
            "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
          );
          expect(template.endpoints, "Qwen Token Plan").toEqual(["chat_completions"]);
        }
        {
          const template = await readTemplate(page, baseUrl, "API Keys", "Kimi Coding Plan");
          expect(template.baseUrlValue, "Kimi Coding Plan").toBe("https://api.kimi.com/coding/v1");
          expect(template.endpoints, "Kimi Coding Plan").toEqual(["messages"]);
        }

        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await overflowPx(page), `${viewport.width}px`).toBeLessThanOrEqual(0);
        }

        // Creating one of the templates lands on a provider whose credential
        // section is the api_key paste branch.
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.goto(`${baseUrl}/providers?dialog=new`, { waitUntil: "networkidle" });
        const createDialog = page.getByRole("dialog", { name: "Add Provider" });
        await createDialog.getByRole("tab", { name: "API Keys", exact: true }).click();
        await createDialog.getByRole("link", { name: "Kimi Coding Plan", exact: true }).click();
        await createDialog.getByLabel("Provider display name").fill("Kimi Coding Plan E2E");
        await createDialog.getByRole("button", { name: "Create" }).click();
        await expect(page.getByRole("dialog", { name: "Add Provider" })).toHaveCount(0);
        await page
          .getByRole("link", { name: /Kimi Coding Plan E2E/ })
          .first()
          .click();
        await expect(page.getByRole("link", { name: "+ Add key" })).toBeVisible();

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

        // Each Batch 3 provider lives in the API Keys group with an editable
        // paste-key base url, and serves exactly the protocols the registry
        // declares — in registry endpoint-key order.
        for (const template of [
          {
            baseUrl: "https://api.commandcode.ai/provider/v1",
            endpoints: ["chat_completions", "messages"],
            label: "Command Code",
          },
          {
            baseUrl: "https://inference-api.nousresearch.com/v1",
            endpoints: ["chat_completions"],
            label: "NousResearch",
          },
          {
            baseUrl: "https://api.cline.bot/api/v1",
            endpoints: ["chat_completions"],
            label: "ClinePass",
          },
          {
            baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
            endpoints: ["chat_completions"],
            label: "BytePlus ModelArk",
          },
        ]) {
          const read = await readTemplate(page, baseUrl, "API Keys", template.label);
          expect(read.baseUrlValue, template.label).toBe(template.baseUrl);
          expect(read.endpoints, template.label).toEqual(template.endpoints);
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
        // All seven Batch 4 inference clouds live in the API Keys template group
        // (remote_api_key), the editable paste-key base URL mode, each OpenAI
        // chat_completions-only (a single Chat Completions chip).
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
          const read = await readTemplate(page, baseUrl, "API Keys", template.label);
          expect(read.baseUrlValue, template.label).toBe(template.baseUrl);
          expect(read.endpoints, template.label).toEqual(["chat_completions"]);
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

test("Add Provider API Keys group carries the Batch 5 token-plan templates", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_batch5_${randomUUID().replaceAll("-", "_")}`,
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
        {
          const template = await readTemplate(page, baseUrl, "API Keys", "OpenCode Go");
          expect(template.baseUrlValue, "OpenCode Go").toBe("https://opencode.ai/zen/go/v1");
          expect(template.endpoints, "OpenCode Go").toEqual(["chat_completions", "messages"]);
        }
        {
          const template = await readTemplate(page, baseUrl, "API Keys", "Xiaomi MiMo Token Plan");
          expect(template.baseUrlValue, "Xiaomi MiMo Token Plan").toBe(
            "https://token-plan-sgp.xiaomimimo.com/v1",
          );
          expect(template.endpoints, "Xiaomi MiMo Token Plan").toEqual(["chat_completions"]);
        }
        {
          const template = await readTemplate(page, baseUrl, "API Keys", "Mistral Vibe");
          expect(template.baseUrlValue, "Mistral Vibe").toBe("https://api.mistral.ai/v1");
          expect(template.endpoints, "Mistral Vibe").toEqual(["chat_completions"]);
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

test("Add Provider API Keys group carries the Batch 7 bedrock template", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_batch7_${randomUUID().replaceAll("-", "_")}`,
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
        {
          const template = await readTemplate(page, baseUrl, "API Keys", "AWS Bedrock");
          expect(template.baseUrlValue, "AWS Bedrock").toBe(
            "https://bedrock-mantle.us-east-1.api.aws/v1",
          );
          expect(template.endpoints, "AWS Bedrock").toEqual(["chat_completions"]);
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

        const dialog = page.getByRole("dialog", { name: "Authorize token" });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByLabel("enter this code at the provider")).toHaveText("WDJB-MJHT");
        // The url is printed so it can be read before it is followed, and one
        // button opens it and takes the code along.
        await expect(dialog.getByText("https://platform.minimax.io/oauth-authorize")).toBeVisible();
        await expect(dialog.getByRole("button", { name: "Open · copy code" })).toBeVisible();

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

        // The authorization-code dialog links out to the authorization page so
        // it never has to be copied by hand.
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
        const codeDialog = page.getByRole("dialog", { name: "Authorize token" });
        await expect(codeDialog).toBeVisible();
        await expect(codeDialog.getByRole("link", { name: "Open in browser" })).toHaveAttribute(
          "href",
          authorizeUrl,
        );
        // The url is shown so it can be checked before it is followed, and the
        // callback value is pasted back in the same dialog.
        await expect(codeDialog.getByText(authorizeUrl)).toBeVisible();
        await expect(codeDialog.getByLabel("CALLBACK VALUE")).toBeVisible();
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

        const dialog = page.getByRole("dialog", { name: "Authorize token" });
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

test("Grok subscription: a Chat Completions chip in the Subscription group and an authorization-code dialog linking to auth.x.ai", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_grok_${randomUUID().replaceAll("-", "_")}`,
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

        // --- Add Provider: Grok lives in the Subscription group with a single
        // Chat Completions chip (Feature A ships only the chat face).
        const grok = await readTemplate(page, baseUrl, "Subscription", "Grok");
        expect(grok.endpoints).toEqual(["chat_completions", "responses"]);
        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(await overflowPx(page), `add-dialog ${viewport.width}px`).toBeLessThanOrEqual(0);
        }

        // --- Grok is a popup authorization-code provider: the dialog links out to
        // auth.x.ai instead of printing the URL, and offers the callback paste box
        // (donor: the claude_code authorization-code half).
        await page.setViewportSize({ width: 1280, height: 900 });
        const grokProviderId = randomUUID();
        await withDedicatedPostgresClient(fixture.databaseUrl, async (client) => {
          await client.query(
            `insert into providers (id, provider_type, provider_key, display_name, enabled)
             values ($1, 'subscription', 'grok', 'Grok', true)`,
            [grokProviderId],
          );
        });
        const authorizeUrl =
          "https://auth.x.ai/oauth2/authorize?client_id=b1a00492-073a-47ea-816f-4c329264a828&state=abc";
        await page.goto(
          `${baseUrl}/providers?selected=${grokProviderId}` +
            `&providerKeyDialog=${grokProviderId}` +
            `&providerOAuthId=${randomUUID()}` +
            `&providerAuthorizeUrl=${encodeURIComponent(authorizeUrl)}`,
          { waitUntil: "networkidle" },
        );
        const codeDialog = page.getByRole("dialog", { name: "Authorize token" });
        await expect(codeDialog).toBeVisible();
        await expect(codeDialog.getByRole("link", { name: "Open in browser" })).toHaveAttribute(
          "href",
          authorizeUrl,
        );
        // The url is shown so it can be checked before it is followed, and the
        // callback value is pasted back in the same dialog.
        await expect(codeDialog.getByText(authorizeUrl)).toBeVisible();
        await expect(codeDialog.getByLabel("CALLBACK VALUE")).toBeVisible();
        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          expect(
            await overflowPx(page),
            `grok-code-dialog ${viewport.width}px`,
          ).toBeLessThanOrEqual(0);
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

test("a refused form states why in the dialog it was submitted from", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_form_refusal_${randomUUID().replaceAll("-", "_")}`,
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

        // --- Editing a provider: an unusable base url is refused, and the
        // refusal belongs in the dialog. Closing it silently would look like
        // the save worked, and navigating to the error body would lose the
        // form the operator was filling in.
        await page.goto(`${baseUrl}/providers?selected=${providerId}&dialog=edit`, {
          waitUntil: "networkidle",
        });
        const editDialog = page.getByRole("dialog", { name: "Edit provider" });
        await editDialog.getByLabel(/BASE URL/).fill("not-a-url");
        await editDialog.getByRole("button", { name: /Save/ }).click();

        await expect(editDialog.getByRole("alert")).toBeVisible();
        await expect(page).toHaveURL(/dialog=edit/);
        await expect(editDialog.getByLabel(/BASE URL/)).toHaveValue("not-a-url");
        // Nothing was written: the provider still has the base url it had.
        const stored = await fixture.query<{ base_url: string | null }>(
          "select base_url from providers where id = $1",
          [providerId],
        );
        expect(stored.rows[0]?.base_url).not.toBe("not-a-url");

        // --- The same contract in the Limits drawer, whose rules are validated
        // in the database layer rather than by the browser.
        const apiKeyId = randomUUID();
        await fixture.query(
          `insert into api_keys (id, name, key_prefix, key_hash)
           values ($1, 'refusal-key', 'llmi_r…', gen_random_uuid()::text)`,
          [apiKeyId],
        );
        await page.goto(`${baseUrl}/limits?selected=${apiKeyId}`, { waitUntil: "networkidle" });
        const drawer = page.getByRole("dialog", { name: /refusal-key/ });
        await drawer
          .getByLabel(/BUDGET/)
          .first()
          .fill("0");
        await drawer.getByRole("button", { name: /Save/ }).click();

        await expect(drawer.getByRole("alert")).toBeVisible();
        await expect(drawer.getByRole("alert")).toContainText(/greater than zero/i);
        // The page is still the console, not the API's error body.
        await expect(page).toHaveURL(new RegExp(`${escapeRegExp(baseUrl)}/limits`));
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

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
