import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Console core workflow", () => {
  it("presents the remaining core setup flow on an empty Overview", () => {
    const overview = read("apps/console/src/app/_modules/overview-section.tsx");
    expect(overview).toContain("Route your first request");
    expect(overview).toContain('href="/providers?providerDialog=new"');
    expect(overview).toContain('href="/models?virtualModelDialog=new"');
    expect(overview).toContain('href="/api-keys?apiKeyDialog=new"');
    expect(overview).toContain('href="/playground"');
  });

  it("does not imply Gateway readiness when only its target URL is known", () => {
    const sidebar = read("apps/console/src/app/_components/sidebar.tsx");
    expect(sidebar).toContain("Gateway target");
    expect(sidebar).not.toContain("sidebar-account-dot");
  });

  it("gives every blocked empty state a path into the core setup flow", () => {
    const api_keys = read("apps/console/src/app/_modules/api-keys-section.tsx");
    const limits = read("apps/console/src/app/_modules/limits-section.tsx");
    const virtualModels = read("apps/console/src/app/_modules/virtual-models-section.tsx");
    const routeDialog = read("apps/console/src/app/_modules/virtual-model-route-dialog.tsx");
    expect(api_keys).not.toContain("create one below");
    expect(api_keys).toContain("Create an API Key");
    expect(limits).toContain("Create an API Key and enable limits");
    expect(virtualModels).toContain("Add a Provider and refresh its models");
    expect(routeDialog).toContain("No Provider Models found");
    expect(routeDialog).toContain("Open Providers");
    expect(routeDialog).toContain("doesn't support the ");
    expect(routeDialog).toContain("disabled={selectedCandidates.length === 0}");
    const css = read("apps/console/src/app/globals.css");
    expect(css).toContain(".vm-model-picker-table th:nth-child(6)");
    expect(css).toContain(".vm-model-picker-table th:nth-child(7)");
  });

  it("removes visual artifacts that belonged only to deleted features", () => {
    const css = read("apps/console/src/app/globals.css");
    const icons = read("apps/console/src/app/_components/flat-icon.tsx");
    for (const className of ["runtime-item", "settings-panel", "settings-grid"]) {
      expect(css, className).not.toContain(className);
    }
    for (const icon of ['| "export"', '| "import"']) {
      expect(icons, icon).not.toContain(icon);
    }
  });
});
