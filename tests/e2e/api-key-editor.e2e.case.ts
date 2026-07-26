import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
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

/** Enough virtual models that the grants browser has to page. */
const MODEL_COUNT = 11;
const PAGE_SIZE = 8;

async function seedVirtualModels(databaseUrl: string): Promise<string[]> {
  const names = Array.from({ length: MODEL_COUNT }, (_, index) =>
    index === 0 ? "editor-solo-vm" : `editor-bulk-vm-${String(index).padStart(2, "0")}`,
  );
  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    for (const name of names) {
      const virtualModelId = randomUUID();
      await client.query(
        `insert into virtual_models (id, name, description, enabled) values ($1, $2, $3, true)`,
        [virtualModelId, name, `${name} description`],
      );
      await client.query(
        `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
         values ($1, $2, 'fixed', 'chat_completions')`,
        [randomUUID(), virtualModelId],
      );
    }
  });
  return names;
}

test("the API key editor browses grants, keeps the typed name, and saves the limit switches it shows", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_api_key_editor_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const names = await seedVirtualModels(fixture.databaseUrl);

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
        await page.goto(`${baseUrl}/api-keys?dialog=new`, { waitUntil: "networkidle" });

        const dialog = page.getByRole("dialog", { name: "New API Key" });
        await expect(dialog).toBeVisible();

        // --- The browser pages rather than listing every model between the
        // name and the limits.
        await expect(dialog.getByText(`1–${PAGE_SIZE} of ${MODEL_COUNT}`)).toBeVisible();
        await expect(dialog.getByRole("link", { name: /^Grant / })).toHaveCount(PAGE_SIZE);
        const lastName = names[names.length - 1] as string;
        await expect(dialog.getByRole("link", { name: `Grant ${lastName}` })).toHaveCount(0);
        await dialog.getByRole("link", { name: "Next page of models" }).click();
        await page.waitForURL((url) => url.searchParams.get("grantPage") === "2");
        await expect(dialog.getByText(`9–${MODEL_COUNT} of ${MODEL_COUNT}`)).toBeVisible();
        await expect(dialog.getByRole("link", { name: `Grant ${lastName}` })).toBeVisible();

        // --- The name is typed before any of that and has to survive it: every
        // filter click re-renders the dialog from the server.
        await page.getByLabel("API key name").fill("editor-probe-key");
        await dialog.getByLabel("Search virtual models").fill("solo");
        await page.waitForURL((url) => url.searchParams.get("grantQuery") === "solo");
        await expect(page.getByLabel("API key name")).toHaveValue("editor-probe-key");
        await expect(dialog.getByRole("link", { name: /^Grant / })).toHaveCount(1);
        await expect(dialog.getByText("1–1 of 1")).toBeVisible();

        await dialog.getByRole("link", { name: "Grant editor-solo-vm" }).click();
        await page.waitForURL((url) => url.searchParams.get("grantIds") !== null);
        await expect(page.getByLabel("API key name")).toHaveValue("editor-probe-key");

        // --- Show: granted only / not granted narrow the same list.
        await dialog.getByLabel("Filter virtual models by grant").selectOption("ungranted");
        await page.waitForURL((url) => url.searchParams.get("grantShow") === "ungranted");
        await expect(dialog.getByRole("link", { name: "Revoke editor-solo-vm" })).toHaveCount(0);
        await dialog.getByLabel("Filter virtual models by grant").selectOption("granted");
        await page.waitForURL((url) => url.searchParams.get("grantShow") === "granted");
        await expect(dialog.getByRole("link", { name: "Revoke editor-solo-vm" })).toBeVisible();

        // --- The limits the dialog shows are the limits it saves: enforcement
        // is a real choice here, not a hidden field that always says block.
        await dialog.getByLabel("Enforcement policy").selectOption("warn_only");
        await dialog.getByLabel("Budget period").selectOption("week");
        await page.getByRole("button", { name: "Create key" }).click();
        await expect(page.getByText("SECRET · SHOWN ONCE")).toBeVisible();

        const withLimits = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client.query<{ enforcement_policy: string; limits_enabled: boolean; period: string }>(
            `select api_keys.limits_enabled, api_key_limits.enforcement_policy, api_key_limits.period
             from api_keys
             join api_key_limits on api_key_limits.api_key_id = api_keys.id
             where api_keys.name = 'editor-probe-key' and api_key_limits.limit_type = 'budget'`,
          ),
        );
        expect(withLimits.rows[0]?.limits_enabled).toBe(true);
        expect(withLimits.rows[0]?.enforcement_policy).toBe("warn_only");
        expect(withLimits.rows[0]?.period).toBe("week");

        // --- ENABLE LIMITS is a checkbox: unchecked posts nothing, which the
        // route reads as off, and the key is created with no rules at all.
        await page.goto(`${baseUrl}/api-keys?dialog=new`, { waitUntil: "networkidle" });
        // Whatever the first page offers: this run is about the limits switch.
        await page
          .getByRole("link", { name: /^Grant / })
          .first()
          .click();
        await page.waitForURL((url) => url.searchParams.get("grantIds") !== null);
        await page.getByLabel("API key name").fill("editor-unlimited-key");
        await page.getByLabel("Enable limits").uncheck();
        await page.getByRole("button", { name: "Create key" }).click();
        await expect(page.getByText("SECRET · SHOWN ONCE")).toBeVisible();
        await expect(page.getByText("no rules — unlimited")).toBeVisible();

        const unlimited = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client.query<{ limits_enabled: boolean; rules: string }>(
            `select api_keys.limits_enabled,
                    (select count(*) from api_key_limits where api_key_id = api_keys.id)::text as rules
             from api_keys where api_keys.name = 'editor-unlimited-key'`,
          ),
        );
        expect(unlimited.rows[0]?.limits_enabled).toBe(false);
        expect(unlimited.rows[0]?.rules).toBe("0");

        // --- Closing the editor leaves nothing of the draft behind: the
        // browser's own filters are not the list's filters.
        await page.goto(`${baseUrl}/api-keys?dialog=new&grantQuery=solo&grantShow=granted`, {
          waitUntil: "networkidle",
        });
        await page.getByRole("link", { name: "Cancel" }).click();
        await page.waitForURL((url) => url.searchParams.get("dialog") === null);
        const closed = new URL(page.url());
        for (const param of ["grantQuery", "grantShow", "grantPage", "grantIds", "editor_name"]) {
          expect(closed.searchParams.get(param), param).toBeNull();
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
