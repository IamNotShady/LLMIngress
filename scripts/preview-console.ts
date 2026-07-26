/**
 * Renders the whole Console against representative data so a change can be
 * looked at rather than reasoned about: it seeds a throwaway database, starts
 * the console, and walks every page, dialog and drawer at 1440px in both
 * themes, writing screenshots to ./preview.
 *
 * It also reports the two classes of defect that are invisible in a diff and
 * expensive in review — invalid DOM nesting (a form inside a form is dropped by
 * the browser, so its controls submit the wrong thing) and horizontal overflow
 * at the mobile checkpoint, naming the element that causes it.
 *
 *   pnpm run preview:console            # ./preview
 *   PREVIEW_OUT=/tmp/x pnpm run preview:console
 *
 * Development only: it is not part of the test suite and asserts nothing. The
 * database comes from TEST_DATABASE_URL, the same throwaway fixture the E2E
 * suite uses, and is dropped on exit.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../packages/db/src/index.ts";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../tests/support/console-app.ts";

const OUT = process.env.PREVIEW_OUT ?? "preview";
const PAGES: Array<[string, string]> = [
  ["overview", "/"],
  ["providers", "/providers"],
  // The provider with a failing connection carries the longest health text.
  ["providers-failing", "/providers?selected=__OPENROUTER__"],
  ["models", "/models"],
  ["api-keys", "/api-keys"],
  ["limits", "/limits"],
  ["activity", "/activity"],
  ["usage", "/usage"],
  ["playground", "/playground"],
  ["dialog-new-key", "/api-keys?dialog=new"],
  ["drawer-limits", "/limits"],
  ["drawer-activity", "/activity"],
  ["dialog-add-provider", "/providers?dialog=new"],
  // Both credential dialogs in their edit shape, where new and edit are easy
  // to confuse: a token connection and a key connection.
  ["dialog-edit-token", "/providers?selected=__CLAUDE__&providerKeyDialog=__CLAUDE__&connection=__OAUTH__"],
  ["dialog-add-key", "/providers?selected=__OPENROUTER__&providerKeyDialog=__OPENROUTER__&connection=new"],
  ["dialog-edit-key", "/providers?selected=__OPENROUTER__&providerKeyDialog=__OPENROUTER__&connection=__ORMAIN__"],
  ["dialog-virtual-model", "/models?dialog=edit"],
];

let failingProviderId = "";
let subscriptionProviderId = "";
let oauthConnectionId = "";
let apiKeyConnectionId = "";

async function seed(fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>) {
  const id = () => randomUUID();
  const providers = {
    openrouter: id(),
    claudeCode: id(),
    ollama: id(),
  };
  await fixture.query(
    `insert into providers (id, provider_type, provider_key, provider_template_id, display_name, base_url, enabled) values
       ($1, 'api_key', 'openrouter', 'openrouter', 'openrouter', 'https://openrouter.ai/api/v1', true),
       ($2, 'subscription', 'claude_code', 'claude_code', 'claude-code', null, true),
       ($3, 'local', 'ollama', 'ollama', 'ollama (local)', 'http://localhost:11434/v1', true)`,
    [providers.openrouter, providers.claudeCode, providers.ollama],
  );

  failingProviderId = providers.openrouter;
  subscriptionProviderId = providers.claudeCode;

  const models: Record<string, string> = {};
  const modelRows = [
    [providers.openrouter, "claude-sonnet-4-5", 3, 15, 200_000],
    [providers.openrouter, "claude-opus-4-5", 15, 75, 200_000],
    [providers.openrouter, "deepseek-chat", 0.27, 1.1, 128_000],
    [providers.claudeCode, "claude-sonnet-4-5", null, null, 200_000],
    [providers.claudeCode, "claude-opus-4-5", null, null, 200_000],
    [providers.ollama, "llama3.1", null, null, 131_072],
  ] as const;
  for (const [providerId, modelId, input, output, ctx] of modelRows) {
    const modelUuid = id();
    models[`${providerId}:${modelId}`] = modelUuid;
    await fixture.query(
      `insert into provider_models
         (id, provider_id, model_id, display_name, context_window, availability,
          supports_streaming, supports_function_calling, capability_metadata,
          synced_input_usd_per_million_tokens, synced_output_usd_per_million_tokens,
          synced_price_source, synced_price_version, synced_price_synced_at, updated_at)
       values ($1, $2, $3, $3, $4, 'available', true, true, $7::jsonb, $5, $6,
               'models.dev', '2026-07-01', now() - interval '1 day', now() - interval '12 minutes')`,
      [
        modelUuid,
        providerId,
        modelId,
        ctx,
        input,
        output,
        JSON.stringify({ reasoning: modelId.includes("opus") }),
      ],
    );
  }

  // Two connections on openrouter, one failing; one oauth token on claude-code.
  const conns = { orMain: id(), orBackup: id(), oauth: id() };
  oauthConnectionId = conns.oauth;
  apiKeyConnectionId = conns.orMain;
  await fixture.query(
    `insert into provider_api_keys (id, provider_id, label, key_prefix, key_id, encrypted_key, priority, enabled)
     values ($1, $3, 'or-main', 'sk-or-a1b2…', 'k1', '{}'::jsonb, 10, true),
            ($2, $3, 'or-backup', 'sk-or-c3d4…', 'k2', '{}'::jsonb, 20, true)`,
    [conns.orMain, conns.orBackup, providers.openrouter],
  );
  await fixture.query(
    `insert into provider_oauth (id, provider_id, label, priority, enabled, completed_at, encrypted_token, flow_type)
     values ($1, $2, 'oauth-1', 10, true, now(), '{}'::jsonb, 'device_code')`,
    [conns.oauth, providers.claudeCode],
  );
  await fixture.query(
    `insert into provider_health_summary (id, provider_connection_id, provider_id, status, reason_code, reason_message, consecutive_failures, last_failure_at, next_probe_at)
     values (gen_random_uuid(), $1, $2, 'unhealthy', 'invalid_api_key', '401 from the provider', 6, now() - interval '4 minutes', now() + interval '5 minutes')`,
    [conns.orBackup, providers.openrouter],
  );
  await fixture.query(
    `insert into provider_quota_summary (id, provider_connection_id, provider_id, entries, observed_at)
     values (gen_random_uuid(), $1, $2, $3::jsonb, now() - interval '2 minutes')`,
    [
      conns.oauth,
      providers.claudeCode,
      JSON.stringify([{ window: "5h", utilization: 0.62, resetsAt: "16:00" }]),
    ],
  );
  await fixture.query(
    `insert into jobs (id, job_type, status, trigger, payload, completed_at, error_code, error_message)
     values (gen_random_uuid(), 'model_refresh', 'succeeded', 'scheduled', $1::jsonb, now() - interval '3 hours', null, null),
            (gen_random_uuid(), 'model_refresh', 'failed', 'scheduled', $1::jsonb, now() - interval '20 minutes', 'upstream_unauthorized', 'The provider rejected the model list request with 401.')`,
    [JSON.stringify({ providerId: providers.openrouter, source: "scheduled_refresh" })],
  );

  // Virtual models with ordered candidates.
  const vms = { fast: id(), max: id() };
  await fixture.query(
    `insert into virtual_models (id, name, description, enabled) values
       ($1, 'coding-fast', 'Fast coding loop', true),
       ($2, 'coding-max', 'Deep reasoning', true)`,
    [vms.fast, vms.max],
  );
  const policies = { fast: id(), max: id() };
  await fixture.query(
    `insert into route_policies (id, virtual_model_id, strategy, endpoint_protocol) values
       ($1, $3, 'load_balance', 'chat_completions'),
       ($2, $4, 'fixed', 'messages')`,
    [policies.fast, policies.max, vms.fast, vms.max],
  );
  // Candidates have to be ones the endpoint could actually route to: this seed
  // writes rows directly, so an impossible pairing here would show up as a
  // contradiction on screen and send the reader chasing a bug that is not one.
  // claude-code serves Messages only, so it belongs to the messages route.
  await fixture.query(
    `insert into route_policy_candidates (id, route_policy_id, provider_model_id, candidate_order) values
       (gen_random_uuid(), $1, $3, 1),
       (gen_random_uuid(), $1, $4, 2),
       (gen_random_uuid(), $1, $5, 3),
       (gen_random_uuid(), $2, $6, 1),
       (gen_random_uuid(), $2, $7, 2)`,
    [
      policies.fast,
      policies.max,
      models[`${providers.openrouter}:claude-sonnet-4-5`],
      models[`${providers.openrouter}:deepseek-chat`],
      models[`${providers.ollama}:llama3.1`],
      models[`${providers.claudeCode}:claude-opus-4-5`],
      models[`${providers.claudeCode}:claude-sonnet-4-5`],
    ],
  );

  // API keys, grants and limits.
  const keys = { cursor: id(), ci: id(), docs: id() };
  await fixture.query(
    `insert into api_keys (id, name, key_prefix, key_hash, enabled, limits_enabled, created_at) values
       ($1, 'cursor-agent', 'llmi_a1b2c3d4…', gen_random_uuid()::text, true, true, now() - interval '30 days'),
       ($2, 'ci-runner', 'llmi_c9d4e1f7…', gen_random_uuid()::text, true, true, now() - interval '20 days'),
       ($3, 'docs-bot', 'llmi_g6p3s9t4…', gen_random_uuid()::text, true, false, now() - interval '5 days')`,
    [keys.cursor, keys.ci, keys.docs],
  );
  await fixture.query(
    `insert into api_key_virtual_models (api_key_id, virtual_model_id) values
       ($1, $3), ($1, $4), ($2, $4), ($5, $3)`,
    [keys.cursor, keys.ci, vms.fast, vms.max, keys.docs],
  );
  await fixture.query("update api_keys set default_virtual_model_id = $2 where id = $1", [
    keys.cursor,
    vms.fast,
  ]);
  await fixture.query(
    `insert into api_key_limits (id, api_key_id, limit_type, period, limit_value, unit, enabled, enforcement_policy) values
       (gen_random_uuid(), $1, 'budget', 'month', 50, 'usd', true, 'block'),
       (gen_random_uuid(), $1, 'rpm', 'minute', 300, 'requests', true, 'block'),
       (gen_random_uuid(), $1, 'tpm', 'minute', 100000, 'tokens', true, 'block'),
       (gen_random_uuid(), $1, 'concurrency', 'request', 8, 'requests', true, 'block'),
       (gen_random_uuid(), $2, 'budget', 'month', 100, 'usd', true, 'warn_only')`,
    [keys.cursor, keys.ci],
  );

  await fixture.query(
    `insert into budget_periods (id, api_key_id, period_type, period_start, period_end, cost_used_usd, tokens_used) values
       (gen_random_uuid(), $1, 'month', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 13.87, 30900000),
       (gen_random_uuid(), $2, 'month', date_trunc('month', now()), date_trunc('month', now()) + interval '1 month', 7.92, 13100000)`,
    [keys.cursor, keys.ci],
  );

  // Traffic: successes, one fallback, one failure, one cancel. Each row states
  // the protocol its own route serves and a provider that route can reach —
  // a request recorded against a model its virtual model cannot route to would
  // read as a bug in the page rather than in this fixture.
  for (let index = 0; index < 48; index += 1) {
    const activityId = id();
    const failed = index % 11 === 3;
    const canceled = index % 17 === 5;
    const keyId = [keys.cursor, keys.ci, keys.docs][index % 3];
    const onMax = index % 3 === 1;
    const vmId = onMax ? vms.max : vms.fast;
    const protocol = onMax ? "messages" : "chat_completions";
    const providerId = onMax ? providers.claudeCode : providers.openrouter;
    const modelKey = onMax
      ? index % 2 === 0
        ? `${providers.claudeCode}:claude-opus-4-5`
        : `${providers.claudeCode}:claude-sonnet-4-5`
      : index % 4 === 2
        ? `${providers.openrouter}:deepseek-chat`
        : `${providers.openrouter}:claude-sonnet-4-5`;
    await fixture.query(
      `insert into request_activity
         (id, request_id, api_key_id, virtual_model_id, route_policy_id, provider_id, provider_model_id,
          api_key_prefix, protocol, model, stream, status, error_code, http_status, latency_ms,
          started_at, completed_at, api_key_name_snapshot, virtual_model_name_snapshot,
          provider_display_name_snapshot, provider_model_name_snapshot, route_policy_strategy_snapshot,
          request_metadata)
       values ($1, $2, $3, $4, $5, $6, $7, 'llmi_a1b2c3d4…', $8, $9, true, $10, $11, $12, $13,
               now() - ($14 || ' minutes')::interval, now() - ($14 || ' minutes')::interval,
               $15, $16, $17, $18, $20, $19::jsonb)`,
      [
        activityId,
        `req_${activityId.slice(0, 6)}`,
        keyId,
        vmId,
        vmId === vms.fast ? policies.fast : policies.max,
        providerId,
        models[modelKey],
        protocol,
        vmId === vms.fast ? "coding-fast" : "coding-max",
        failed ? "failed" : canceled ? "canceled" : "succeeded",
        failed ? "rate_limit" : null,
        failed ? 429 : canceled ? null : 200,
        failed ? 400 : 900 + index * 37,
        String(index * 19),
        keyId === keys.cursor ? "cursor-agent" : keyId === keys.ci ? "ci-runner" : "docs-bot",
        vmId === vms.fast ? "coding-fast" : "coding-max",
        providerId === providers.claudeCode ? "claude-code" : "openrouter",
        modelKey.split(":")[1],
        JSON.stringify({
          model: vmId === vms.fast ? "coding-fast" : "coding-max",
          stream: true,
          max_tokens: 4096,
        }),
        onMax ? "fixed" : "load_balance",
      ],
    );
    if (!canceled) {
      await fixture.query(
        `insert into request_usage (id, request_activity_id, api_key_id, virtual_model_id, provider_model_id,
           input_tokens, output_tokens, total_tokens, cached_input_tokens, reasoning_tokens, token_source)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, 'provider')`,
        [
          activityId,
          keyId,
          vmId,
          models[modelKey],
          1200 + index * 90,
          260 + index * 12,
          1460 + index * 102,
          index % 3 === 0 ? 400 + index * 20 : 0,
          index % 5 === 0 ? 120 : 0,
        ],
      );
      await fixture.query(
        `insert into request_costs (id, request_activity_id, api_key_id, total_cost_usd, cost_source)
         values (gen_random_uuid(), $1, $2, $3, $4)`,
        [
          activityId,
          keyId,
          providerId === providers.claudeCode ? 0 : 0.0041 + index * 0.0002,
          providerId === providers.claudeCode ? "unavailable" : "estimated",
        ],
      );
    }
    // One request walks its route: the first candidate's key is rejected, the
    // second is skipped as unhealthy, the third serves it. Index 6 is a
    // coding-fast request that succeeded on its third candidate, so the
    // timeline in the drawer matches the row that owns it.
    if (index === 6) {
      await fixture.query(
        `insert into fallback_events (id, request_activity_id, attempt_order, provider_model_id, status,
           error_code, status_code, failed_before_first_byte, retryable, created_at)
         select gen_random_uuid(), $1, t.attempt, t.model_id::uuid, t.status, t.error_code,
                t.status_code, t.before_first_byte, t.retryable,
                request_activity.started_at + (t.offset_ms || ' milliseconds')::interval
         from request_activity,
              (values (1, $2::text, 'failed', 'invalid_api_key', 401, true, true, 114),
                      (2, $3::text, 'skipped', 'provider_unhealthy', null, true, false, 118),
                      (3, $4::text, 'succeeded', null, 200, false, null, 891))
                as t(attempt, model_id, status, error_code, status_code, before_first_byte, retryable, offset_ms)
         where request_activity.id = $1`,
        [
          activityId,
          models[`${providers.openrouter}:claude-sonnet-4-5`],
          models[`${providers.ollama}:llama3.1`],
          models[modelKey],
        ],
      );
    }
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_preview_${randomUUID().replaceAll("-", "_")}`,
  });
  await runMigrations({ databaseUrl: fixture.databaseUrl });
  await seed(fixture);

  const consoleApp = startConsoleProcess({
    databaseUrl: fixture.databaseUrl,
    port: await getFreePort(),
  });
  const baseUrl = `http://127.0.0.1:${consoleApp.port}`;
  const browser = await chromium.launch();

  try {
    // A cold Next cache compiles the whole dashboard tree on the first request;
    // this is a tool, not a test, so it waits rather than failing the run.
    await waitForConsole(baseUrl, consoleApp, 180_000);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage();
    // A browser complaint is only actionable if you know which page produced it.
    let visiting = "sign-in";
    page.on("console", (message) => {
      if (message.type() === "error" || message.type() === "warning") {
        const where = visiting;
        void Promise.all(message.args().map((arg) => arg.jsonValue().catch(() => "?"))).then(
          (args) => console.log(`[browser ${where}] ${args.map(String).join(" | ").slice(0, 4000)}`),
        );
      }
    });
    page.on("pageerror", (error) => console.log(`[pageerror ${visiting}] ${error.message}`));
    // The first-run screen is only reachable once, so it is captured before
    // signing in through the same helper the E2E suite uses — the harness must
    // not carry its own idea of how the console is entered.
    // Screenshotting before hydration finishes reports the console as broken
    // when it is not: Playwright hides the caret by injecting a style, and
    // React then sees an attribute its own render did not produce.
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.screenshot({ path: `${OUT}/auth-first-run-light.png`, fullPage: true });
    await signInFromFirstRun(page, baseUrl);

    for (const theme of ["light", "dark"] as const) {
      await page.goto(`${baseUrl}/providers`);
      await page.waitForLoadState("domcontentloaded");
      await page.evaluate((value) => {
        // The same key the console's own bootstrap script reads.
        localStorage.setItem("llmingress-console-theme", value);
      }, theme);
      for (const [name, rawPath] of PAGES) {
        const path = rawPath
          .replace(/__OPENROUTER__/g, failingProviderId)
          .replace(/__CLAUDE__/g, subscriptionProviderId)
          .replace(/__OAUTH__/g, oauthConnectionId)
          .replace(/__ORMAIN__/g, apiKeyConnectionId);
        visiting = `${name} ${theme}`;
        await page.goto(`${baseUrl}${path}`);
        if (name === "drawer-limits") {
          await page.getByText("cursor-agent").first().click();
          await page.waitForLoadState("networkidle");
        }
        if (name === "drawer-activity") {
          await page.getByText("↯", { exact: false }).first().click();
          await page.waitForLoadState("networkidle");
        }
        await page.waitForTimeout(300);
        await page.waitForLoadState("networkidle");
        await page.screenshot({ path: `${OUT}/${name}-${theme}.png`, fullPage: true });
        if (theme === "light") {
          const bad = await page.evaluate(() => {
            const report: string[] = [];
            for (const selector of ["a a", "p div", "p p", "form form", "button button", "label label", "p ul", "p ol"]) {
              const hits = document.querySelectorAll(selector);
              if (hits.length > 0) {
                report.push(`${selector} x${hits.length} :: ${(hits[0]?.outerHTML ?? "").slice(0, 160)}`);
              }
            }
            return report;
          });
          for (const entry of bad) {
            console.log(`[dom ${name}] ${entry}`);
          }
        }
      }
    }
    // Walk the two-step key creation so the one-time secret screen is captured.
    visiting = "key-created";
    await page.goto(`${baseUrl}/api-keys?dialog=new`);
    await page.waitForLoadState("networkidle");
    await page.getByRole("link", { name: "Grant coding-fast" }).click();
    await page.waitForLoadState("networkidle");
    await page.getByLabel("API key name").fill("preview-agent");
    await page.getByRole("button", { name: "Create key" }).click();
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: `${OUT}/key-created-light.png`, fullPage: true });

    // Horizontal overflow at the mobile checkpoint, with the element that
    // causes it — a page that scrolls sideways is a layout bug, not a choice.
    await page.setViewportSize({ width: 390, height: 844 });
    for (const [, path] of PAGES) {
      visiting = `overflow ${path}`;
      await page.goto(`${baseUrl}${path}`);
      await page.waitForLoadState("networkidle");
      const report = await page.evaluate(() => {
        const overflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        if (overflow <= 0) return null;
        const culprits: string[] = [];
        for (const el of Array.from(document.querySelectorAll("*"))) {
          const style = getComputedStyle(el);
          if (style.overflowX !== "visible") continue;
          if (el.scrollWidth > el.clientWidth + 1) {
            culprits.push(
              `${el.tagName}.${(el.className || "").toString().slice(0, 80)} scroll=${el.scrollWidth} client=${el.clientWidth}`,
            );
          }
        }
        return { overflow, culprits: culprits.slice(0, 8) };
      });
      if (report) {
        console.log(`[overflow ${path}] ${report.overflow}px`);
        for (const entry of report.culprits) console.log(`   ${entry}`);
      }
    }

    console.log(`screenshots written to ${OUT}`);
  } finally {
    await browser.close();
    await stopConsoleProcess(consoleApp);
    await fixture.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
