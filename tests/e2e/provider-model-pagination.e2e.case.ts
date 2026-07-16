import { randomUUID } from "node:crypto";
import { listProviders } from "@llmingress/db/console-providers";
import {
  listProviderModelOptions,
  listProviderModelPage,
} from "@llmingress/db/console-route-policies";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("Provider model catalog is searched and paginated in PostgreSQL", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_models_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'catalog', 'Catalog', 'http://catalog.test/v1', true)
      `,
      [providerId],
    );
    const ids = Array.from({ length: 125 }, () => randomUUID());
    const modelIds = ids.map((_, index) => `model-${String(index + 1).padStart(3, "0")}`);
    await fixture.query(
      `
        insert into provider_models (id, provider_id, model_id, display_name, availability)
        select ids.id::uuid, $1::uuid, ids.model_id, ids.model_id, 'available'
        from unnest($2::text[], $3::text[]) as ids(id, model_id)
      `,
      [providerId, ids, modelIds],
    );

    const first = await listProviderModelPage({
      databaseUrl: fixture.databaseUrl,
      page: 1,
      providerId,
    });
    const third = await listProviderModelPage({
      databaseUrl: fixture.databaseUrl,
      page: 3,
      providerId,
    });
    const searched = await listProviderModelPage({
      databaseUrl: fixture.databaseUrl,
      page: 1,
      providerId,
      query: "model-12",
    });

    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(125);
    expect(first.page).toBe(1);
    expect(first.pageCount).toBe(3);
    expect(first.items[0]?.modelId).toBe("model-001");
    expect(third.items).toHaveLength(25);
    expect(third.items[0]?.modelId).toBe("model-101");
    expect(searched.total).toBe(6);
    expect(searched.items.map((model) => model.modelId)).toEqual([
      "model-120",
      "model-121",
      "model-122",
      "model-123",
      "model-124",
      "model-125",
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("Console model catalogs hide only known embedding-only models", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_model_visibility_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'api_key', 'openai', 'OpenAI', 'https://api.openai.com/v1', true)
      `,
      [providerId],
    );
    await fixture.query(
      `
        insert into provider_models (
          id, provider_id, model_id, display_name, output_modalities, availability
        )
        values ($1, $5, 'embedding-only', 'Embedding Only', array['embedding']::text[], 'available'),
               ($2, $5, 'mixed-output', 'Mixed Output', array['text', 'embedding']::text[], 'available'),
               ($3, $5, 'text-output', 'Text Output', array['text']::text[], 'available'),
               ($4, $5, 'unknown-output', 'Unknown Output', null, 'available')
      `,
      [randomUUID(), randomUUID(), randomUUID(), randomUUID(), providerId],
    );

    const page = await listProviderModelPage({
      databaseUrl: fixture.databaseUrl,
      providerId,
    });
    const options = await listProviderModelOptions(fixture.databaseUrl);
    const provider = (await listProviders(fixture.databaseUrl)).find(
      (candidate) => candidate.id === providerId,
    );

    expect(page.items.map((model) => model.modelId)).toEqual([
      "mixed-output",
      "text-output",
      "unknown-output",
    ]);
    expect(page.total).toBe(3);
    expect(options.map((model) => model.modelId)).toEqual([
      "mixed-output",
      "text-output",
      "unknown-output",
    ]);
    expect(provider?.providerModelCount).toBe(3);

    const storedModels = await fixture.query<{ model_id: string }>(
      "select model_id from provider_models order by model_id",
    );
    expect(storedModels.rows.map((model) => model.model_id)).toEqual([
      "embedding-only",
      "mixed-output",
      "text-output",
      "unknown-output",
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("Provider model catalog spans every provider when no provider is selected", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_models_all_${randomUUID().replaceAll("-", "_")}`,
  });
  const alphaId = randomUUID();
  const betaId = randomUUID();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'catalog-alpha', 'Alpha Catalog', 'http://alpha.test/v1', true),
               ($2, 'local', 'catalog-beta', 'Beta Catalog', 'http://beta.test/v1', true)
      `,
      [alphaId, betaId],
    );
    for (const [providerId, prefix] of [
      [alphaId, "alpha"],
      [betaId, "beta"],
    ] as const) {
      const ids = Array.from({ length: 60 }, () => randomUUID());
      const modelIds = ids.map((_, index) =>
        index === 0 ? `${prefix}-needle` : `${prefix}-model-${String(index + 1).padStart(3, "0")}`,
      );
      await fixture.query(
        `
          insert into provider_models (id, provider_id, model_id, display_name, availability)
          select ids.id::uuid, $1::uuid, ids.model_id, ids.model_id, 'available'
          from unnest($2::text[], $3::text[]) as ids(id, model_id)
        `,
        [providerId, ids, modelIds],
      );
    }

    const first = await listProviderModelPage({
      databaseUrl: fixture.databaseUrl,
      page: 1,
      providerId: null,
    });
    expect(first.total).toBe(120);
    expect(first.pageCount).toBe(3);
    expect(first.items).toHaveLength(50);
    // Provider-grouped ordering: the first 50 rows are all Alpha Catalog.
    expect(new Set(first.items.map((item) => item.providerDisplayName))).toEqual(
      new Set(["Alpha Catalog"]),
    );

    const second = await listProviderModelPage({
      databaseUrl: fixture.databaseUrl,
      page: 2,
      providerId: null,
    });
    expect(second.items[0]?.providerDisplayName).toBe("Alpha Catalog");
    expect(second.items.at(-1)?.providerDisplayName).toBe("Beta Catalog");

    const search = await listProviderModelPage({
      databaseUrl: fixture.databaseUrl,
      providerId: null,
      query: "needle",
    });
    expect(search.total).toBe(2);
    expect(search.items.map((item) => item.providerDisplayName)).toEqual([
      "Alpha Catalog",
      "Beta Catalog",
    ]);

    const scoped = await listProviderModelPage({
      databaseUrl: fixture.databaseUrl,
      providerId: alphaId,
    });
    expect(scoped.total).toBe(60);
  } finally {
    await fixture.dispose();
  }
});
