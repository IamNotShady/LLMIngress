import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
const source = (file: string) => readFileSync(join(appDir, file), "utf8");

describe("api key presentation contract", () => {
  test("the plaintext secret appears only on the one-time page", () => {
    const createdPage = source("api/api-keys/_created-page.ts");
    const detail = source("_ui/api-keys/detail.tsx");
    const dialogs = source("_ui/api-keys/dialogs.tsx");

    expect(createdPage).toContain("SECRET · SHOWN ONCE");
    // Everywhere else only the stored prefix exists, and that is all the console
    // renders — the plaintext is not kept anywhere to be shown again.
    expect(detail).toContain("apiKey.keyPrefix");
    expect(detail).not.toContain("plaintext");
    expect(dialogs).not.toContain("plaintext");
    expect(dialogs).toContain(
      "the llmi_ secret cannot be shown or changed — delete the key and issue a new one to rotate it",
    );
  });

  test("the one-time page never introduces a script into interpolated markup", () => {
    const createdPage = source("api/api-keys/_created-page.ts");
    // The page is assembled by string interpolation around user-controlled
    // names; a script tag there turns an escaping slip into code execution. It
    // needs one — the copy buttons — and that is only safe while its body is a
    // constant, so every script tag here must be a bare call into the shared
    // module and nothing else.
    for (const tag of createdPage.match(/<script[\s\S]*?<\/script>/g) ?? []) {
      expect(tag).toMatch(/^<script>\$\{[A-Za-z]+\(\)\}<\/script>$/);
    }
    expect(createdPage).toContain("function escapeHtml");
  });

  test("the created page and the detail view state the same configuration facts", () => {
    const createdPage = source("api/api-keys/_created-page.ts");
    const detail = source("_ui/api-keys/detail.tsx");

    for (const fact of ["gateway", "default model", "limits"]) {
      expect(createdPage, fact).toContain(fact);
    }
    expect(detail).toContain("Virtual Model access");
    expect(detail).toContain("Limits");
  });

  test("the create result carries limits so the created page can render them", () => {
    const db = readFileSync(join(rootDir, "packages/db/src/console-api-keys.ts"), "utf8");
    expect(db).toContain("limits: ConsoleApiKeyLimit[]");
    expect(db).toContain("readApiKeyLimitsWithClient");

    const limits = readFileSync(join(rootDir, "packages/db/src/console-api-key-limits.ts"), "utf8");
    expect(limits).toContain("export async function readApiKeyLimitsWithClient");

    const createdPage = source("api/api-keys/_created-page.ts");
    expect(createdPage).toContain("limits: input.limits");
    expect(createdPage).toContain("virtualModels: input.virtualModels");
  });
});
