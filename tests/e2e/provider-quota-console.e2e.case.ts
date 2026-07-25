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

        // Quota lives in its own panel, one entry per connection, and every
        // state it can be in has to read differently from a number.
        await expect(page.getByText("Plan quota")).toBeVisible();
        const quota = page;

        // A window entry reads as a percentage with its reset and staleness.
        await expect(quota.getByText("Five hour")).toBeVisible();
        await expect(quota.getByText(/7% used/)).toBeVisible();
        await expect(quota.getByText(/53% used/)).toBeVisible();
        await expect(quota.getByText(/resets in/).first()).toBeVisible();
        await expect(quota.getByText(/Updated 3 min ago/).first()).toBeVisible();

        // A balance reads as an amount with its currency and gets no bar.
        await expect(quota.getByText("110.00 CNY")).toBeVisible();

        // A provider documented not to report is not a failure, and carries no
        // zero value or staleness line beside the reason.
        await expect(quota.getByText("Not reported by this provider")).toBeVisible();

        // Never probed is distinct from both a value and a reason.
        await expect(quota.getByText("Not yet queried").first()).toBeVisible();

        // A connection whose probe is paused shows that, not stale numbers.
        await expect(quota.getByText("Probing paused")).toBeVisible();

        // The switch lives with the connection's other actions: pause an active
        // connection, then resume it.
        await page.goto(
          `${baseUrl}/providers?selected=${seeded.alphaId}` +
            `&providerKeyDialog=${seeded.alphaId}&connection=${seeded.windowConnectionId}`,
          { waitUntil: "networkidle" },
        );
        await expect(page.getByRole("button", { name: "Pause quota probing" })).toBeVisible();
        await page.getByRole("button", { name: "Pause quota probing" }).click();
        // Pausing must not be refused: no alert carries a message.
        await expect
          .poll(async () =>
            (await page.getByRole("alert").allInnerTexts()).filter((text) => text.trim()),
          )
          .toEqual([]);
        await expect(page.getByRole("button", { name: "Resume quota probing" })).toBeVisible({
          timeout: 15_000,
        });
        await page.getByRole("button", { name: "Resume quota probing" }).click();
        await expect(page.getByRole("button", { name: "Pause quota probing" })).toBeVisible();

        for (const viewport of [
          { width: 1280, height: 900 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
          expect(overflow, `${viewport.width}px`).toBeLessThanOrEqual(0);
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
