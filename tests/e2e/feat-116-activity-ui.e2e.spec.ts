import { randomUUID } from "node:crypto";
import { PostgresClient } from "@llmingress/db/client";
import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("activity page matches reference layout filters and request detail", async ({ browser }) => {
  await withConsoleDevServer(
    browser,
    async ({ page, baseUrl }) => {
      await page.goto(`${baseUrl}/activity`);

      await expect(page.getByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
      await expect(page.getByText("Inspect request metadata, routing results")).toBeVisible();

      await expect(page.getByLabel("Agent", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Virtual Model", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Provider", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Status", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Time range", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Request ID", { exact: true })).toBeVisible();

      const activity = page.getByLabel("Activity");
      await expect(activity.getByRole("columnheader", { name: "Time" })).toBeVisible();
      await expect(activity.getByRole("columnheader", { name: "Request ID" })).toBeVisible();
      await expect(activity.getByRole("columnheader", { name: "Agent" })).toBeVisible();
      await expect(activity.getByRole("columnheader", { name: "Virtual Model" })).toBeVisible();
      await expect(activity.getByRole("columnheader", { name: "Provider / Model" })).toBeVisible();
      await expect(activity.getByRole("columnheader", { name: "Fallbacks" })).toBeVisible();

      await page.getByRole("link", { name: "req_116_failure" }).click();
      const detail = activity.getByLabel("Request detail");
      await expect(detail.getByText("Failed", { exact: true })).toBeVisible();
      await expect(detail.getByText("req_116_failure", { exact: true })).toBeVisible();
      await expect(detail.getByText("Hermes")).toBeVisible();
      await expect(detail.getByText("cheap", { exact: true })).toBeVisible();
      await expect(detail.getByText("Ollama / qwen2.5-coder")).toBeVisible();
      await expect(
        detail.getByText("cost_first route selected cheapest fallback candidate."),
      ).toBeVisible();
      await expect(detail.getByText("1,234")).toBeVisible();
      await expect(detail.getByText("$0.00000000")).toBeVisible();
      await expect(detail.getByText("0.42s")).toBeVisible();
      await expect(detail.getByText("Connection refused")).toBeVisible();
      await expect(detail.getByText("429 Too Many Requests")).toBeVisible();
      await expect(
        detail.getByText("All providers failed: connection_error, rate_limit"),
      ).toBeVisible();
      await expect(detail.getByText("user_id: u_12345")).toBeVisible();
      await expect(detail.getByText("channel: cli")).toBeVisible();
      await expect(detail.getByText("Prompt / response bodies are not stored.")).toBeVisible();

      await page.getByLabel("Status", { exact: true }).selectOption("succeeded");
      await page.getByLabel("Request ID", { exact: true }).fill("req_116_success");
      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page.getByRole("link", { name: "req_116_success" })).toBeVisible();
      await expect(page.getByRole("link", { name: "req_116_failure" })).toHaveCount(0);
      await expect(detail.getByText("req_116_success", { exact: true })).toBeVisible();

      await page.setViewportSize({ width: 390, height: 900 });
      const overflow = await page.evaluate(() => document.body.scrollWidth > window.innerWidth);
      expect(overflow).toBe(false);
      await expect(detail).toBeVisible();
    },
    { seed: seedActivityReferenceData },
  );
});

async function seedActivityReferenceData(databaseUrl: string): Promise<void> {
  const client = new PostgresClient({ connectionString: databaseUrl });
  await client.connect();
  try {
    const agentId = randomUUID();
    const providerId = randomUUID();
    const selectedModelId = randomUUID();
    const fallbackModelId = randomUUID();
    const finalModelId = randomUUID();
    const virtualModelId = randomUUID();
    const routePolicyId = randomUUID();
    const failureActivityId = randomUUID();
    const successActivityId = randomUUID();

    await client.query(
      `
        insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
        values ($1, 'local', 'ollama', 'Ollama', 'http://127.0.0.1:11434/v1', true)
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
          context_window,
          supports_streaming,
          supports_tools,
          availability
        )
        values ($1, $2, 'qwen2.5-coder', 'qwen2.5-coder', 32768, true, true, 'available'),
               ($3, $2, 'gpt-4o-mini', 'gpt-4o-mini', 128000, true, true, 'available'),
               ($4, $2, 'claude-3-haiku', 'claude-3-haiku', 200000, true, true, 'available')
      `,
      [selectedModelId, providerId, fallbackModelId, finalModelId],
    );
    await client.query(
      "insert into virtual_models (id, name, description, enabled) values ($1, 'cheap', 'cheap', true)",
      [virtualModelId],
    );
    await client.query(
      "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'cost_first')",
      [routePolicyId, virtualModelId],
    );
    await client.query(
      `
        insert into agents (
          id,
          name,
          agent_type,
          key_prefix,
          key_hash,
          default_virtual_model_id,
          enabled
        )
        values ($1, 'Hermes', 'coding', 'llmi_116', 'hash-116', $2, true)
      `,
      [agentId, virtualModelId],
    );
    await client.query(
      `
        insert into request_activity (
          id,
          request_id,
          agent_id,
          virtual_model_id,
          route_policy_id,
          provider_id,
          provider_model_id,
          agent_key_prefix,
          protocol,
          model,
          stream,
          route_reason,
          fallback_attempts,
          request_metadata,
          response_metadata,
          provider_api_key_prefix,
          agent_name_snapshot,
          virtual_model_name_snapshot,
          provider_display_name_snapshot,
          provider_model_display_name_snapshot,
          provider_model_name_snapshot,
          status,
          error_code,
          error_message,
          http_status,
          latency_ms,
          started_at,
          completed_at
        )
        values (
          $1,
          'req_116_failure',
          $2,
          $3,
          $4,
          $5,
          $6,
          'llmi_116',
          'messages',
          'cheap',
          false,
          $7::jsonb,
          '[]'::jsonb,
          $8::jsonb,
          '{}'::jsonb,
          'llmi_...8af',
          'Hermes',
          'cheap',
          'Ollama',
          'qwen2.5-coder',
          'qwen2.5-coder',
          'failed',
          'provider_request_failed',
          'All providers failed: connection_error, rate_limit',
          502,
          420,
          '2026-06-23T10:23:22.000Z',
          '2026-06-23T10:23:22.420Z'
        ),
        (
          $9,
          'req_116_success',
          $2,
          $3,
          $4,
          $5,
          $10,
          'llmi_116',
          'messages',
          'cheap',
          false,
          '{"message":"fixed route selected configured candidate."}'::jsonb,
          '[]'::jsonb,
          '{"channel":"cli","region":"local","user_id":"u_12345"}'::jsonb,
          '{}'::jsonb,
          'llmi_...8af',
          'Hermes',
          'cheap',
          'Ollama',
          'claude-3-haiku',
          'claude-3-haiku',
          'succeeded',
          null,
          null,
          200,
          910,
          '2026-06-23T10:23:41.000Z',
          '2026-06-23T10:23:41.910Z'
        )
      `,
      [
        failureActivityId,
        agentId,
        virtualModelId,
        routePolicyId,
        providerId,
        selectedModelId,
        JSON.stringify({
          message: "cost_first route selected cheapest fallback candidate.",
          strategy: "cost_first",
        }),
        JSON.stringify({
          channel: "cli",
          region: "local",
          user_id: "u_12345",
        }),
        successActivityId,
        finalModelId,
      ],
    );
    await client.query(
      `
        insert into fallback_events (
          id,
          request_activity_id,
          provider_model_id,
          attempt_order,
          status,
          error_code,
          error_message,
          failed_before_first_byte,
          provider_api_key_prefix
        )
        values ($1, $2, $3, 1, 'failed', 'connection_error', 'Connection refused', true, 'llmi_...8af'),
               ($4, $2, $5, 2, 'failed', 'rate_limit', '429 Too Many Requests', false, 'llmi_...8af'),
               ($6, $2, $7, 3, 'succeeded', null, null, false, 'llmi_...8af')
      `,
      [
        randomUUID(),
        failureActivityId,
        selectedModelId,
        randomUUID(),
        fallbackModelId,
        randomUUID(),
        finalModelId,
      ],
    );
    await client.query(
      `
        insert into request_usage (
          id,
          request_activity_id,
          agent_id,
          virtual_model_id,
          provider_model_id,
          input_tokens,
          output_tokens,
          total_tokens,
          token_source
        )
        values ($1, $2, $3, $4, $5, 1000, 234, 1234, 'provider'),
               ($6, $7, $3, $4, $8, 1000, 345, 1345, 'provider')
      `,
      [
        randomUUID(),
        failureActivityId,
        agentId,
        virtualModelId,
        selectedModelId,
        randomUUID(),
        successActivityId,
        finalModelId,
      ],
    );
    await client.query(
      `
        insert into request_costs (
          id,
          request_activity_id,
          agent_id,
          provider_model_id,
          input_cost_usd,
          output_cost_usd,
          total_cost_usd,
          cost_source,
          actual_cost_usd,
          baseline_cost_usd,
          savings_usd
        )
        values ($1, $2, $3, $4, 0, 0, 0, 'estimated', 0, 0, 0),
               ($5, $6, $3, $7, 0.0001, 0.0002, 0.0003, 'estimated', 0.0003, 0.0005, 0.0002)
      `,
      [
        randomUUID(),
        failureActivityId,
        agentId,
        selectedModelId,
        randomUUID(),
        successActivityId,
        finalModelId,
      ],
    );
  } finally {
    await client.end();
  }
}
