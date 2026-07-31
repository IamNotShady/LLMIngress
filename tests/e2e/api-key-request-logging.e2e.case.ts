import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import {
  createTestPostgresFixture,
  runMigrations,
  withDedicatedPostgresClient,
} from "../../packages/db/src/index";
import {
  getFreePort as getFreeConsolePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
import { createFakeProviderServer } from "../support/fake-provider";
import {
  getFreePort,
  startGatewayProcess,
  stopGatewayProcess,
  waitForGateway,
} from "../support/gateway-process";
import { seedOpenAIGatewayRoute } from "../support/gateway-route-seed";

const FULL_KEY = "llmi_request_logging_full_key";
const DEFAULT_KEY = "llmi_request_logging_default_key";
const ERROR_KEY = "llmi_request_logging_error_key";
const REQUEST_ID = "gw_request_logging_detail";

type StoredPayload = {
  requestBody: unknown;
  requestBytes: number;
  requestTruncated: boolean;
  responseBody: unknown;
  responseBytes: number;
  responseTruncated: boolean;
} | null;

test("a full-logging key keeps both bodies and a default key keeps none", async () => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_request_logging_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await seedOpenAIGatewayRoute({
      apiKey: FULL_KEY,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "logging-full-vm",
    });
    await seedOpenAIGatewayRoute({
      apiKey: DEFAULT_KEY,
      fixture,
      providerBaseUrl: fakeProvider.url,
      virtualModelName: "logging-default-vm",
    });
    await seedOpenAIGatewayRoute({
      apiKey: ERROR_KEY,
      fixture,
      providerBaseUrl: `${fakeProvider.url}?mode=error`,
      virtualModelName: "logging-error-vm",
    });
    // Only the two keys that are meant to capture are switched over: the third
    // stays on the mode every key starts with, which is what makes its null
    // payload evidence rather than an accident.
    await fixture.query(
      "update api_keys set request_logging_mode = 'full' where key_prefix = any($1::text[])",
      [[FULL_KEY.slice(0, 12), ERROR_KEY.slice(0, 12)]],
    );

    const gateway = startGatewayProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreePort(),
    });
    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const jsonResponse = await postChatCompletion({
        apiKey: FULL_KEY,
        baseUrl,
        model: "logging-full-vm",
        prompt: "capture-this-prompt",
      });
      expect(jsonResponse.status).toBe(200);

      const streamResponse = await postChatCompletion({
        apiKey: FULL_KEY,
        baseUrl,
        model: "logging-full-vm",
        prompt: "capture-this-stream",
        stream: true,
      });
      expect(streamResponse.status).toBe(200);
      await streamResponse.text();

      const defaultResponse = await postChatCompletion({
        apiKey: DEFAULT_KEY,
        baseUrl,
        model: "logging-default-vm",
        prompt: "never-captured-prompt",
      });
      expect(defaultResponse.status).toBe(200);

      const errorResponse = await postChatCompletion({
        apiKey: ERROR_KEY,
        baseUrl,
        model: "logging-error-vm",
        prompt: "capture-this-failure",
      });
      expect(errorResponse.status).toBeGreaterThanOrEqual(500);

      const jsonPayload = await readRecordedPayload(fixture, "capture-this-prompt");
      expect(JSON.stringify(jsonPayload?.requestBody)).toContain("capture-this-prompt");
      expect(jsonPayload?.requestTruncated).toBe(false);
      expect(jsonPayload?.requestBytes).toBeGreaterThan(0);
      expect(JSON.stringify(jsonPayload?.responseBody)).toContain("fake provider response");

      const streamPayload = await readRecordedPayload(fixture, "capture-this-stream");
      expect(JSON.stringify(streamPayload?.requestBody)).toContain("capture-this-stream");
      expect(typeof streamPayload?.responseBody).toBe("string");
      expect(streamPayload?.responseBody as string).toContain("data: ");
      expect(streamPayload?.responseBody as string).toContain("[DONE]");

      const failurePayload = await readRecordedPayload(fixture, "capture-this-failure");
      expect(JSON.stringify(failurePayload?.requestBody)).toContain("capture-this-failure");
      expect(JSON.stringify(failurePayload?.responseBody)).toContain("error");

      await expect
        .poll(
          async () => {
            const result = await fixture.query<{ payload: StoredPayload }>(
              "select payload from request_activity where model = 'logging-default-vm'",
            );
            return result.rows.length === 1 ? result.rows[0]?.payload : "not-recorded";
          },
          { timeout: 10_000 },
        )
        .toBeNull();
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});

test("the console saves the mode and shows what a full-logging key captured", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_request_logging_console_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const seeded = await seedConsoleActivity(fixture.databaseUrl);

    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      port: await getFreeConsolePort(),
    });
    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await waitForConsole(baseUrl, consoleApp);
        await page.setViewportSize({ width: 1280, height: 900 });
        await signInFromFirstRun(page, baseUrl);

        // The editor offers the mode, and saving it is what the gateway reads.
        await page.goto(`${baseUrl}/api-keys?selected=${seeded.apiKeyId}&dialog=edit`, {
          waitUntil: "networkidle",
        });
        const editor = page.getByRole("dialog", { name: "Edit API key" });
        await expect(editor).toBeVisible();
        const modeSelect = editor.getByLabel("Request logging mode");
        await expect(modeSelect).toHaveValue("default");
        await modeSelect.selectOption("full");
        await editor.getByRole("button", { name: "Save", exact: true }).click();
        await page.waitForURL((url) => url.searchParams.get("dialog") === null);

        const savedMode = await withDedicatedPostgresClient(fixture.databaseUrl, (client) =>
          client.query<{ request_logging_mode: string }>(
            "select request_logging_mode from api_keys where id = $1",
            [seeded.apiKeyId],
          ),
        );
        expect(savedMode.rows[0]?.request_logging_mode).toBe("full");

        await page.goto(`${baseUrl}/api-keys?selected=${seeded.apiKeyId}&dialog=edit`, {
          waitUntil: "networkidle",
        });
        await expect(editor.getByLabel("Request logging mode")).toHaveValue("full");

        // A request that captured bodies shows them; the sizes say what was cut.
        await page.goto(`${baseUrl}/activity?request=${REQUEST_ID}`, {
          waitUntil: "networkidle",
        });
        const drawer = page.getByRole("dialog", { name: REQUEST_ID });
        await expect(drawer).toBeVisible();
        await drawer.getByRole("group", { name: "Request body" }).click();
        await expect(drawer.getByText("captured-console-prompt")).toBeVisible();
        await drawer.getByRole("group", { name: "Response body" }).click();
        await expect(drawer.getByText("truncated at 1 MB")).toBeVisible();

        // A request whose key captured nothing says so instead of showing empty
        // bodies that were never recorded.
        await page.goto(`${baseUrl}/activity?request=${REQUEST_ID}_plain`, {
          waitUntil: "networkidle",
        });
        const plainDrawer = page.getByRole("dialog", { name: `${REQUEST_ID}_plain` });
        await expect(plainDrawer).toBeVisible();
        await expect(plainDrawer.getByText("recorded as metadata only")).toBeVisible();
        await expect(plainDrawer.getByRole("group", { name: "Request body" })).toHaveCount(0);
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

async function postChatCompletion(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  stream?: boolean;
}): Promise<Response> {
  return fetch(`${input.baseUrl}/v1/chat/completions`, {
    body: JSON.stringify({
      messages: [{ content: input.prompt, role: "user" }],
      model: input.model,
      ...(input.stream ? { stream: true } : {}),
    }),
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
}

/**
 * Recording runs as a background task after the answer is sent, so the row is
 * waited for rather than expected to already be there.
 */
async function readRecordedPayload(
  fixture: { query: <T>(text: string, values?: readonly unknown[]) => Promise<{ rows: T[] }> },
  prompt: string,
): Promise<StoredPayload> {
  let payload: StoredPayload = null;
  await expect
    .poll(
      async () => {
        const result = await fixture.query<{ payload: StoredPayload }>(
          "select payload from request_activity where payload::text like $1",
          [`%${prompt}%`],
        );
        payload = result.rows[0]?.payload ?? null;
        return payload === null ? "not-recorded" : "recorded";
      },
      { timeout: 15_000 },
    )
    .toBe("recorded");
  return payload;
}

async function seedConsoleActivity(databaseUrl: string): Promise<{ apiKeyId: string }> {
  const ids = {
    apiKeyId: randomUUID(),
    providerId: randomUUID(),
    providerModelId: randomUUID(),
    virtualModelId: randomUUID(),
  };

  await withDedicatedPostgresClient(databaseUrl, async (client) => {
    await client.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', 'openai', 'Logging Provider', 'https://logging.test/v1', true)`,
      [ids.providerId],
    );
    await client.query(
      `insert into provider_models (id, provider_id, model_id, display_name)
       values ($1, $2, 'gpt-logging', 'Logging Model')`,
      [ids.providerModelId, ids.providerId],
    );
    await client.query(
      `insert into virtual_models (id, name, description, enabled)
       values ($1, 'logging-vm', 'Logging VM', true)`,
      [ids.virtualModelId],
    );
    await client.query(
      `insert into api_keys (id, name, key_prefix, key_hash, default_virtual_model_id)
       values ($1, 'logging-key', 'llmi_logging', gen_random_uuid()::text, $2)`,
      [ids.apiKeyId, ids.virtualModelId],
    );
    await client.query(
      "insert into api_key_virtual_models (api_key_id, virtual_model_id) values ($1, $2)",
      [ids.apiKeyId, ids.virtualModelId],
    );

    for (const activity of [
      {
        payload: JSON.stringify({
          requestBody: { messages: [{ content: "captured-console-prompt", role: "user" }] },
          requestBytes: 96,
          requestTruncated: false,
          responseBody: "data: cut here",
          responseBytes: 4_194_304,
          responseTruncated: true,
        }),
        requestId: REQUEST_ID,
      },
      { payload: null, requestId: `${REQUEST_ID}_plain` },
    ]) {
      await client.query(
        `insert into request_activity (
           id, request_id, api_key_id, virtual_model_id, provider_id, provider_model_id,
           api_key_prefix, protocol, model, stream, status, http_status, latency_ms,
           route_reason, started_at, completed_at, payload,
           api_key_name_snapshot, virtual_model_name_snapshot,
           provider_display_name_snapshot, provider_model_name_snapshot
         )
         values ($1, $2, $3, $4, $5, $6, 'llmi_logging', 'chat_completions', 'logging-vm', false,
                 'succeeded', 200, 120, '{"message":"fixed route"}'::jsonb,
                 now(), now(), $7::jsonb,
                 'logging-key', 'logging-vm', 'Logging Provider', 'Logging Model')`,
        [
          randomUUID(),
          activity.requestId,
          ids.apiKeyId,
          ids.virtualModelId,
          ids.providerId,
          ids.providerModelId,
          activity.payload,
        ],
      );
    }
  });

  return { apiKeyId: ids.apiKeyId };
}
