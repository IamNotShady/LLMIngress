import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  createRoutePolicy,
  normalizeRoutePolicyFormInput,
} from "../../packages/db/src/console-route-policies";
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
import { withProcessLock } from "../support/process-lock";

test("virtual model endpoint selection filters candidates and rejects incompatible route policy saves", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_endpoint_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedVirtualModelEndpointData(fixture.databaseUrl);

    await expect(
      createRoutePolicy({
        databaseUrl: fixture.databaseUrl,
        routePolicy: normalizeRoutePolicyFormInput({
          endpointProtocol: "messages",
          providerModelIds: [seeded.openAiModelId],
          strategy: "fixed",
          virtualModelId: seeded.virtualModelId,
        }),
      }),
    ).rejects.toThrow(/endpoint messages is not supported/i);

    await withProcessLock("llmingress-console-next-dev", async () => {
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

          await page.goto(`${baseUrl}/models?virtualModelDialog=new`, {
            waitUntil: "networkidle",
          });
          await page.locator("#virtual-model-dialog-endpoint").selectOption("messages");
          await page.getByRole("button", { name: "Add Model" }).click();
          const picker = page.locator(".vm-model-picker");
          await expect(picker).toContainText("Claude Messages");
          await expect(picker).not.toContainText("GPT Chat");
          await expect(picker).not.toContainText("Codex Responses");

          await picker.getByRole("button", { name: "Close" }).click();
          await page.locator("#virtual-model-dialog-endpoint").selectOption("responses");
          await page.getByRole("button", { name: "Add Model" }).click();
          await expect(picker).toContainText("GPT Chat");
          await expect(picker).toContainText("Codex Responses");
          await expect(picker).not.toContainText("Claude Messages");
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});

async function seedVirtualModelEndpointData(databaseUrl: string): Promise<{
  openAiModelId: string;
  virtualModelId: string;
}> {
  const openAiProviderId = randomUUID();
  const anthropicProviderId = randomUUID();
  const codexProviderId = randomUUID();
  const openAiModelId = randomUUID();
  const anthropicModelId = randomUUID();
  const codexModelId = randomUUID();
  const virtualModelId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, enabled)
        values ($1, 'api_key', 'openai', 'OpenAI', true),
               ($2, 'api_key', 'anthropic', 'Anthropic', true),
               ($3, 'subscription', 'openai_codex', 'OpenAI Codex', true)
      `,
      [openAiProviderId, anthropicProviderId, codexProviderId],
    );
    await client.query(
      `
        update providers
        set provider_template_id = 'openai_codex'
        where id = $1
      `,
      [codexProviderId],
    );
    await client.query(
      `
        insert into provider_models (
          id,
          provider_id,
          model_id,
          display_name,
          input_modalities,
          output_modalities,
          context_window,
          max_output_tokens,
          supports_streaming,
          supports_function_calling,
          supports_reasoning,
          availability
        )
        values ($1, $2, 'gpt-chat', 'GPT Chat', array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available'),
               ($3, $4, 'claude-msg', 'Claude Messages', array['text']::text[], array['text']::text[], 200000, 8192, true, true, false, 'available'),
               ($5, $6, 'codex-resp', 'Codex Responses', array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')
      `,
      [
        openAiModelId,
        openAiProviderId,
        anthropicModelId,
        anthropicProviderId,
        codexModelId,
        codexProviderId,
      ],
    );
    await client.query(
      `
        insert into virtual_models (id, name, description, enabled)
        values ($1, 'vm-endpoint-api', 'Endpoint API validation VM', true)
      `,
      [virtualModelId],
    );
  });

  return {
    openAiModelId,
    virtualModelId,
  };
}
