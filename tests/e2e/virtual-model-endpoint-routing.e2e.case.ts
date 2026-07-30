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

        await page.goto(`${baseUrl}/models?dialog=new`, { waitUntil: "networkidle" });

        // The endpoint list offers only protocols the gateway serves — an
        // embeddings route is not something this console can build.
        const endpointSelect = page.locator("#virtual-model-dialog-endpoint");
        await expect(endpointSelect.locator('option[value="embeddings"]')).toHaveCount(0);

        // The endpoint choice decides which candidates are selectable, so it has
        // to reach the candidate list rather than sit in the form until save.
        await endpointSelect.selectOption("messages");
        await page.waitForURL(/protocol=messages/);

        const providerFilter = page.getByLabel("Filter candidates by provider");
        const candidates = page.getByTestId("virtual-model-candidates");

        // Picking a provider shows its models at once — no Apply in between.
        const pickProvider = async (label: string) => {
          await providerFilter.selectOption({ label });
          await page.waitForLoadState("networkidle");
        };

        // The protocol decides which providers are worth offering at all: a
        // provider that cannot serve it has nothing to contribute, and listing
        // it would fill the browser with rows that refuse to be picked.
        await expect(providerFilter.locator("option")).toHaveText(["Anthropic"]);
        await expect(candidates.getByRole("link", { name: /claude-msg/ })).toBeVisible();

        // Switching the endpoint re-reads the choice: OpenAI serves chat, so it
        // appears, and the provider the browser was on has to move with it.
        await endpointSelect.selectOption("chat_completions");
        await page.waitForURL(/protocol=chat_completions/);
        await expect(providerFilter.locator("option")).toHaveText(["OpenAI"]);
        await expect(candidates.getByRole("link", { name: /gpt-chat/ })).toBeVisible();
        // An embedding-only model serves no chat endpoint either way.
        await expect(candidates.getByRole("link", { name: /embedding-only/ })).toHaveCount(0);

        await endpointSelect.selectOption("responses");
        await page.waitForURL(/protocol=responses/);
        await pickProvider("OpenAI Codex");
        await candidates.getByRole("link", { name: /codex-resp/ }).click();
        await expect(page.getByText("1 selected")).toBeVisible();

        // Typing survives the candidate click: the draft is not thrown away by
        // the navigation that adds a model to the list.
        const nameField = page.getByLabel("NAME", { exact: false });
        await nameField.fill("vm-endpoint-api");
        await page.getByLabel("DESCRIPTION").fill("Duplicate model name");
        await candidates.getByRole("link", { name: /codex-resp/ }).click();
        await expect(nameField).toHaveValue("vm-endpoint-api");

        await candidates.getByRole("link", { name: /codex-resp/ }).click();
        await expect(page.getByText("1 selected")).toBeVisible();

        // A refused save keeps the operator in the editor with everything they
        // entered, and names the field to fix.
        await page.getByRole("button", { name: "Create virtual model" }).click();
        await expect(page).toHaveURL(/dialog=new/);
        await expect(page.getByRole("alert")).toBeVisible();
        expect(mutationRequests).toContain(`${baseUrl}/api/virtual-models`);
        await expect(page.getByText("Virtual Model name already exists.")).toBeVisible();
        await expect(nameField).toHaveAttribute("aria-invalid", "true");
        await expect(nameField).toHaveValue("vm-endpoint-api");
        // The refusal itself is an HTTP 409 the browser logs; nothing else may
        // have gone wrong on the way.
        expect(browserErrors.filter((entry) => !entry.includes("409"))).toEqual([]);

        await page.goto(`${baseUrl}/models?selected=${seeded.virtualModelId}&dialog=delete`, {
          waitUntil: "networkidle",
        });
        const deleteDialog = page.getByRole("dialog", { name: "Delete virtual model" });
        await expect(deleteDialog).toContainText("vm-endpoint-api");
        await deleteDialog.getByLabel("TYPE THE MODEL NAME TO CONFIRM").fill("vm-endpoint-api");
        await deleteDialog.getByRole("button", { name: "Delete model" }).click();
        await page.waitForURL(`${baseUrl}/models`);
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

test("route dialog allows capability differences to be selected and explains them on save", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_context_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedNearMillionContextModels(fixture.databaseUrl);

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

        await page.goto(`${baseUrl}/models?dialog=new`, { waitUntil: "networkidle" });
        await page.locator("#virtual-model-dialog-endpoint").selectOption("chat_completions");
        await page.waitForURL(/protocol=chat_completions/);

        const candidates = page.getByTestId("virtual-model-candidates");
        await expect(page.getByText("KNOWN CAPABILITIES MUST AGREE")).toBeVisible();
        await candidates.getByRole("link", { name: /round-context/ }).click();
        await expect(page.getByText("1 selected")).toBeVisible();

        // Capability differences do not gray out the candidate: both remain
        // selectable so the validation happens only when the route is saved.
        const selected = page.getByTestId("virtual-model-selected");
        await expect(selected).toContainText("ctx 1M");
        await expect(candidates).toContainText("ctx 1.05M");
        await candidates.getByRole("link", { name: /odd-context/ }).click();
        await expect(page.getByText("2 selected")).toBeVisible();

        // The wide editor scrolls inside its own container; the page must not
        // gain horizontal overflow at desktop or mobile checkpoints.
        for (const viewport of [
          { width: 1280, height: 800 },
          { width: 390, height: 844 },
        ]) {
          await page.setViewportSize(viewport);
          await expect
            .poll(() =>
              page.evaluate(
                () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
              ),
            )
            .toBeLessThanOrEqual(0);
        }
        await page.setViewportSize({ width: 1280, height: 800 });

        await page.getByLabel("NAME", { exact: false }).fill("vm-context-clarity");
        await page.getByLabel("DESCRIPTION").fill("Two near-identical context windows");
        await page.getByRole("button", { name: "Create virtual model" }).click();
        await expect(page).toHaveURL(/dialog=new/);
        const capabilityError = page
          .locator('p[role="alert"]')
          .filter({ hasText: "must agree on maxContextTokens" });
        await expect(capabilityError).toContainText("1000000");
        await expect(capabilityError).toContainText("1048576");
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

async function seedNearMillionContextModels(databaseUrl: string): Promise<void> {
  const providerId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, enabled)
        values ($1, 'api_key', 'openai', 'Context Provider', true)
      `,
      [providerId],
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
        values
          ($1, $3, 'round-context', 'Round Context Model', array['text']::text[], array['text']::text[], 1000000, 8192, true, true, false, 'available'),
          ($2, $3, 'odd-context', 'Odd Context Model', array['text']::text[], array['text']::text[], 1048576, 8192, true, true, false, 'available')
      `,
      [randomUUID(), randomUUID(), providerId],
    );
  });
}

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
