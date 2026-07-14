import { randomUUID } from "node:crypto";
import { listProviderModelPage } from "@llmingress/db/console-route-policies";
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
