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

const SEEDED_RULES = [
  { limitType: "budget", period: "month", unit: "usd", value: 100 },
  { limitType: "rpm", period: "minute", unit: "requests", value: 600 },
  { limitType: "tpm", period: "minute", unit: "tokens", value: 1_000_000 },
  { limitType: "token", period: "request", unit: "tokens", value: 200_000 },
  { limitType: "concurrency", period: "request", unit: "requests", value: 50 },
] as const;

async function seedLimitedApiKey(databaseUrl: string): Promise<string> {
  const apiKeyId = randomUUID();
  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into api_keys (id, name, key_prefix, key_hash, enabled, limits_enabled)
       values ($1, 'drawer-limited-key', left(gen_random_uuid()::text, 12), gen_random_uuid()::text, true, true)`,
      [apiKeyId],
    );
    for (const rule of SEEDED_RULES) {
      await client.query(
        `insert into api_key_limits (
           id, api_key_id, limit_type, period, limit_value, unit, enabled, enforcement_policy
         ) values ($1, $2, $3, $4, $5, $6, true, 'block')`,
        [randomUUID(), apiKeyId, rule.limitType, rule.period, rule.value, rule.unit],
      );
    }
  });
  return apiKeyId;
}

test("a rule the Limits drawer left empty stops being a rule", async ({ browser }) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_limit_drawer_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const apiKeyId = await seedLimitedApiKey(fixture.databaseUrl);
    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      const savedTypes = async () => {
        const result = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client.query<{ limit_type: string }>(
            `select limit_type from api_key_limits where api_key_id = $1 order by limit_type`,
            [apiKeyId],
          ),
        );
        return result.rows.map((row) => row.limit_type);
      };

      try {
        await waitForConsole(baseUrl, consoleApp);
        await page.setViewportSize({ width: 1280, height: 900 });
        await signInFromFirstRun(page, baseUrl);
        await page.goto(`${baseUrl}/limits?selected=${apiKeyId}`, { waitUntil: "networkidle" });

        const drawer = page.getByRole("dialog", { name: "drawer-limited-key" });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByText("Leave a field empty for unlimited")).toBeVisible();
        await expect(drawer.getByLabel("RPM")).toHaveValue("600");

        // --- An emptied field means one ceiling fewer, not the old ceiling
        // saved again. The rules are read back from the database once the save
        // has answered: the fields on screen are only what was typed until it
        // does.
        const saveRules = async () => {
          const saved = page.waitForResponse(
            (response) =>
              response.url().includes("/api/api-key-limits") &&
              response.request().method() === "POST",
          );
          await drawer.getByRole("button", { name: "Save rules" }).click();
          expect((await saved).status()).toBeLessThan(400);
        };

        await drawer.getByLabel("RPM").fill("");
        await saveRules();
        expect(await savedTypes()).toEqual(["budget", "concurrency", "token", "tpm"]);
        await expect(drawer.getByLabel("RPM")).toHaveValue("");
        await expect(drawer.getByLabel("TPM")).toHaveValue("1000000");

        // --- Emptying every field is the same statement about every ceiling.
        // Deleting the rules outright is the other door to it, and this one has
        // to arrive at the same place rather than saving nothing at all.
        for (const label of ["BUDGET USD", "TPM", "TOKENS / REQUEST", "CONCURRENCY"]) {
          await drawer.getByLabel(label).fill("");
        }
        await saveRules();
        expect(await savedTypes()).toEqual([]);
        await expect(page.getByText("no rules · unlimited")).toBeVisible();
        await expect(
          drawer.getByText("No rules are set for this key — it runs unlimited."),
        ).toBeVisible();
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
