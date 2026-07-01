import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function readWorkspaceFile(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    if (statSync(fullPath).isDirectory()) {
      files.push(...listFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

function expectCssSelectorAbsent(css: string, selector: string): void {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  expect(css, `${selector} should be removed`).not.toMatch(
    new RegExp(`${escaped}(?:[\\s,{:.#]|$)`),
  );
}

describe("feat-125 Console ponytail cleanup", () => {
  it("is tracked as the active Console cleanup feature", () => {
    const featureList = JSON.parse(readWorkspaceFile("feature_list.json")) as {
      features: Array<{
        dependencies: string[];
        id: string;
        name: string;
        status: string;
      }>;
    };

    expect(featureList.features).toContainEqual(
      expect.objectContaining({
        dependencies: ["feat-047", "feat-078", "feat-098", "feat-121", "feat-124"],
        id: "feat-125",
        name: "Console Ponytail Cleanup",
      }),
    );
  });

  it("removes the deleted Console-only files", () => {
    for (const path of [
      "apps/console/next.config.ts",
      "apps/console/src/app/_components/date-picker-input.tsx",
      "apps/console/src/app/_components/agent-virtual-model-multi-select.tsx",
      "apps/console/src/app/(dashboard)/pricing/page.tsx",
    ]) {
      expect(existsSync(resolve(root, path)), path).toBe(false);
    }
  });

  it("keeps Console navigation as a flat list", () => {
    const nav = readWorkspaceFile("apps/console/src/app/_lib/nav.ts");

    expect(nav).not.toContain("ConsoleNavGroup");
    expect(nav).not.toContain("consoleNavGroups");
    expect(nav).toContain("consoleNavItems");
  });

  it("lets Next choose the API route Node runtime", () => {
    const apiRouteFiles = listFiles(resolve(root, "apps/console/src/app/api")).filter((file) =>
      file.endsWith("/route.ts"),
    );
    const offenders = apiRouteFiles
      .filter((file) =>
        /export\s+const\s+runtime\s*=\s*["']nodejs["']/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(root, file));

    expect(offenders).toEqual([]);
  });

  it("retires hidden Console UI aliases without deleting route policy APIs", () => {
    const routingPage = readWorkspaceFile("apps/console/src/app/(dashboard)/routing/page.tsx");
    const priceOverrideRoute = readWorkspaceFile(
      "apps/console/src/app/api/prices/override/route.ts",
    );

    expect(routingPage).toContain('redirect("/models")');
    expect(routingPage).not.toContain("RoutePoliciesSection");
    expect(priceOverrideRoute).toContain('new URL("/providers", request.url)');
    expect(existsSync(resolve(root, "apps/console/src/app/api/route-policies/route.ts"))).toBe(
      true,
    );
  });

  it("drops CSS from removed widgets and audited dead selectors", () => {
    const css = readWorkspaceFile("apps/console/src/app/globals.css");

    for (const selector of [
      ".agent-vm-multi-select",
      ".agent-vm-multi-select-button",
      ".agent-vm-multi-select-panel",
      ".date-picker-input",
      ".date-picker-popover",
      ".date-picker-day",
      ".nav-group",
      ".nav-group-label",
      ".sidebar-version",
      ".section-heading",
      ".provider-template-selector",
      ".usage-window-form",
      ".playground-form",
      ".btn-ghost",
      ".badge-warn",
      ".badge-danger",
      ".activity-list-item-selected",
      ".panel-tabs",
      ".wizard",
    ]) {
      expectCssSelectorAbsent(css, selector);
    }
  });
});
