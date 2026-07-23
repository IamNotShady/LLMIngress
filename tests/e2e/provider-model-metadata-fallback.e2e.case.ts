import { randomUUID } from "node:crypto";
import { mergeProviderModelRegistryEntries } from "@llmingress/provider/price-source";
import { refreshProviderModels } from "@llmingress/worker-runtime/worker-model-refresh";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("cross-catalog metadata fallback fills a multi-vendor bundle provider", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_metadata_fallback_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const syncedAt = new Date("2026-07-23T00:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    // A qwen-keyed bundle provider that lists a native id, a foreign id, and a conflicting id.
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'qwen', 'Qwen Token Plan', 'http://provider.test/v1', true)
      `,
      [providerId],
    );

    await refreshProviderModels({
      databaseUrl: fixture.databaseUrl,
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [{ id: "qwen3-max" }, { id: "deepseek-v4-pro" }, { id: "glm-5.2-conflict" }],
          }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
      modelRegistrySource: async () =>
        mergeProviderModelRegistryEntries(
          // Provider's own (qwen) catalog: only the native model.
          [
            {
              inputModalities: ["text"],
              maxContextTokens: 262144,
              modelId: "qwen3-max",
              providerKey: "qwen",
              syncedAt,
            },
          ],
          // Trusted (tier-1) deepseek catalog: the foreign id lives here.
          [
            {
              inputModalities: ["text", "image"],
              maxContextTokens: 131072,
              modelId: "deepseek-v4-pro",
              providerKey: "deepseek",
              syncedAt,
            },
          ],
          // Two trusted catalogs both claim the conflicting id with different data.
          [
            {
              maxContextTokens: 200000,
              modelId: "glm-5.2-conflict",
              providerKey: "zai",
              syncedAt,
            },
          ],
          [
            {
              maxContextTokens: 111111,
              modelId: "glm-5.2-conflict",
              providerKey: "openai",
              syncedAt,
            },
          ],
        ),
      providerId,
    });

    const native = await readRow(fixture, "qwen3-max");
    expect(native.context_window).toBe(262144);
    // Provider-scoped resolution leaves no provenance markers.
    expect(native.capability_metadata).not.toHaveProperty("resolvedVia");
    expect(native.capability_metadata).not.toHaveProperty("resolvedFromCatalog");

    // Core assertion: the foreign id resolves via cross-catalog tier-1 fallback.
    const foreign = await readRow(fixture, "deepseek-v4-pro");
    expect(foreign.context_window).toBe(131072);
    expect(foreign.input_modalities).toEqual(["text", "image"]);
    // Cross-catalog resolution stamps provenance into capability_metadata.
    expect(foreign.capability_metadata).toMatchObject({
      resolvedFromCatalog: "deepseek",
      resolvedVia: "cross-catalog",
    });

    // Conflicting id stays Unknown rather than guessing.
    const conflict = await readRow(fixture, "glm-5.2-conflict");
    expect(conflict.context_window).toBeNull();
  } finally {
    await fixture.dispose();
  }
});

type MetadataRow = {
  capability_metadata: Record<string, unknown>;
  context_window: number | null;
  id: string;
  input_modalities: string[] | null;
};

async function readRow(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
  modelId: string,
): Promise<MetadataRow> {
  const result = await fixture.query<MetadataRow>(
    `
      select id::text, context_window, input_modalities, capability_metadata
      from provider_models
      where model_id = $1
    `,
    [modelId],
  );
  const row = result.rows[0];
  expect(row).toBeDefined();
  return row as MetadataRow;
}
