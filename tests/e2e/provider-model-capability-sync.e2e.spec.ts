import { randomUUID } from "node:crypto";
import { updateProviderModelManualCapabilities } from "@llmingress/db/console-provider-model-capabilities";
import { refreshProviderModels } from "@llmingress/worker-runtime/worker-model-refresh";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";

test("provider model refresh stores effective capabilities and manual overrides fence unknown/conflict", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_model_capabilities_${randomUUID().replaceAll("-", "_")}`,
  });
  const providerId = randomUUID();
  const syncedAt = new Date("2026-07-10T00:00:00.000Z");

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await fixture.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'openai', 'Capability Provider', 'http://provider.test/v1', true)
      `,
      [providerId],
    );

    const schema = await fixture.query<{ column_name: string; is_nullable: string }>(
      `
        select column_name, is_nullable
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'provider_models'
          and column_name in (
            'input_modalities',
            'output_modalities',
            'max_output_tokens',
            'supports_function_calling',
            'supports_reasoning',
            'supports_tools'
          )
        order by column_name
      `,
    );
    expect(schema.rows.map((row) => row.column_name)).toEqual([
      "input_modalities",
      "max_output_tokens",
      "output_modalities",
      "supports_function_calling",
      "supports_reasoning",
    ]);
    expect(
      schema.rows.find((row) => row.column_name === "supports_function_calling")?.is_nullable,
    ).toBe("YES");

    await refreshProviderModels({
      databaseUrl: fixture.databaseUrl,
      fetch: async () =>
        new Response(JSON.stringify({ data: [{ id: "gpt-capability-sync" }] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      modelPriceSource: async () => [],
      modelRegistrySource: async () => [
        {
          capabilityConflicts: {
            maxOutputTokens: [
              { source: "models.dev", value: 4096 },
              { source: "litellm", value: 8192 },
            ],
          },
          inputModalities: ["text", "image"],
          maxContextTokens: 128000,
          maxOutputTokens: null,
          modelId: "gpt-capability-sync",
          outputModalities: ["text"],
          providerKey: "openai",
          registrySources: {
            inputModalities: "models.dev",
            maxContextTokens: "models.dev",
            outputModalities: "models.dev",
            supportsFunctionCalling: "models.dev",
            supportsReasoning: "models.dev",
          },
          supportsFunctionCalling: true,
          supportsReasoning: false,
          supportsStreaming: true,
          syncedAt,
        },
      ],
      providerId,
    });

    const inserted = await readCapabilityRow(fixture);
    expect(inserted).toMatchObject({
      context_window: 128000,
      input_modalities: ["text", "image"],
      max_output_tokens: null,
      output_modalities: ["text"],
      supports_function_calling: true,
      supports_reasoning: false,
    });
    expect(inserted.capability_metadata.syncedCapabilities).toMatchObject({
      maxContextTokens: 128000,
      maxOutputTokens: null,
      supportsFunctionCalling: true,
    });
    expect(inserted.capability_metadata.conflicts.maxOutputTokens).toHaveLength(2);

    await updateProviderModelManualCapabilities({
      capabilities: {
        inputModalities: ["text", "image"],
        maxContextTokens: 128000,
        maxOutputTokens: 8192,
        outputModalities: ["text"],
        supportsFunctionCalling: true,
        supportsReasoning: true,
      },
      databaseUrl: fixture.databaseUrl,
      providerModelId: inserted.id,
    });

    const overridden = await readCapabilityRow(fixture);
    expect(overridden).toMatchObject({
      max_output_tokens: 8192,
      supports_reasoning: true,
    });
    expect(overridden.capability_metadata.manualCapabilities).toMatchObject({
      maxOutputTokens: 8192,
      supportsReasoning: true,
    });

    await updateProviderModelManualCapabilities({
      capabilities: null,
      databaseUrl: fixture.databaseUrl,
      providerModelId: inserted.id,
    });

    const cleared = await readCapabilityRow(fixture);
    expect(cleared).toMatchObject({
      max_output_tokens: null,
      supports_reasoning: false,
    });
    expect(cleared.capability_metadata.manualCapabilities).toBeUndefined();
  } finally {
    await fixture.dispose();
  }
});

type CapabilityRow = {
  capability_metadata: {
    conflicts?: Record<string, unknown>;
    manualCapabilities?: Record<string, unknown>;
    syncedCapabilities?: Record<string, unknown>;
  };
  context_window: number | null;
  id: string;
  input_modalities: string[] | null;
  max_output_tokens: number | null;
  output_modalities: string[] | null;
  supports_function_calling: boolean | null;
  supports_reasoning: boolean | null;
};

async function readCapabilityRow(
  fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>,
): Promise<CapabilityRow> {
  const result = await fixture.query<CapabilityRow>(
    `
      select id::text,
             input_modalities,
             output_modalities,
             context_window,
             max_output_tokens,
             supports_function_calling,
             supports_reasoning,
             capability_metadata
      from provider_models
      where model_id = 'gpt-capability-sync'
    `,
  );
  const row = result.rows[0];
  expect(row).toBeDefined();
  return row as CapabilityRow;
}
