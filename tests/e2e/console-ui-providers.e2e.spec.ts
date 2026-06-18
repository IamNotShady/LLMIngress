import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { withConsoleDevServer } from "../support/console-dev-server";

test("providers page matches the designed provider detail and model library layout", async ({
  browser,
}) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/providers`);

      await expect(
        page.getByRole("heading", { level: 1, name: "Providers & Models" }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "+ Add Provider" })).toBeVisible();

      for (const provider of ["OpenAI", "Anthropic", "Google", "OpenRouter", "Ollama local"]) {
        await expect(page.locator(".provider-summary-card", { hasText: provider })).toBeVisible();
      }

      const providerList = page.locator(".providers-list-card");
      await expect(providerList.getByRole("heading", { name: "Provider list" })).toBeVisible();
      for (const header of [
        "Provider",
        "Status",
        "Type",
        "Key count",
        "Models",
        "Last connection",
        "Action",
      ]) {
        await expect(providerList.getByRole("columnheader", { name: header })).toBeVisible();
      }

      const details = page.getByLabel("Selected provider details");
      await expect(
        details.getByRole("heading", { name: "Provider detail - OpenAI" }),
      ).toBeVisible();
      await expect(details.getByText("Available models")).toBeVisible();
      await expect(details.getByRole("heading", { name: "Key management" })).toBeVisible();
      for (const header of ["Label", "Prefix", "Status", "Last test", "Action"]) {
        await expect(details.getByRole("columnheader", { name: header })).toBeVisible();
      }

      const modelLibrary = page.locator(".model-library-card");
      await expect(modelLibrary.getByRole("heading", { name: "Model library" })).toBeVisible();
      for (const header of [
        "Provider",
        "Model ID",
        "Context",
        "Input price",
        "Output price",
        "Tools",
        "Streaming",
        "Status",
        "Action",
      ]) {
        await expect(modelLibrary.getByRole("columnheader", { name: header })).toBeVisible();
      }

      // Existing management controls are preserved below the first-screen dashboard.
      await expect(page.getByRole("heading", { name: "Manage providers" })).toBeVisible();
      await expect(page.getByText("New provider", { exact: true })).toBeVisible();
      await expect(page.getByText("Add from template", { exact: true })).toBeVisible();
    },
    { seed: seedProvidersData },
  );
});

async function seedProvidersData(databaseUrl: string): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const providers = [
      {
        baseUrl: "https://api.openai.com/v1",
        displayName: "OpenAI",
        keyCount: 2,
        providerKey: "openai",
        providerType: "api_key",
      },
      {
        baseUrl: "https://api.anthropic.com/v1",
        displayName: "Anthropic",
        keyCount: 1,
        providerKey: "anthropic",
        providerType: "api_key",
      },
      {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        displayName: "Google",
        keyCount: 1,
        providerKey: "google",
        providerType: "api_key",
      },
      {
        baseUrl: "https://openrouter.ai/api/v1",
        displayName: "OpenRouter",
        keyCount: 1,
        providerKey: "openrouter",
        providerType: "api_key",
      },
      {
        baseUrl: "http://127.0.0.1:11434/v1",
        displayName: "Ollama local",
        keyCount: 0,
        providerKey: "ollama",
        providerType: "local",
      },
    ] as const;
    const models = [
      ["openai", "gpt-4.1", "GPT-4.1", 1_000_000, true, true, "available", 2, 8],
      ["openai", "gpt-4.1-mini", "GPT-4.1 Mini", 1_000_000, true, true, "available", 0.4, 1.6],
      [
        "anthropic",
        "claude-3-7-sonnet",
        "Claude 3.7 Sonnet",
        200_000,
        true,
        true,
        "available",
        3,
        15,
      ],
      [
        "google",
        "gemini-2.0-flash",
        "Gemini 2.0 Flash",
        1_000_000,
        true,
        true,
        "available",
        0.1,
        0.4,
      ],
      [
        "openrouter",
        "meta-llama/llama-3.3-70b-instruct",
        "Llama 3.3 70B",
        131_000,
        true,
        true,
        "available",
        0.8,
        0.8,
      ],
      ["ollama", "llama3.2", "Llama 3.2", 128_000, true, false, "available", null, null],
    ] as const;
    const providerIds = new Map<string, string>();

    for (const provider of providers) {
      const providerId = randomUUID();
      providerIds.set(provider.providerKey, providerId);
      await client.query(
        `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
         values ($1, $2, $3, $4, $5, true)`,
        [
          providerId,
          provider.providerType,
          provider.providerKey,
          provider.displayName,
          provider.baseUrl,
        ],
      );

      for (let index = 0; index < provider.keyCount; index += 1) {
        await client.query(
          `insert into provider_api_keys
             (id, provider_id, key_prefix, encrypted_key, key_id, created_at, updated_at)
           values ($1, $2, $3, $4, $5, '2026-06-18T08:00:00Z', '2026-06-18T08:00:00Z')`,
          [
            randomUUID(),
            providerId,
            `${provider.providerKey.slice(0, 6)}${index + 1}`,
            JSON.stringify({ alg: "aes-256-gcm", ciphertext: "seed", iv: "seed", tag: "seed" }),
            "test-key",
          ],
        );
      }
    }

    for (const [
      providerKey,
      modelId,
      displayName,
      context,
      streaming,
      tools,
      availability,
      input,
      output,
    ] of models) {
      const providerId = providerIds.get(providerKey);
      if (!providerId) {
        throw new Error(`Missing provider ${providerKey}.`);
      }
      const providerModelId = randomUUID();
      await client.query(
        `insert into provider_models (
           id,
           provider_id,
           model_id,
           display_name,
           context_window,
           supports_streaming,
           supports_tools,
           availability,
           manual_input_usd_per_million_tokens,
           manual_output_usd_per_million_tokens,
           manual_price_updated_at
         )
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, '2026-06-18T08:00:00Z')`,
        [
          providerModelId,
          providerId,
          modelId,
          displayName,
          context,
          streaming,
          tools,
          availability,
          input,
          output,
        ],
      );
    }

    for (const provider of providers) {
      const providerId = providerIds.get(provider.providerKey);
      if (!providerId) {
        throw new Error(`Missing provider ${provider.providerKey}.`);
      }
      const eventId = randomUUID();
      await client.query(
        `insert into provider_health_events
           (id, provider_id, trigger, status, latency_ms, observed_at)
         values ($1, $2, 'worker_probe', 'healthy', 128, '2026-06-18T08:05:00Z')`,
        [eventId, providerId],
      );
      await client.query(
        `insert into provider_health_summary
           (id, provider_id, last_event_id, status, consecutive_failures, updated_at)
         values ($1, $2, $3, 'healthy', 0, '2026-06-18T08:05:00Z')`,
        [randomUUID(), providerId, eventId],
      );
    }
  } finally {
    await client.end();
  }
}
