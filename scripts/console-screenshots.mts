// Reusable console screenshot harness (used for before/after redesign comparison).
// Run via:  tsx scripts/run-with-env.ts tsx scripts/console-screenshots.mts
// Env knobs:
//   SHOT_DIR     output directory (default /tmp/console-shots)
//   SHOT_LABEL   filename prefix (default "shot")
//   SHOT_ROUTES  comma list of routes (default "/")
//   SHOT_THEMES  comma list of "light"|"dark" (default "light")
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { chromium } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../packages/db/src/index";

const OUT_DIR = process.env.SHOT_DIR ?? "/tmp/console-shots";
const LABEL = process.env.SHOT_LABEL ?? "shot";
const ROUTES = (process.env.SHOT_ROUTES ?? "/").split(",").map((r) => r.trim());
const THEMES = (process.env.SHOT_THEMES ?? "light")
  .split(",")
  .map((t) => t.trim()) as Array<"light" | "dark">;
const PASSWORD = "correct horse battery staple";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate TCP port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function startConsoleProcess(databaseUrl: string, port: number) {
  return spawn(
    "pnpm",
    ["--filter", "@llmingress/console", "exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: process.cwd(),
      env: { ...process.env, CONSOLE_PORT: String(port), DATABASE_URL: databaseUrl, MASTER_KEY: "test-master-key" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

async function waitForConsole(baseUrl: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(baseUrl);
      if (res.status === 200) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Console did not become ready in time.");
}

function slug(route: string): string {
  const s = route.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  return s || "overview";
}

// Seeds a couple of activity rows with long playground-style request IDs so the
// /activity page can be verified for long-token overflow handling.
async function seedActivity(fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>) {
  const agentId = randomUUID();
  const keyId = randomUUID();
  await fixture.query(
    "insert into agents (id, name, agent_type, enabled) values ($1, 'Shot Agent', 'coding', true)",
    [agentId],
  );
  await fixture.query(
    `insert into agent_api_keys (id, agent_id, key_prefix, key_hash, enabled)
     values ($1, $2, 'shotkey0', 'sha256:v1:shot-hash', true)`,
    [keyId, agentId],
  );
  const rows = [
    ["playground_1781526149148_ad606c6ae7a278chat_completions", "succeeded", 200],
    ["playground_1781525570383_fce679c5abdc6chat_completions", "failed", 502],
    ["gw_303f4e20-bc79-4099-86a0-a81960955aa6chat_completions", "succeeded", 200],
  ] as const;
  for (const [requestId, status, http] of rows) {
    await fixture.query(
      `insert into request_activity
         (id, request_id, agent_api_key_id, agent_api_key_prefix, protocol, model, status, http_status, started_at, completed_at)
       values ($1, $2, $3, 'shotkey0', 'chat_completions', 'claude-sonnet-4-6', $4, $5, now(), now())`,
      [randomUUID(), requestId, keyId, status, http],
    );
  }
}

// Seeds a fuller catalog (multiple providers, virtual models, agents, route
// policies) so the redesigned list pages can be checked for rows + pagination.
async function seedCatalog(fixture: Awaited<ReturnType<typeof createTestPostgresFixture>>) {
  const providerIds: string[] = [];
  for (let i = 1; i <= 11; i += 1) {
    const id = randomUUID();
    providerIds.push(id);
    await fixture.query(
      `insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
       values ($1, 'api_key', $2, $3, 'https://api.example.com/v1', $4)`,
      [id, `provider-${i}`, `Provider ${i}`, i % 4 !== 0],
    );
  }
  // a couple of discovered models on the first provider
  for (const [modelId, name] of [
    ["gpt-4.1-mini", "GPT-4.1 Mini"],
    ["gpt-4.1", "GPT-4.1"],
  ] as const) {
    await fixture.query(
      `insert into provider_models (id, provider_id, model_id, display_name, availability)
       values ($1, $2, $3, $4, 'available')`,
      [randomUUID(), providerIds[0], modelId, name],
    );
  }

  const vmIds: string[] = [];
  for (let i = 1; i <= 11; i += 1) {
    const id = randomUUID();
    vmIds.push(id);
    await fixture.query(
      "insert into virtual_models (id, name, display_name, enabled) values ($1, $2, $3, $4)",
      [id, `vm-${i}`, `Virtual Model ${i}`, true],
    );
  }

  for (let i = 1; i <= 4; i += 1) {
    const agentId = randomUUID();
    await fixture.query(
      "insert into agents (id, name, agent_type, enabled) values ($1, $2, 'coding', true)",
      [agentId, `Agent ${i}`],
    );
    await fixture.query(
      `insert into agent_api_keys (id, agent_id, key_prefix, key_hash, enabled)
       values ($1, $2, $3, $4, true)`,
      [randomUUID(), agentId, `key${i}0000`, `sha256:v1:shot-hash-${i}`],
    );
  }

  for (let i = 0; i < 3; i += 1) {
    await fixture.query(
      "insert into route_policies (id, virtual_model_id, strategy) values ($1, $2, 'balanced')",
      [randomUUID(), vmIds[i]],
    );
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `console_shots_${randomUUID().replaceAll("-", "_")}`,
  });
  await runMigrations({ databaseUrl: fixture.databaseUrl });

  if (process.env.SHOT_SEED_CATALOG === "1") {
    await seedCatalog(fixture);
  }
  if (process.env.SHOT_SEED_ACTIVITY === "1") {
    await seedActivity(fixture);
  }

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startConsoleProcess(fixture.databaseUrl, port);
  child.stderr.on("data", (c) => process.stderr.write(String(c)));

  const browser = await chromium.launch();
  try {
    await waitForConsole(baseUrl);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    // First-run: create admin, then sign in.
    await page.goto(baseUrl);
    await page.getByLabel("Admin password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create admin" }).click();
    await page.getByRole("button", { name: "Sign in" }).waitFor();
    await page.getByLabel("Admin password").fill(PASSWORD);
    await page.getByRole("button", { name: "Sign in" }).click();
    // Stable post-login signal present in both old and new layouts.
    await page.getByRole("button", { name: "Sign out" }).waitFor({ timeout: 30_000 });
    // Next dev may redirect 127.0.0.1 -> localhost; cookies are host-bound, so
    // navigate relative to wherever we actually landed after login.
    const origin = new URL(page.url()).origin;

    for (const theme of THEMES) {
      await page.emulateMedia({ colorScheme: theme });
      for (const route of ROUTES) {
        await page.goto(`${origin}${route}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(400);
        if (process.env.SHOT_EXPAND_FIRST === "1") {
          // open the first collapsed row to capture the expanded detail/forms
          const firstRow = page.locator("details.row > summary").first();
          if (await firstRow.count()) {
            await firstRow.click();
            await page.waitForTimeout(250);
          }
        }
        const out = `${OUT_DIR}/${LABEL}-${theme}-${slug(route)}.png`;
        await page.screenshot({ path: out, fullPage: true });
        console.log(`captured ${out}`);
      }
    }
    await context.close();
  } finally {
    await browser.close();
    child.kill("SIGTERM");
    await fixture.dispose();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
