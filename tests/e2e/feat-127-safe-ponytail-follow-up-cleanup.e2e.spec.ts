import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("safe ponytail follow-up cleanup preserves supported runtime surfaces", async () => {
  const script = `
    void (async () => {
      const nav = await import("./apps/console/src/app/_lib/nav.ts");
      if (!Array.isArray(nav.consoleNavItems) || nav.consoleNavItems.length === 0) {
        throw new Error("consoleNavItems must remain exported");
      }
      if ("consoleNavGroups" in nav || "ConsoleNavGroup" in nav) {
        throw new Error("grouped console navigation export should be removed");
      }

      const providers = await import("@llmingress/db/providers");
      if ("removedProviderKeys" in providers || "isRemovedProviderKey" in providers) {
        throw new Error("removed-provider runtime blacklist should be removed");
      }

      await import("@llmingress/db/console-import-export");
    })().catch((error) => {
      console.error(error);
      process.exit(1);
    });
  `;

  await expect(
    execFileAsync("pnpm", ["exec", "tsx", "-e", script], {
      cwd: process.cwd(),
    }),
  ).resolves.toEqual(expect.objectContaining({ stdout: "" }));
});
