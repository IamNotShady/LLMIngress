import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const execFileAsync = promisify(execFile);

test("package cleanup keeps supported subpaths and rejects removed private subpaths", async () => {
  const script = `
    void (async () => {
      const kept = [
        "@llmingress/db/client",
        "@llmingress/db/config-versions",
        "@llmingress/db/provider-jobs",
        "@llmingress/provider/openai",
        "@llmingress/security/secret-encryption",
      ];
      const removed = [
        "@llmingress/db/activity",
        "@llmingress/db/jobs",
        "@llmingress/db/console-agent-integrations",
        "@llmingress/config/config-publisher",
        "@llmingress/billing",
        "@llmingress/provider",
        "@llmingress/security",
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
