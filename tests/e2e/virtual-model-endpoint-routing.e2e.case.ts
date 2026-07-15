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
    await expect(
      createRoutePolicy({
        databaseUrl: fixture.databaseUrl,
        routePolicy: normalizeRoutePolicyFormInput({
          endpointProtocol: "chat_completions",
          providerModelIds: [seeded.embeddingOnlyModelId],
          strategy: "fixed",
          virtualModelId: seeded.virtualModelId,
        }),
      }),
    ).rejects.toThrow(/endpoint chat_completions is not supported/i);
    await seedVirtualModelRoutePolicy(fixture.databaseUrl, seeded);

    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      const browserErrors: string[] = [];
      const mutationRequests: string[] = [];
      page.on("console", (message) => {
        if (message.type() === "error") {
          browserErrors.push(message.text());
        }
      });
      page.on("request", (request) => {
        if (request.method() === "POST") {
          mutationRequests.push(request.url());
        }
      });

      try {
        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);

        await page.goto(`${baseUrl}/models?virtualModelDialog=new`, {
          waitUntil: "networkidle",
        });
        const endpointSelect = page.locator("#virtual-model-dialog-endpoint");
        await expect(endpointSelect.locator('option[value="embeddings"]')).toHaveCount(0);
        await endpointSelect.selectOption("messages");
        await page.getByRole("button", { name: "Add Model" }).click();
        const picker = page.locator(".vm-model-picker");
        await expect(picker).toContainText("Claude Messages");
        await expect(picker).not.toContainText("GPT Chat");
        await expect(picker).not.toContainText("Codex Responses");
        await expect(picker).not.toContainText("Embedding Only");

        await picker.getByRole("button", { name: "Close" }).click();
        await endpointSelect.selectOption("responses");
        await page.getByRole("button", { name: "Add Model" }).click();
        await expect(picker).toContainText("GPT Chat");
        await expect(picker).toContainText("Codex Responses");
        await expect(picker).not.toContainText("Claude Messages");
        await expect(picker).not.toContainText("Embedding Only");

        await picker.getByRole("button", { name: "Codex Responses" }).click();
        await page.getByLabel("Virtual Model name", { exact: true }).fill("vm-endpoint-api");
        await page.getByLabel("Description").fill("Duplicate model name");
        await page.getByRole("button", { name: "Create", exact: true }).click();
        await expect(page).toHaveURL(/virtualModelDialog=new/);
        await expect(page.getByRole("alert")).toBeVisible();
        expect(browserErrors).toEqual([]);
        expect(mutationRequests).toContain(`${baseUrl}/api/virtual-models`);
        await expect(page.getByText("Virtual Model name already exists.")).toBeVisible();
        await expect(page.getByLabel("Virtual Model name", { exact: true })).toHaveAttribute(
          "aria-invalid",
          "true",
        );

        await page.goto(`${baseUrl}/models?virtualModelDelete=${seeded.virtualModelId}`, {
          waitUntil: "networkidle",
        });
        const deleteDialog = page.getByRole("dialog", { name: "Delete vm-endpoint-api?" });
        await expect(deleteDialog).not.toContainText("Route Policy");
        await deleteDialog.getByRole("button", { name: "Delete" }).click();
        await expect(page).toHaveURL(`${baseUrl}/models`);
        await expect(page.getByText("vm-endpoint-api", { exact: true })).toHaveCount(0);

        const routePolicyState = await withDedicatedPostgresClient(
          fixture.databaseUrl,
          async (client) =>
            client.query<{ deleted_at: Date | null }>(
              "select deleted_at from route_policies where id = $1",
              [seeded.routePolicyId],
            ),
        );
        expect(routePolicyState.rows[0]?.deleted_at).toBeInstanceOf(Date);
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

async function seedVirtualModelEndpointData(databaseUrl: string): Promise<{
  embeddingOnlyModelId: string;
  openAiModelId: string;
  routePolicyId: string;
  virtualModelId: string;
}> {
  const openAiProviderId = randomUUID();
  const anthropicProviderId = randomUUID();
  const codexProviderId = randomUUID();
  const openAiModelId = randomUUID();
  const embeddingOnlyModelId = randomUUID();
  const anthropicModelId = randomUUID();
  const codexModelId = randomUUID();
  const virtualModelId = randomUUID();
  const routePolicyId = randomUUID();

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
        values ($1, $2, 'gpt-chat', 'GPT Chat', array['text']::text[], array['text', 'embedding']::text[], 128000, 8192, true, true, false, 'available'),
               ($3, $2, 'embedding-only', 'Embedding Only', array['text']::text[], array['embedding']::text[], 8192, null, false, false, false, 'available'),
               ($4, $5, 'claude-msg', 'Claude Messages', array['text']::text[], array['text']::text[], 200000, 8192, true, true, false, 'available'),
               ($6, $7, 'codex-resp', 'Codex Responses', array['text']::text[], array['text']::text[], 128000, 8192, true, true, false, 'available')
      `,
      [
        openAiModelId,
        openAiProviderId,
        embeddingOnlyModelId,
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
    embeddingOnlyModelId,
    openAiModelId,
    routePolicyId,
    virtualModelId,
  };
}

async function seedVirtualModelRoutePolicy(
  databaseUrl: string,
  input: { routePolicyId: string; virtualModelId: string },
) {
  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    const providerModel = await client.query<{ id: string }>(
      "select id::text from provider_models where model_id = 'codex-resp'",
    );
    const providerModelId = providerModel.rows[0]?.id;
    if (!providerModelId) {
      throw new Error("Codex model is required for Virtual Model route fixture.");
    }
    await client.query(
      `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
       values ($1, $2, 'fixed', 'responses')`,
      [input.routePolicyId, input.virtualModelId],
    );
    await client.query(
      `insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
       values ($1, $2, $3, 1)`,
      [randomUUID(), input.routePolicyId, providerModelId],
    );
  });
}
