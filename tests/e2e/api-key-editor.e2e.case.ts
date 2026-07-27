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

        // --- A refused creation comes back as the dialog, holding what was
        // typed. Creating cannot post through the in-place path — its success
        // response is the one-time secret — so the whole draft travels in the
        // URL, and losing it means retyping six fields to fix one.
        await page.goto(`${baseUrl}/api-keys?dialog=new`, { waitUntil: "networkidle" });
        await page
          .getByRole("link", { name: /^Grant / })
          .first()
          .click();
        await page.waitForURL((url) => url.searchParams.get("grantIds") !== null);
        await page.getByLabel("API key name").fill("editor-refused-key");
        await page.getByLabel("Budget USD", { exact: true }).fill("not-a-number");
        await page.getByLabel("Enforcement policy").selectOption("warn_only");
        await page.getByRole("textbox", { name: "RPM", exact: false }).fill("777");
        await page.getByRole("button", { name: "Create key" }).click();

        const refusedDialog = page.getByRole("dialog", { name: "New API Key" });
        await expect(refusedDialog.getByRole("alert")).toBeVisible();
        await expect(page.getByLabel("API key name")).toHaveValue("editor-refused-key");
        await expect(page.getByRole("textbox", { name: "RPM", exact: false })).toHaveValue("777");
        await expect(page.getByLabel("Enforcement policy")).toHaveValue("warn_only");
        await expect(refusedDialog.getByRole("link", { name: /^Revoke / })).toHaveCount(1);
        // Nothing was created under the name that was refused.
        const refused = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client.query(`select 1 from api_keys where name = 'editor-refused-key'`),
        );
        expect(refused.rows).toEqual([]);

        // --- Revoking a grant has to mean revoking it. What the operator
        // unchecked travels in the URL, and an empty parameter cannot say
        // "none" — the last revocation used to read as "the URL said nothing"
        // and hand back every grant the key already had.
        const probe = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client.query<{ id: string }>(
            `select id::text as id from api_keys where name = 'editor-probe-key'`,
          ),
        );
        const probeId = probe.rows[0]?.id as string;
        const editorUrl = (query = "") =>
          `${baseUrl}/api-keys?selected=${probeId}&dialog=edit${query}`;
        const editor = page.getByRole("dialog", { name: "Edit API key" });
        const savedAccess = () =>
          withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
            client.query<{ default_name: string | null; grants: number }>(
              `select (select count(*)::integer from api_key_virtual_models
                       where api_key_id = api_keys.id) as grants,
                      (select name from virtual_models
                       where id = api_keys.default_virtual_model_id) as default_name
               from api_keys where id = $1`,
              [probeId],
            ),
          );

        await page.goto(editorUrl("&grantQuery=bulk-vm-01"), { waitUntil: "networkidle" });
        await expect(editor).toBeVisible();
        await editor.getByRole("link", { name: "Grant editor-bulk-vm-01" }).click();
        await expect(editor.getByRole("link", { name: "Revoke editor-bulk-vm-01" })).toBeVisible();
        await editor.getByRole("link", { name: "☆ set default" }).click();
        await expect(editor.getByRole("link", { name: "★ default" })).toBeVisible();
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get("dialog") === null);
        expect((await savedAccess()).rows[0]).toEqual({
          default_name: "editor-bulk-vm-01",
          grants: 2,
        });

        // Revoking the model that was the default leaves the rest granted and
        // the key with no default — not the default it just lost.
        await page.goto(editorUrl("&grantShow=granted"), { waitUntil: "networkidle" });
        await editor.getByRole("link", { name: "Revoke editor-bulk-vm-01" }).click();
        await expect(editor.getByRole("link", { name: "Revoke editor-bulk-vm-01" })).toHaveCount(0);
        await expect(editor.getByRole("link", { name: "★ default" })).toHaveCount(0);
        await expect(editor.getByRole("link", { name: "Revoke editor-solo-vm" })).toBeVisible();
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get("dialog") === null);
        expect((await savedAccess()).rows[0]).toEqual({ default_name: null, grants: 1 });

        // --- The editor's limit fields carry the same promise as the drawer:
        // a field left empty is unlimited, so clearing the budget removes the
        // rule instead of saving the ceiling that is still in the database.
        await page.goto(editorUrl(), { waitUntil: "networkidle" });
        await editor.getByLabel("Budget USD", { exact: true }).fill("");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get("dialog") === null);
        const remaining = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client.query<{ limit_type: string }>(
            `select limit_type from api_key_limits where api_key_id = $1 order by limit_type`,
            [probeId],
          ),
        );
        expect(remaining.rows.map((row) => row.limit_type)).toEqual([
          "concurrency",
          "rpm",
          "token",
          "tpm",
        ]);

        // --- Enforcement is a real choice on the edit path too, not only when
        // the key is created: the select shows what is stored and stores what
        // it shows. (A save rewrites every rule, so a policy that did not come
        // back with the form would revert to block on the next rename.)
        await page.goto(editorUrl(), { waitUntil: "networkidle" });
        await expect(editor.getByLabel("Enforcement policy")).toHaveValue("warn_only");
        await editor.getByLabel("Enforcement policy").selectOption("block");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get("dialog") === null);
        const enforcement = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client.query<{ enforcement_policy: string }>(
            `select distinct enforcement_policy from api_key_limits where api_key_id = $1`,
            [probeId],
          ),
        );
        expect(enforcement.rows.map((row) => row.enforcement_policy)).toEqual(["block"]);
        await page.goto(editorUrl(), { waitUntil: "networkidle" });
        await expect(editor.getByLabel("Enforcement policy")).toHaveValue("block");

        // Revoking the last one holds: the boxes stay empty, and the save it
        // would take is refused here rather than by the database.
        await page.goto(editorUrl("&grantShow=granted"), { waitUntil: "networkidle" });
        await editor.getByRole("link", { name: "Revoke editor-solo-vm" }).click();
        await expect(editor.getByRole("link", { name: /^Revoke / })).toHaveCount(0);
        await expect(editor.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await expect(editor.getByText("grant at least one Virtual Model")).toBeVisible();
        expect((await savedAccess()).rows[0]).toEqual({ default_name: null, grants: 1 });

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
