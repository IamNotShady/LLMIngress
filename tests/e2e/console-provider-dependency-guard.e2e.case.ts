import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

test("provider delete dialog shows real route-policy blockers and POST returns 409", async ({
  page,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_provider_dependency_e2e_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const ids = await seedProviderDependency(fixture);

    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      await waitForConsole(baseUrl, consoleApp);
      await signInFromFirstRun(page, baseUrl);

      await page.goto(`${baseUrl}/providers?selected=${ids.providerId}&dialog=delete`);
      const dialog = page.getByRole("dialog", { name: "Delete provider" });
      await expect(dialog).toBeVisible();

      // The confirm names the route that holds the provider — by name, which is
      // what the Virtual Models list it sends the operator to is keyed by — says
      // the save would be refused, and offers a way forward that works. Disabling
      // is not one: the API refuses it on the same dependency.
      await expect(dialog).toContainText("dependency-vm");
      await expect(dialog).toContainText("would be refused");
      await expect(dialog).toContainText("switch its connections off");
      await expect(dialog).not.toContainText("or disable the provider");
      await expect(dialog.getByRole("button", { name: "Delete provider" })).toHaveCount(0);
      await expect(dialog.getByRole("link", { name: "Open Virtual Models" })).toBeVisible();

      const response = await page.request.post(`${baseUrl}/api/providers`, {
        form: { action: "delete", id: ids.providerId },
        headers: { origin: baseUrl },
      });
      expect(response.status()).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        code: "provider_dependency_conflict",
        error: "Provider is still used by active route policies.",
      });
    } finally {
      await stopConsoleProcess(consoleApp);
    }
  } finally {
    await fixture.dispose();
  }
});

async function seedProviderDependency(fixture: {
  databaseUrl: string;
  query: (text: string, values?: readonly unknown[]) => Promise<unknown>;
}) {
  const ids = {
    apiKeyId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    routePolicyId: randomUUID(),
    virtualModelId: randomUUID(),
  };
  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, enabled)
      values ($1, 'api_key', 'dependency-provider', 'Dependency Provider', true)
    `,
    [ids.providerId],
  );
  await fixture.query(
    `
      insert into provider_models (id, provider_id, model_id, display_name, supports_streaming, supports_function_calling)
      values ($1, $2, 'dependency-model', 'Dependency Model', true, true)
    `,
    [ids.providerModelId, ids.providerId],
  );
  await fixture.query(
    `
      insert into virtual_models (id, name, description)
      values ($1, 'dependency-vm', 'Dependency VM')
    `,
    [ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into api_keys (id, name, key_prefix, key_hash, default_virtual_model_id)
      values ($1, 'Dependency ApiKey', 'llmi_test', 'hash', $2)
    `,
    [ids.apiKeyId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
      values ($1, $2, 'fixed', 'chat_completions')
    `,
    [ids.routePolicyId, ids.virtualModelId],
  );
  await fixture.query(
    `
      insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
      values ($1, $2, $3, 1)
    `,
    [randomUUID(), ids.routePolicyId, ids.providerModelId],
  );
  return ids;
}
