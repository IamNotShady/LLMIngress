import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";

const execFileAsync = promisify(execFile);

test("native Console dialog traps focus, closes with Escape, and restores its trigger", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_dialog_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
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
        await page.goto(`${baseUrl}/api-keys`, { waitUntil: "networkidle" });
        const trigger = page.locator("#api-key-create-dialog-trigger");
        await trigger.click();

        const dialog = page.locator("dialog[open]");
        await expect(dialog).toBeVisible();
        await expect(page.locator("#api-key-name")).toBeFocused();
        await page.keyboard.press("Tab");
        expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
          true,
        );

        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        await expect(page).toHaveURL(/\/api-keys$/);
        await expect(trigger).toBeFocused();

        await trigger.click();
        await expect(page.locator("dialog[open]")).toBeVisible();
        await page.getByRole("button", { name: "Close", exact: true }).click();
        await expect(page.locator("dialog[open]")).toHaveCount(0);
        await expect(trigger).toBeFocused();
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

test("Playground omits blank optional numeric parameters from Gateway requests", async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_playground_optional_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    const consoleApp = startConsoleProcess({
      databaseUrl: fixture.databaseUrl,
      env: { GATEWAY_URL: "http://gateway.test" },
      port: await getFreePort(),
    });
    try {
      const baseUrl = `http://localhost:${consoleApp.port}`;
      const context = await browser.newContext();
      const page = await context.newPage();
      let requestBody: Record<string, unknown> | null = null;
      try {
        await page.route("http://gateway.test/**", async (route) => {
          const request = route.request();
          const headers = {
            "access-control-allow-headers": "authorization,content-type,x-request-id",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-origin": baseUrl,
            "content-type": "application/json",
          };
          if (request.method() === "OPTIONS") {
            await route.fulfill({ headers, status: 204 });
            return;
          }
          if (new URL(request.url()).pathname === "/v1/models") {
            await route.fulfill({
              body: JSON.stringify({ data: [{ id: "virtual-model" }] }),
              headers,
              status: 200,
            });
            return;
          }
          requestBody = request.postDataJSON() as Record<string, unknown>;
          await route.fulfill({
            body: JSON.stringify({ content: [{ text: "ok", type: "text" }] }),
            headers,
            status: 200,
          });
        });

        await waitForConsole(baseUrl, consoleApp);
        await signInFromFirstRun(page, baseUrl);
        await page.goto(`${baseUrl}/playground`, { waitUntil: "networkidle" });
        // The model list comes from the gateway, asked with the pasted key —
        // the console's own records would not say what that key may reach.
        await page.getByLabel("API key", { exact: true }).fill("llmi_test");
        await expect(
          page.getByLabel("Virtual model", { exact: true }).locator("option[value='virtual-model']"),
        ).toHaveCount(1);

        await page.getByRole("button", { name: "messages", exact: true }).click();
        await page.getByLabel(/TEMPERATURE/).fill("");
        await page.getByLabel(/MAX TOKENS/).fill("");
        await page.getByRole("button", { name: "Send request" }).click();

        // A blank optional parameter is left out of the request rather than
        // sent as 0, which would mean something else entirely.
        await expect.poll(() => requestBody).not.toBeNull();
        expect(requestBody).not.toHaveProperty("temperature");
        expect(requestBody).not.toHaveProperty("max_tokens");
        expect(requestBody).toHaveProperty("model", "virtual-model");
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

test("migration CLIs reject unknown arguments before database access", async () => {
  for (const script of ["scripts/migrate.ts", "scripts/migration-status.ts"]) {
    await expect(
      execFileAsync("pnpm", ["tsx", script, "--unknown"], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: "postgresql://unused.invalid/db" },
      }),
      script,
    ).rejects.toMatchObject({ stderr: expect.stringMatching(/unknown/i) });
  }
});

test("the multi-role runtime image is non-root and omits development sources", async () => {
  test.setTimeout(600_000);
  const image = "llmingress-app:delivery-e2e";
  try {
    await execFileAsync("docker", ["build", "--target", "runtime", "--tag", image, "."], {
      cwd: process.cwd(),
      maxBuffer: 20 * 1024 * 1024,
    });
    const inspection = await execFileAsync(
      "docker",
      ["image", "inspect", "--format", "{{.Config.User}}", image],
      { cwd: process.cwd() },
    );
    expect(inspection.stdout.trim()).toBe("llmingress");
    const entrypoint = await execFileAsync(
      "docker",
      ["image", "inspect", "--format", "{{json .Config.Entrypoint}}", image],
      { cwd: process.cwd() },
    );
    expect(JSON.parse(entrypoint.stdout)).toEqual(["/app/docker-entrypoint.sh"]);
    const cmd = await execFileAsync(
      "docker",
      ["image", "inspect", "--format", "{{json .Config.Cmd}}", image],
      { cwd: process.cwd() },
    );
    expect(JSON.parse(cmd.stdout)).toEqual(["all"]);
    const runtime = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        image,
        "-c",
        [
          'test "$(id -u)" = 1001',
          "test -f /app/gateway/main.mjs",
          "test -f /app/worker/main.mjs",
          "test -f /app/migrate/main.mjs",
          "test -f /app/console/apps/console/server.js",
          "test ! -e /app/tests",
          "test ! -e /app/packages/src",
          "! command -v pnpm",
          "! command -v tsx",
        ].join(" && "),
      ],
      { cwd: process.cwd() },
    );
    expect(runtime.stderr).toBe("");
    const version = await execFileAsync("docker", ["run", "--rm", image, "version"], {
      cwd: process.cwd(),
    });
    expect(version.stdout.trim()).toBe("dev");
  } finally {
    await execFileAsync("docker", ["image", "rm", "-f", image]).catch(() => undefined);
  }
});
