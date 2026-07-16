import { randomUUID } from "node:crypto";
import { createTestPostgresFixture, runMigrations } from "@llmingress/db";
import { normalizeProviderTemplateFormInput } from "@llmingress/db/console-provider-templates";
import {
  createProvider,
  createProviderFromTemplate,
  normalizeProviderFormInput,
  updateProvider,
} from "@llmingress/db/console-providers";
import { describe, expect, it } from "vitest";

describe("console provider duplicates", () => {
  it("creates multiple providers with the same provider key", async () => {
    const fixture = await createDuplicateProviderFixture();
    try {
      const first = await createOpenAIProvider(fixture.databaseUrl, {
        baseUrl: "https://api.openai.com/v1",
        displayName: "OpenAI",
      });
      const second = await createOpenAIProvider(fixture.databaseUrl, {
        baseUrl: "https://eu.example.test/v1",
        displayName: "OpenAI EU",
      });

      expect(first.id).not.toBe(second.id);
      const stored = await fixture.query(
        `
          select display_name, base_url
          from providers
          where provider_key = 'openai'
            and deleted_at is null
          order by display_name
        `,
      );
      expect(stored.rows).toEqual([
        { base_url: "https://api.openai.com/v1", display_name: "OpenAI" },
        { base_url: "https://eu.example.test/v1", display_name: "OpenAI EU" },
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it("creates multiple providers from the same template", async () => {
    const fixture = await createDuplicateProviderFixture();
    try {
      for (const displayName of ["Ollama A", "Ollama B"]) {
        await createProviderFromTemplate({
          databaseUrl: fixture.databaseUrl,
          template: normalizeProviderTemplateFormInput({
            baseUrl: "http://127.0.0.1:11434/v1",
            displayName,
            templateId: "ollama",
          }),
        });
      }

      const stored = await fixture.query(
        `
          select display_name
          from providers
          where provider_key = 'ollama'
            and deleted_at is null
          order by display_name
        `,
      );
      expect(stored.rows).toEqual([{ display_name: "Ollama A" }, { display_name: "Ollama B" }]);
    } finally {
      await fixture.dispose();
    }
  });

  it("creates providers with duplicate display names", async () => {
    const fixture = await createDuplicateProviderFixture();
    try {
      await createOpenAIProvider(fixture.databaseUrl, {
        baseUrl: "https://api.openai.com/v1",
        displayName: "OpenAI",
      });
      await createOpenAIProvider(fixture.databaseUrl, {
        baseUrl: "https://eu.example.test/v1",
        displayName: "OpenAI",
      });

      const stored = await fixture.query(
        `
          select base_url
          from providers
          where provider_key = 'openai'
            and display_name = 'OpenAI'
            and deleted_at is null
          order by base_url
        `,
      );
      expect(stored.rows).toEqual([
        { base_url: "https://api.openai.com/v1" },
        { base_url: "https://eu.example.test/v1" },
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  it("renames a provider to an existing display name", async () => {
    const fixture = await createDuplicateProviderFixture();
    try {
      await createOpenAIProvider(fixture.databaseUrl, {
        baseUrl: "https://api.openai.com/v1",
        displayName: "OpenAI",
      });
      const second = await createOpenAIProvider(fixture.databaseUrl, {
        baseUrl: "https://eu.example.test/v1",
        displayName: "OpenAI EU",
      });

      const updated = await updateProvider({
        baseUrl: "https://eu.example.test/v1",
        databaseUrl: fixture.databaseUrl,
        displayName: "OpenAI",
        id: second.id,
      });

      expect(updated.provider.displayName).toBe("OpenAI");
      const stored = await fixture.query(
        `
          select count(*)::integer as duplicate_count
          from providers
          where display_name = 'OpenAI'
            and deleted_at is null
        `,
      );
      expect(stored.rows).toEqual([{ duplicate_count: 2 }]);
    } finally {
      await fixture.dispose();
    }
  });
});

async function createDuplicateProviderFixture() {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_duplicates_${randomUUID().replaceAll("-", "_")}`,
  });
  await runMigrations({ databaseUrl: fixture.databaseUrl });
  return fixture;
}

function createOpenAIProvider(
  databaseUrl: string,
  input: { baseUrl: string; displayName: string },
) {
  return createProvider({
    databaseUrl,
    provider: normalizeProviderFormInput({
      baseUrl: input.baseUrl,
      displayName: input.displayName,
      providerKey: "openai",
      providerType: "api_key",
    }),
  });
}
