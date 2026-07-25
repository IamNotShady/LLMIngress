import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { formatRelativeDateTime } from "../../apps/console/src/app/_ui/provider-relative-time";

const rootDir = process.cwd();
const appDir = join(rootDir, "apps/console/src/app");
const css = () => readFileSync(join(appDir, "globals.css"), "utf8");
const sectionSource = (file: string) => readFileSync(join(appDir, "_modules", file), "utf8");
const providersSection = () =>
  readFileSync(join(appDir, "_modules/providers-client-section.tsx"), "utf8");
const routeDialog = () =>
  readFileSync(join(appDir, "_modules/virtual-model-route-dialog.tsx"), "utf8");

describe("console providers IA and form polish static contract", () => {
  test("relative Provider timestamps use one server-provided reference time", () => {
    const renderedAt = Date.parse("2026-07-12T00:50:00.000Z");
    expect(formatRelativeDateTime("2026-07-12T00:00:30.000Z", renderedAt)).toBe("49 min ago");
    expect(formatRelativeDateTime("2026-07-12T00:00:30.000Z", renderedAt + 60_000)).toBe(
      "50 min ago",
    );
  });

  test("all retained Console mutation forms intercept API errors", () => {
    const files = [
      "apps/console/src/app/_components/auth-screens.tsx",
      "apps/console/src/app/_components/sidebar.tsx",
      "apps/console/src/app/_modules/api-key-create-dialog-client.tsx",
      "apps/console/src/app/_modules/api-keys-section.tsx",
      "apps/console/src/app/_modules/limits-section.tsx",
      "apps/console/src/app/_modules/models-section.tsx",
      "apps/console/src/app/_modules/provider-create-form.tsx",
      "apps/console/src/app/_modules/provider-key-create-dialog-client.tsx",
      "apps/console/src/app/_modules/providers-client-section.tsx",
      "apps/console/src/app/_modules/providers-section.tsx",
      "apps/console/src/app/_modules/virtual-model-route-dialog.tsx",
      "apps/console/src/app/_modules/virtual-models-section.tsx",
    ];

    for (const file of files) {
      const source = readFileSync(join(rootDir, file), "utf8");
      const nativeMutationForms = source
        .split("<form")
        .slice(1)
        .map((form) => form.split("</form>")[0] ?? "")
        .filter((form) => form.includes('action="/api/'))
        .filter((form) => !form.includes("onSubmit="));
      expect(nativeMutationForms, file).toEqual([]);
    }
  });

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

  test("api_keys KPI grid collapses to two columns on mobile", () => {
    expect(css()).toMatch(
      /@media \(max-width: 56rem\)[\s\S]*?\.api-keys-stat-grid\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/,
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
