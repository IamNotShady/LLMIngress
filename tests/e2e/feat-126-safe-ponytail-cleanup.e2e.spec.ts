import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

const execFileAsync = promisify(execFile);

test("safe cleanup preserves runtime behavior", async ({ browser }) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.goto(`${baseUrl}/usage`);

    const startDate = page.getByLabel("Start date", { exact: true });
    const endDate = page.getByLabel("End date", { exact: true });
    await expect(startDate).toHaveAttribute("type", "date");
    await expect(endDate).toHaveAttribute("type", "date");

    await startDate.fill("2026-06-01");
    await endDate.fill("2026-06-30");
    await page.getByRole("button", { name: "Apply" }).click();

    await expect(page).toHaveURL(/dateFrom=2026-06-01/);
    await expect(page).toHaveURL(/dateTo=2026-06-30/);
  });

  const script = `
    void (async () => {
      const kept = [
        "@llmingress/db/client",
        "@llmingress/db/console-usage",
        "@llmingress/db/worker-backup"
      ];
      const removed = [
        "@llmingress/db/gateway-budgets",
        "@llmingress/db/gateway-fallback-chain",
        "@llmingress/db/gateway-gateway-runtime-status",
        "@llmingress/db/gateway-rate-limits",
        "./traces.ts"
      ];

      for (const specifier of kept) {
        await import(specifier);
      }
      for (const specifier of removed) {
        try {
          await import(specifier);
        } catch {
          continue;
        }
        throw new Error(\`Expected \${specifier} to be removed\`);
      }
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;

  await expect(
    execFileAsync("pnpm", ["--filter", "@llmingress/console", "exec", "tsx", "-e", script], {
      cwd: process.cwd(),
    }),
  ).resolves.toEqual(expect.objectContaining({ stdout: "" }));
});
