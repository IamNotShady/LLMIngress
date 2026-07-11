import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
const css = () => readFileSync(join(appDir, "globals.css"), "utf8");
const sectionSource = (file: string) => readFileSync(join(appDir, "_modules", file), "utf8");
const providersSection = () =>
  readFileSync(join(appDir, "_modules/providers-client-section.tsx"), "utf8");
const routeDialog = () =>
  readFileSync(join(appDir, "_modules/virtual-model-route-dialog.tsx"), "utf8");

describe("console providers IA and form polish static contract", () => {
  test("providers page has one representation: the summary-card grid is gone", () => {
    const source = sectionSource("providers-section.tsx");
    expect(source).not.toContain("provider-card-grid");
    expect(source).not.toContain("provider-summary-card");
    expect(css()).not.toContain(".provider-card-grid");
    expect(css()).not.toContain(".provider-summary-card");
  });

  test("model library search and pagination execute on the server", () => {
    const clientSource = providersSection();
    const serverSource = sectionSource("providers-section.tsx");
    const querySource = readFileSync(
      join(rootDir, "packages/db/src/console-route-policies.ts"),
      "utf8",
    );
    expect(clientSource).toContain("model-library-search");
    expect(clientSource).toContain("providerModelPage.pageCount");
    expect(clientSource).not.toContain("MODEL_LIBRARY_PAGE_SIZE");
    expect(clientSource).not.toContain("selectedProviderModels.filter");
    expect(serverSource).toContain("listProviderModelPage");
    expect(querySource).toContain("limit 50");
  });

  test("agents KPI grid collapses to two columns on mobile", () => {
    expect(css()).toMatch(
      /@media \(max-width: 56rem\)[\s\S]*?\.agents-stat-grid\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
    );
  });

  test("settings display-only selects look disabled", () => {
    expect(css()).toMatch(/select:disabled,\s*textarea:disabled\s*\{[^}]*cursor:\s*not-allowed/s);
    expect(css()).toMatch(/select:disabled,\s*textarea:disabled\s*\{[^}]*opacity/s);
  });

  test("virtual model dialog submit says Create when creating, Save when editing", () => {
    expect(routeDialog()).toContain('{virtualModel ? "Save" : "Create"}');
  });
});
