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
import { withProcessLock } from "../support/process-lock";

const execFileAsync = promisify(execFile);

test("native Console dialog traps focus, closes with Escape, and restores its trigger", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_dialog_${randomUUID().replaceAll("-", "_")}`,
  });
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    await withProcessLock("llmingress-console-next-dev", async () => {
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
          await page.goto(`${baseUrl}/agents`, { waitUntil: "networkidle" });
          const trigger = page.locator("#agent-create-dialog-trigger");
          await trigger.click();

          const dialog = page.locator("dialog[open]");
          await expect(dialog).toBeVisible();
          await expect(page.locator("#agent-name")).toBeFocused();
          await page.keyboard.press("Tab");
          expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(
            true,
          );

          await page.keyboard.press("Escape");
          await expect(dialog).toHaveCount(0);
          await expect(page).toHaveURL(/\/agents$/);
          await expect(trigger).toBeFocused();

          await trigger.click();
          await expect(page.locator("dialog[open]")).toBeVisible();
          await page.getByRole("link", { name: "Close", exact: true }).click();
          await expect(page.locator("dialog[open]")).toHaveCount(0);
          await expect(trigger).toBeFocused();
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
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

test("all runtime image targets are non-root and omit development sources", async () => {
  test.setTimeout(600_000);
  for (const target of ["gateway", "worker", "migrate", "console"]) {
    const image = `llmingress-${target}:delivery-e2e`;
    await execFileAsync("docker", ["build", "--target", target, "--tag", image, "."], {
      cwd: process.cwd(),
      maxBuffer: 20 * 1024 * 1024,
    });
    const inspection = await execFileAsync(
      "docker",
      ["image", "inspect", "--format", "{{.Config.User}}", image],
      { cwd: process.cwd() },
    );
    expect(inspection.stdout.trim()).toBe("llmingress");
    const runtime = await execFileAsync(
      "docker",
      [
        "run",
        "--rm",
        "--entrypoint",
        "sh",
        image,
        "-c",
        'test "$(id -u)" = 1001 && test ! -e /app/tests && test ! -e /app/packages/src && ! command -v pnpm && ! command -v tsx',
      ],
      { cwd: process.cwd() },
    );
    expect(runtime.stderr).toBe("");
  }
});
