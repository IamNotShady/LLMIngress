import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
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

const REQUEST_ID = "gw_recorded_detail_request";

type Seeded = {
  apiKeyId: string;
  freshConnectionId: string;
  providerId: string;
  usedConnectionId: string;
};

/**
 * A request the gateway routed: one candidate served it, one was filtered out
 * with reasons, two of the three requests were priced by the console rather
 * than by the provider, and one of the two connections has served traffic.
 */
async function seedRecordedRequest(databaseUrl: string): Promise<Seeded> {
  const apiKeyId = randomUUID();
  const providerId = randomUUID();
  const usedConnectionId = randomUUID();
  const freshConnectionId = randomUUID();
  const servingModelId = randomUUID();
  const filteredModelId = randomUUID();
  const virtualModelId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'deepseek', 'Recorded Provider', 'https://recorded.test/v1', true)`,
      [providerId],
    );
    await client.query(
      `insert into provider_api_keys (id, provider_id, key_prefix, encrypted_key, key_id, label, last_used_at)
       values ($1, $2, 'sk-used', '{"version":1}'::jsonb, 'used-key', 'serving key', now() - interval '20 minutes'),
              ($3, $2, 'sk-new', '{"version":1}'::jsonb, 'fresh-key', 'standby key', null)`,
      [usedConnectionId, providerId, freshConnectionId],
    );
    await client.query(
      `insert into provider_models (id, provider_id, model_id, display_name, availability)
       values ($1, $2, 'recorded-serving-model', 'Recorded Serving Model', 'available'),
              ($3, $2, 'recorded-filtered-model', 'Recorded Filtered Model', 'unavailable')`,
      [servingModelId, providerId, filteredModelId],
    );
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'recorded-vm', 'Recorded VM', true)`,
      [virtualModelId],
    );
    await client.query(
      `insert into api_keys (id, name, key_prefix, key_hash, enabled)
       values ($1, 'recorded-key', 'llmi_recorded', gen_random_uuid()::text, true)`,
      [apiKeyId],
    );
    await client.query(
      `insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)`,
      [apiKeyId, virtualModelId],
    );

    const routeReason = JSON.stringify({
      candidateExplanations: [
        {
          candidateOrder: 1,
          eligible: true,
          providerModelId: servingModelId,
          reasons: ["selected by cost_first strategy"],
        },
        {
          candidateOrder: 2,
          eligible: false,
          providerModelId: filteredModelId,
          reasons: ["model availability is unavailable"],
        },
      ],
      message: "cost_first route for recorded-vm",
      selectedCandidateOrder: 1,
    });

    for (const [index, costSource] of ["estimated", "estimated", "provider"].entries()) {
      const activityId = randomUUID();
      await client.query(
        `insert into request_activity (
           id, request_id, api_key_id, virtual_model_id, provider_id, provider_model_id,
           api_key_prefix, protocol, model, stream, status, http_status, latency_ms,
           route_reason, started_at, completed_at,
           api_key_name_snapshot, virtual_model_name_snapshot,
           provider_display_name_snapshot, provider_model_name_snapshot
         )
         values ($1, $2, $3, $4, $5, $6, 'llmi_recorded', 'chat_completions', 'recorded-vm', false,
                 'succeeded', 200, 120, $7::jsonb,
                 now() - make_interval(mins => $8), now() - make_interval(mins => $8),
                 'recorded-key', 'recorded-vm', 'Recorded Provider', 'recorded-serving-model')`,
        [
          activityId,
          index === 0 ? REQUEST_ID : `${REQUEST_ID}_${index}`,
          apiKeyId,
          virtualModelId,
          providerId,
          servingModelId,
          routeReason,
          index + 1,
        ],
      );
      await client.query(
        `insert into request_usage (
           id, request_activity_id, api_key_id, virtual_model_id, provider_model_id,
           input_tokens, output_tokens, total_tokens, token_source
         ) values ($1, $2, $3, $4, $5, 100, 20, 120, 'provider')`,
        [randomUUID(), activityId, apiKeyId, virtualModelId, servingModelId],
      );
      await client.query(
        `insert into request_costs (
           id, request_activity_id, api_key_id, provider_model_id, total_cost_usd, cost_source
         ) values ($1, $2, $3, $4, 1.25, $5)`,
        [randomUUID(), activityId, apiKeyId, servingModelId, costSource],
      );
    }
  });

  return { apiKeyId, freshConnectionId, providerId, usedConnectionId };
}

test("the console shows what the gateway recorded: filtered candidates, estimated cost, and which connection served", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_recorded_detail_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedRecordedRequest(fixture.databaseUrl);
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
        await page.setViewportSize({ width: 1280, height: 900 });
        await signInFromFirstRun(page, baseUrl);

        // --- The candidate that never got an attempt, and why. The gateway
        // records one explanation per candidate; the drawer used to render
        // only the summary line, so the answer to "why not that provider" was
        // in the database and on no screen.
        await page.goto(`${baseUrl}/activity?request=${REQUEST_ID}`, { waitUntil: "networkidle" });
        const drawer = page.getByRole("dialog", { name: REQUEST_ID });
        await expect(drawer).toBeVisible();
        await expect(drawer.getByText("cost_first route for recorded-vm")).toBeVisible();
        await expect(drawer.getByText("FILTERED OUT")).toBeVisible();
        await expect(
          drawer.getByText(
            "Recorded Provider · Recorded Filtered Model — model availability is unavailable",
          ),
        ).toBeVisible();
        // The candidate that served is not in that list: it was not filtered.
        await expect(drawer.getByText("Recorded Serving Model — selected")).toHaveCount(0);

        // --- Cost is not one kind of number. Two of the three requests were
        // priced by the console because the provider did not say what it
        // charged, and the total alone reads as if all three were billed.
        await page.goto(`${baseUrl}/api-keys?selected=${seeded.apiKeyId}`, {
          waitUntil: "networkidle",
        });
        await expect(page.getByText("(2 estimated)")).toBeVisible();

        // --- Which credential is actually serving. The column is in the
        // design's connections table and the value reached the component and
        // was dropped.
        await page.goto(`${baseUrl}/providers?selected=${seeded.providerId}`, {
          waitUntil: "networkidle",
        });
        await expect(page.getByText("LAST USED")).toBeVisible();
        await expect(page.getByText("20 min ago")).toBeVisible();
        await expect(page.getByText("never")).toBeVisible();
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

/**
 * The design's vocabulary, on the screens that use it: compact context windows,
 * capabilities said as tools/vision/reasoning, a request list that says which
 * second a request started in, and a limits table whose columns hold the three
 * states the design gives them.
 */
async function seedDesignVocabulary(databaseUrl: string): Promise<{
  apiKeyId: string;
  providerId: string;
  virtualModelId: string;
}> {
  const apiKeyId = randomUUID();
  const bareKeyId = randomUUID();
  const providerId = randomUUID();
  const providerModelId = randomUUID();
  const virtualModelId = randomUUID();
  const activityId = randomUUID();

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'deepseek', 'Vocabulary Provider', 'https://vocab.test/v1', true)`,
      [providerId],
    );
    await client.query(
      `insert into provider_models (
         id, provider_id, model_id, display_name, availability, context_window,
         supports_function_calling, supports_reasoning, input_modalities, output_modalities
       ) values ($1, $2, 'vocab-model', 'Vocab Model', 'available', 200000, true, false,
                 '{text,image}', '{text}')`,
      [providerModelId, providerId],
    );
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'vocab-vm', 'Vocab VM', true)`,
      [virtualModelId],
    );
    const routePolicyId = randomUUID();
    await client.query(
      `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol)
       values ($1, $2, 'fixed', 'chat_completions')`,
      [routePolicyId, virtualModelId],
    );
    await client.query(
      `insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order)
       values ($1, $2, $3, 1)`,
      [randomUUID(), routePolicyId, providerModelId],
    );
    await client.query(
      `insert into api_keys (id, name, key_prefix, key_hash, enabled, limits_enabled)
       values ($1, 'vocab-key', 'llmi_vocab', gen_random_uuid()::text, true, false),
              ($2, 'bare-key', 'llmi_bare', gen_random_uuid()::text, true, true)`,
      [apiKeyId, bareKeyId],
    );
    await client.query(
      `insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)`,
      [apiKeyId, virtualModelId],
    );
    // Rules kept but switched off: the ceiling is not what this key runs under.
    await client.query(
      `insert into api_key_limits (id, api_key_id, limit_type, period, limit_value, unit)
       values ($1, $2, 'budget', 'month', 20, 'usd')`,
      [randomUUID(), apiKeyId],
    );
    // Served, but only after the first candidate failed.
    await client.query(
      `insert into request_activity (
         id, request_id, api_key_id, virtual_model_id, provider_id, provider_model_id,
         api_key_prefix, protocol, model, stream, status, http_status, latency_ms,
         started_at, completed_at, api_key_name_snapshot, virtual_model_name_snapshot
       )
       values ($1, 'gw_vocab_request', $2, $3, $4, $5, 'llmi_vocab', 'chat_completions',
               'vocab-vm', false, 'succeeded', 200, 120,
               now() - interval '5 minutes', now() - interval '5 minutes',
               'vocab-key', 'vocab-vm')`,
      [activityId, apiKeyId, virtualModelId, providerId, providerModelId],
    );
    await client.query(
      `insert into fallback_events (
         id, request_activity_id, provider_model_id, attempt_order, status, error_code, created_at
       ) values ($1, $2, $3, 1, 'failed', 'provider_http_error', now() - interval '5 minutes'),
                ($4, $2, $3, 2, 'succeeded', null, now() - interval '5 minutes')`,
      [randomUUID(), activityId, providerModelId, randomUUID()],
    );
  });

  return { apiKeyId, providerId, virtualModelId };
}

test("the console says what the design says: compact context, capability words, seconds, and limit states", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_design_words_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedDesignVocabulary(fixture.databaseUrl);
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
        await page.setViewportSize({ width: 1440, height: 900 });
        await signInFromFirstRun(page, baseUrl);

        // --- A 200,000-token window is 200k, and what the model can do is said
        // as tools · vision: the modalities were on the row and unread.
        await page.goto(`${baseUrl}/providers?selected=${seeded.providerId}`, {
          waitUntil: "networkidle",
        });
        await expect(page.getByText("200k")).toBeVisible();
        await expect(page.getByText("tools · vision")).toBeVisible();

        // --- The route table names the same number, because a candidate is
        // picked against the ones already in the route.
        await page.goto(`${baseUrl}/models?selected=${seeded.virtualModelId}`, {
          waitUntil: "networkidle",
        });
        await expect(page.getByText("CTX", { exact: true })).toBeVisible();
        await expect(page.getByText("200k")).toBeVisible();

        // --- What a key can reach is what it is for.
        await page.goto(`${baseUrl}/api-keys`, { waitUntil: "networkidle" });
        await expect(page.getByText("llmi_vocab · 1 model")).toBeVisible();
        await expect(page.getByText("llmi_bare · 0 models")).toBeVisible();

        // --- Limits has three states, and a key whose rules are switched off
        // is not running under its ceiling.
        await page.goto(`${baseUrl}/limits`, { waitUntil: "networkidle" });
        await expect(page.getByText("rules kept")).toBeVisible();
        await expect(page.getByText("no rules")).toBeVisible();
        await expect(page.getByText("on · block")).toHaveCount(0);

        // --- A request list says which second a request started in, and a
        // request that was served only after a failure says so.
        await page.goto(`${baseUrl}/activity`, { waitUntil: "networkidle" });
        await expect(page.getByText(/^\d\d:\d\d:\d\d$/)).toBeVisible();
        await page.goto(`${baseUrl}/activity?request=gw_vocab_request`, {
          waitUntil: "networkidle",
        });
        await expect(page.getByText("200 · served by fallback")).toBeVisible();

        // --- Six filters and a search box: the way back is a control.
        await page.goto(`${baseUrl}/activity?status=failed`, { waitUntil: "networkidle" });
        await expect(page.getByRole("link", { name: "Clear", exact: true })).toBeVisible();
        await page.goto(`${baseUrl}/activity`, { waitUntil: "networkidle" });
        await expect(page.getByRole("link", { name: "Clear", exact: true })).toHaveCount(0);

        // --- The failure rate says what the failure count leaves out.
        await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
        await expect(page.getByText("0 failed · 1 fallback")).toBeVisible();
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
