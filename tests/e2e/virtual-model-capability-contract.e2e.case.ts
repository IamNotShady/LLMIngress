import { randomUUID } from "node:crypto";
import {
  createRoutePolicy,
  normalizeRoutePolicyFormInput,
} from "@llmingress/db/console-route-policies";
import {
  createVirtualModelWithRoute,
  normalizeVirtualModelFormInput,
} from "@llmingress/db/console-virtual-models";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import { seedOpenAIGatewayRoute } from "../support/gateway-route-seed";

const apiKey = "llmi_virtual_model_capability_contract_key";

test("route policy save allows unknown and rejects differing provider model capabilities", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_contract_console_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedRoutePolicyCapabilityData(fixture);

    await expect(
      createRoutePolicy({
        databaseUrl: fixture.databaseUrl,
        routePolicy: normalizeRoutePolicyFormInput({
          endpointProtocol: "chat_completions",
          providerModelIds: [seeded.completeModelId, seeded.mismatchedModelId],
          strategy: "fixed",
          virtualModelId: seeded.virtualModelId,
        }),
      }),
    ).rejects.toMatchObject({
      code: "route_policy_candidate_capability_mismatch",
    });

    await expect(
      createRoutePolicy({
        databaseUrl: fixture.databaseUrl,
        routePolicy: normalizeRoutePolicyFormInput({
          endpointProtocol: "chat_completions",
          providerModelIds: [seeded.incompleteModelId],
          strategy: "fixed",
          virtualModelId: seeded.virtualModelId,
        }),
      }),
    ).resolves.toMatchObject({
      virtualModelId: seeded.virtualModelId,
    });
  } finally {
    await fixture.dispose();
  }
});

test("route policy save reports exact conflicting context windows", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_ctx_conflict_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const providerId = randomUUID();
    const roundModelId = randomUUID();
    const oddModelId = randomUUID();
    const virtualModelId = randomUUID();

    await fixture.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'openai', 'Context Provider', 'http://provider.test/v1', true)`,
      [providerId],
    );
    await fixture.query(
      "insert into virtual_models (id, name, description, enabled) values ($1, 'vm-ctx-conflict', 'VM ctx conflict', true)",
      [virtualModelId],
    );
    for (const [id, contextWindow, modelId] of [
      [roundModelId, 1_000_000, "round-context"],
      [oddModelId, 1_048_576, "odd-context"],
    ] as const) {
      await fixture.query(
        `insert into provider_models (
           id, provider_id, model_id, display_name,
           input_modalities, output_modalities, context_window, max_output_tokens,
           supports_streaming, supports_function_calling, supports_reasoning, availability
         )
         values ($1, $2, $3, 'Context Model', array['text']::text[], array['text']::text[], $4, 8192, true, true, false, 'available')`,
        [id, providerId, modelId, contextWindow],
      );
    }

    const error = await createRoutePolicy({
      databaseUrl: fixture.databaseUrl,
      routePolicy: normalizeRoutePolicyFormInput({
        endpointProtocol: "chat_completions",
        providerModelIds: [roundModelId, oddModelId],
        strategy: "fixed",
        virtualModelId,
      }),
    }).then(
      () => {
        throw new Error("expected the mismatched context windows to be rejected");
      },
      (rejection: unknown) => rejection,
    );

    expect(error).toMatchObject({ code: "route_policy_candidate_capability_mismatch" });
    expect((error as { message: string }).message).toContain("maxContextTokens");
    expect((error as { message: string }).message).toContain("1000000");
    expect((error as { message: string }).message).toContain("1048576");
  } finally {
    await fixture.dispose();
  }
});

test("virtual model creation atomically requires and writes its route", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_atomic_create_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedRoutePolicyCapabilityData(fixture);
    const versionBefore = await countRows(fixture, "config_versions");

    await expect(
      createVirtualModelWithRoute({
        databaseUrl: fixture.databaseUrl,
        routePolicy: {
          endpointProtocol: "chat_completions",
          providerModelIds: [],
          strategy: "fixed",
        },
        virtualModel: normalizeVirtualModelFormInput({
          description: "Atomic empty route",
          name: "vm-atomic-empty",
        }),
      }),
    ).rejects.toMatchObject({ code: "route_policy_candidates_required" });

    expect(await countVirtualModelsByName(fixture, ["vm-atomic-empty"])).toBe(0);
    expect(await countRows(fixture, "config_versions")).toBe(versionBefore);

    await expect(
      createVirtualModelWithRoute({
        databaseUrl: fixture.databaseUrl,
        routePolicy: {
          endpointProtocol: "chat_completions",
          providerModelIds: [seeded.completeModelId, seeded.mismatchedModelId],
          strategy: "fixed",
        },
        virtualModel: normalizeVirtualModelFormInput({
          description: "Atomic rollback route",
          name: "vm-atomic-rollback",
        }),
      }),
    ).rejects.toMatchObject({ code: "route_policy_candidate_capability_mismatch" });

    expect(await countVirtualModelsByName(fixture, ["vm-atomic-empty", "vm-atomic-rollback"])).toBe(
      0,
    );
    expect(await countRows(fixture, "config_versions")).toBe(versionBefore);

    const created = await createVirtualModelWithRoute({
      databaseUrl: fixture.databaseUrl,
      routePolicy: {
        endpointProtocol: "chat_completions",
        providerModelIds: [seeded.completeModelId],
        strategy: "cost_first",
      },
      virtualModel: normalizeVirtualModelFormInput({
        description: "Atomic success route",
        name: "vm-atomic-success",
      }),
    });

    expect(created.routePolicy).toMatchObject({
      endpointProtocol: "chat_completions",
      strategy: "cost_first",
      virtualModelId: created.virtualModel.id,
    });
    expect(created.routePolicy.candidates).toHaveLength(1);
    expect(await countRows(fixture, "config_versions")).toBe(versionBefore + 1);
    const latestVersion = await fixture.query<{ changes: Array<{ table: string }> }>(
      "select changes from config_versions order by version desc limit 1",
    );
    expect(latestVersion.rows[0]?.changes.map((change) => change.table)).toEqual([
      "virtual_models",
      "route_policies",
      "route_policy_candidates",
    ]);
  } finally {
    await fixture.dispose();
  }
});

test("gateway rejects requests that exceed the Virtual Model capability contract before provider calls", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_contract_gateway_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      providerBaseUrl: provider.url,
      virtualModelName: "vm-contract-gateway",
    });
    await fixture.query(
      `
        update provider_models
        set input_modalities = array['text']::text[],
            output_modalities = array['text']::text[],
            context_window = 8192,
            max_output_tokens = 1024,
            supports_function_calling = false,
            supports_reasoning = false
      `,
    );

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-contract-gateway",
          tools: [{ function: { name: "lookup" }, type: "function" }],
        }),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toMatchObject({
        error: { code: "virtual_model_capability_mismatch" },
      });
      expect(provider.requests).toHaveLength(0);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

test("gateway skips request checks for unknown Virtual Model capability fields", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_vm_contract_unknown_${randomUUID().replaceAll("-", "_")}`,
  });
  const provider = await createFakeProviderServer();

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      apiKey,
      fixture,
      providerBaseUrl: provider.url,
      virtualModelName: "vm-contract-unknown",
    });
    await fixture.query(
      `
        update provider_models
        set input_modalities = array['text']::text[],
            output_modalities = array['text']::text[],
            context_window = 8192,
            max_output_tokens = 2048,
            supports_function_calling = null,
            supports_reasoning = false
      `,
    );

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });

    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        body: JSON.stringify({
          messages: [{ content: "ping", role: "user" }],
          model: "vm-contract-unknown",
          tools: [{ function: { name: "lookup" }, type: "function" }],
        }),
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

      expect(response.status).toBe(200);
      expect(provider.requests).toHaveLength(1);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await provider.close();
    await fixture.dispose();
  }
});

type Fixture = Awaited<ReturnType<typeof createTestPostgresFixture>>;

async function countRows(fixture: Fixture, table: "config_versions"): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    `select count(*)::integer as count from ${table}`,
  );
  return result.rows[0]?.count ?? 0;
}

async function countVirtualModelsByName(fixture: Fixture, names: string[]): Promise<number> {
  const result = await fixture.query<{ count: number }>(
    "select count(*)::integer as count from virtual_models where name = any($1::text[])",
    [names],
  );
  return result.rows[0]?.count ?? 0;
}

async function seedRoutePolicyCapabilityData(fixture: Fixture): Promise<{
  completeModelId: string;
  incompleteModelId: string;
  mismatchedModelId: string;
  virtualModelId: string;
}> {
  const providerId = randomUUID();
  const completeModelId = randomUUID();
  const incompleteModelId = randomUUID();
  const mismatchedModelId = randomUUID();
  const virtualModelId = randomUUID();

  await fixture.query(
    `
      insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
      values ($1, 'api_key', 'openai', 'Capability Provider', 'http://provider.test/v1', true)
    `,
    [providerId],
  );
  await fixture.query(
    "insert into virtual_models (id, name, description, enabled) values ($1, 'vm-contract-console', 'VM Contract Console', true)",
    [virtualModelId],
  );
  await insertProviderModel(fixture, {
    id: completeModelId,
    maxOutputTokens: 8192,
    providerId,
    supportsReasoning: false,
  });
  await insertProviderModel(fixture, {
    id: mismatchedModelId,
    maxOutputTokens: 4096,
    providerId,
    supportsReasoning: false,
  });
  await insertProviderModel(fixture, {
    id: incompleteModelId,
    maxOutputTokens: null,
    providerId,
    supportsReasoning: false,
  });

  return { completeModelId, incompleteModelId, mismatchedModelId, virtualModelId };
}

async function insertProviderModel(
  fixture: Fixture,
  input: {
    id: string;
    maxOutputTokens: number | null;
    providerId: string;
    supportsReasoning: boolean | null;
  },
): Promise<void> {
  await fixture.query(
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
      values ($1, $2, $3, 'Capability Model', array['text']::text[], array['text']::text[], 128000, $4, true, true, $5, 'available')
    `,
    [
      input.id,
      input.providerId,
      `model-${input.id.slice(0, 8)}`,
      input.maxOutputTokens,
      input.supportsReasoning,
    ],
  );
}
