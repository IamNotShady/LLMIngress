import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { listConsoleProviderQuotaSummaries } from "../../packages/db/src/console-provider-quota";
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

const sharedBalance = [{ currency: "USD", total: "76.50" }];

type SeededQuota = {
  alphaBalanceId: string;
  localId: string;
  alphaDisabledId: string;
  alphaId: string;
  alphaUnqueriedId: string;
  alphaUnsupportedId: string;
  betaId: string;
  betaOneId: string;
  betaTwoId: string;
  windowConnectionId: string;
};

async function seedQuotaData(databaseUrl: string): Promise<SeededQuota> {
  const seeded: SeededQuota = {
    alphaBalanceId: randomUUID(),
    localId: randomUUID(),
    alphaDisabledId: randomUUID(),
    alphaId: randomUUID(),
    alphaUnqueriedId: randomUUID(),
    alphaUnsupportedId: randomUUID(),
    betaId: randomUUID(),
    betaOneId: randomUUID(),
    betaTwoId: randomUUID(),
    windowConnectionId: randomUUID(),
  };
  const nowMs = Date.now();
  const windowEntries = [
    {
      resetsAt: new Date(nowMs + 4 * 3_600_000).toISOString(),
      utilization: 0.0741,
      window: "five_hour",
    },
    { utilization: 0.5312, window: "seven_day" },
  ];

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'deepseek', 'Quota Alpha', 'https://alpha.test/v1', true),
              ($2, 'api_key', 'moonshot', 'Quota Beta', 'https://beta.test/v1', true),
              ($3, 'local', 'ollama', 'Quota Local', 'http://127.0.0.1:11434/v1', true)`,
      [seeded.alphaId, seeded.betaId, seeded.localId],
    );
    const connections: Array<[string, string, string]> = [
      [seeded.windowConnectionId, seeded.alphaId, "alpha-window"],
      [seeded.alphaBalanceId, seeded.alphaId, "alpha-balance"],
      [seeded.alphaUnsupportedId, seeded.alphaId, "alpha-unsupported"],
      [seeded.alphaUnqueriedId, seeded.alphaId, "alpha-unqueried"],
      [seeded.alphaDisabledId, seeded.alphaId, "alpha-disabled"],
      [seeded.betaOneId, seeded.betaId, "beta-one"],
      [seeded.betaTwoId, seeded.betaId, "beta-two"],
    ];
    for (const [id, providerId, label] of connections) {
      await client.query(
        `insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, label)
         values ($1, $2, $3, '{"version":1}'::jsonb, 'test-key', $3)`,
        [id, providerId, label],
      );
    }
    await client.query("update provider_api_keys set enabled = false where id = $1", [
      seeded.alphaDisabledId,
    ]);
    const summaries: Array<[string, string, unknown, string | null, Date]> = [
      [
        seeded.windowConnectionId,
        seeded.alphaId,
        windowEntries,
        null,
        new Date(nowMs - 3 * 60_000),
      ],
      [
        seeded.alphaBalanceId,
        seeded.alphaId,
        [{ currency: "CNY", total: "110.00" }],
        null,
        new Date(nowMs - 3 * 60_000),
      ],
      [seeded.alphaUnsupportedId, seeded.alphaId, [], "not_supported", new Date(nowMs - 60_000)],
      [
        seeded.alphaDisabledId,
        seeded.alphaId,
        [{ utilization: 0.24, window: "five_hour" }],
        null,
        new Date(nowMs - 21 * 86_400_000),
      ],
      [seeded.betaOneId, seeded.betaId, sharedBalance, null, new Date(nowMs - 3 * 60_000)],
      [seeded.betaTwoId, seeded.betaId, sharedBalance, null, new Date(nowMs - 3 * 60_000)],
    ];
    for (const [connectionId, providerId, entries, errorCode, observedAt] of summaries) {
      await client.query(
        `insert into provider_quota_summary (
           id, provider_id, provider_connection_id, entries, observed_at, error_code
         )
         values ($1, $2, $3, $4::jsonb, $5, $6)`,
        [randomUUID(), providerId, connectionId, JSON.stringify(entries), observedAt, errorCode],
      );
    }
  });

  return seeded;
}

test("the quota read model returns one row per connection and null state when never probed", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_read_model_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedQuotaData(fixture.databaseUrl);
    const summaries = await listConsoleProviderQuotaSummaries({
      databaseUrl: fixture.databaseUrl,
    });

    // Eight connections were seeded (one local); six carry a summary row.
    expect(summaries).toHaveLength(8);
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));

    const unqueried = byId.get(seeded.alphaUnqueriedId);
    expect(unqueried).toMatchObject({
      connectionKind: "api_key",
      connectionLabel: "alpha-unqueried",
      entries: [],
      errorCode: null,
      observedAt: null,
      providerDisplayName: "Quota Alpha",
      providerId: seeded.alphaId,
      providerKey: "deepseek",
    });

    const unsupported = byId.get(seeded.alphaUnsupportedId);
    expect(unsupported?.entries).toEqual([]);
    expect(unsupported?.errorCode).toBe("not_supported");
    expect(unsupported?.observedAt).toBeInstanceOf(Date);

    const windows = byId.get(seeded.windowConnectionId);
    expect(windows?.entries).toEqual([
      expect.objectContaining({ utilization: 0.0741, window: "five_hour" }),
      { utilization: 0.5312, window: "seven_day" },
    ]);
    expect(windows?.observedAt).toBeInstanceOf(Date);

    expect(byId.get(seeded.betaOneId)?.entries).toEqual(sharedBalance);
    expect(byId.get(seeded.betaOneId)?.probingEnabled).toBe(true);

    // A local provider appears as a connection that will never be enqueued.
    const local = byId.get(seeded.localId);
    expect(local).toMatchObject({
      connectionKind: "local",
      entries: [],
      errorCode: null,
      observedAt: null,
      probingEnabled: true,
      providerKey: "ollama",
    });

    // A disabled connection keeps its stale row but reports probing stopped.
    const disabled = byId.get(seeded.alphaDisabledId);
    expect(disabled?.probingEnabled).toBe(false);
    expect(disabled?.entries).toEqual([{ utilization: 0.24, window: "five_hour" }]);
  } finally {
    await fixture.dispose();
  }
});

test("the Providers page renders each stored quota state and never overflows", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_quota_console_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedQuotaData(fixture.databaseUrl);
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

        await page.goto(`${baseUrl}/providers?selected=${seeded.alphaId}`, {
          waitUntil: "networkidle",
        });

        const quotaCell = (label: string) =>
          page.locator(".provider-key-table tbody tr", { hasText: label }).locator(".quota-cell");

        // A window entry reads as a percentage plus its reset time.
        const windowCell = quotaCell("alpha-window");
        await expect(windowCell).toContainText("7%");
        await expect(windowCell).toContainText("53%");
        await expect(windowCell).toContainText("Five hour");
        await expect(windowCell).toContainText("resets in");
        await expect(windowCell).toContainText("Updated 3 min ago");

        // A balance reads as an amount with its currency.
        const balanceCell = quotaCell("alpha-balance");
        await expect(balanceCell).toContainText("110.00 CNY");

        // An expected non-reporting state shows its reason, carries no zero
        // value, and is not styled as a failure.
        const unsupportedCell = quotaCell("alpha-unsupported");
        await expect(unsupportedCell).toContainText("Not reported by this provider");
        await expect(unsupportedCell).not.toContainText("%");
        await expect(unsupportedCell.locator(".pill--danger")).toHaveCount(0);
        await expect(unsupportedCell.locator(".pill--warn")).toHaveCount(0);
        await expect(unsupportedCell.locator(".pill")).toHaveCount(1);
        // The reason stands alone — no staleness line next to an error state,
        // even though this row carries an observed_at.
        await expect(unsupportedCell).not.toContainText("Updated");

        // Never probed is distinct from both a value and a reason.
        const unqueriedCell = quotaCell("alpha-unqueried");
        await expect(unqueriedCell).toContainText("Not yet queried");
        await expect(unqueriedCell).not.toContainText("Not reported");

        // A disabled connection is skipped by the probe scan, so its stored
        // numbers only age; the cell says paused instead of showing them.
        const disabledCell = quotaCell("alpha-disabled");
        await expect(disabledCell).toContainText("Probing paused");
        await expect(disabledCell).not.toContainText("%");
        await expect(disabledCell).not.toContainText("Updated");
        // Connection-level disable is not the quota switch: no Resume here.
        const disabledRow = page.locator(".provider-key-table tbody tr", {
          hasText: "alpha-disabled",
        });
        await expect(disabledRow.getByRole("button", { name: /quota probing/ })).toHaveCount(0);

        // The quota switch lives with the other row actions: pause an active
        // connection, confirm the paused state, then resume it. The form
        // triggers router.refresh() on success, so the row re-renders in
        // place — locator assertions poll until it does.
        const windowRow = page.locator(".provider-key-table tbody tr", {
          hasText: "alpha-window",
        });
        await windowRow.getByRole("button", { name: "Pause quota probing" }).click();
        await expect(windowCell).toContainText("Probing paused", { timeout: 30_000 });
        await expect(windowCell).not.toContainText("%");
        await windowRow.getByRole("button", { name: "Resume quota probing" }).click();
        await expect(windowCell).toContainText("7%", { timeout: 30_000 });

        // An identical balance across connections is one account pool, not two.
        // networkidle would never settle here: the toggle interactions above
        // leave router.refresh() RSC connections open on the dev server.
        await page.goto(`${baseUrl}/providers?selected=${seeded.betaId}`, {
          waitUntil: "domcontentloaded",
        });
        await expect(page.locator(".provider-quota-shared")).toHaveCount(1);
        await expect(page.locator(".provider-quota-shared")).toContainText("76.50 USD");
        await expect(page.locator(".provider-quota-shared")).toContainText("2 connections");
        await expect(page.getByText("76.50 USD", { exact: false })).toHaveCount(1);
        await expect(quotaCell("beta-one")).toContainText("Shared account balance");

        for (const viewport of [
          { height: 900, width: 1280 },
          { height: 844, width: 390 },
        ]) {
          await page.setViewportSize(viewport);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, `${viewport.width}px viewport`).toBeLessThanOrEqual(0);
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
