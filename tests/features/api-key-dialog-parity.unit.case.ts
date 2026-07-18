import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
const css = () => readFileSync(join(appDir, "globals.css"), "utf8");
const source = (file: string) => readFileSync(join(appDir, file), "utf8");

describe("api key dialog parity static contract", () => {
  test("both dialogs render the shared detail panels component", () => {
    const panels = source("_modules/api-key-detail-panels.tsx");
    expect(panels).toContain("export function ApiKeyDetailPanels");
    expect(panels).toContain('className="api-key-view-columns"');
    expect(panels).toContain("<h3>Budget / Limit</h3>");
    expect(panels).toContain("<h3>Endpoints</h3>");
    expect(panels).toContain("<h3>Integration guide</h3>");
    expect(panels).toContain("SecretRevealField");

    for (const file of [
      "_modules/api-keys-section.tsx",
      "_modules/api-key-create-dialog-client.tsx",
    ]) {
      expect(source(file), file).toContain("ApiKeyDetailPanels");
    }
  });

  test("the created dialog inherits the view dialog shell class", () => {
    const created = source("_modules/api-key-create-dialog-client.tsx");
    expect(created).toContain(
      'className="console-dialog api-key-view-dialog api-key-created-dialog"',
    );
    // The bespoke created-only guide wrapper is gone.
    expect(created).not.toContain("api-key-created-guide");
    expect(css()).not.toContain(".api-key-created-guide");
  });

  test("the two dialogs differ only in how the api key is presented", () => {
    const created = source("_modules/api-key-create-dialog-client.tsx");
    const view = source("_modules/api-keys-section.tsx");

    expect(created).toContain('secretLabel="API key"');
    expect(created).toContain("secretHideable={true}");
    expect(view).toContain('secretLabel="API key prefix"');
    expect(view).toContain("secretHideable={false}");
    expect(view).toContain("secretValue={apiKey.keyPrefix}");
  });

  test("the secret field always copies the real value and hides only when hideable", () => {
    const field = source("_components/secret-reveal-field.tsx");
    expect(field.startsWith('"use client"')).toBe(true);
    expect(field).toContain("navigator.clipboard.writeText(value)");
    expect(field).toContain('"•".repeat(24)');
    // The eye toggle renders only when the caller opts in.
    expect(field).toContain("hideable ? (");
    expect(field).toContain('FlatIcon name={revealed ? "hide" : "view"}');
    expect(source("_components/flat-icon.tsx")).toContain('| "hide"');
  });

  test("the view dialog width is declared exactly once", () => {
    const stylesheet = css();
    const declarations = stylesheet.match(/^\.api-key-view-dialog\s*\{/gm) ?? [];
    expect(declarations).toHaveLength(1);
    expect(stylesheet).toMatch(/\.api-key-view-dialog\s*\{[^}]*width:\s*min\(72rem/s);
    expect(stylesheet).not.toMatch(/\.api-key-view-dialog\s*\{[^}]*width:\s*min\(42rem/s);
  });

  test("the create result carries limits so the created dialog can render them", () => {
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
