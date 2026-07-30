import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("core Console performance", () => {
  it("offers the three fixed usage windows and no custom date range", () => {
    const windowPicker = read("apps/console/src/app/_ui/usage/window.tsx");
    expect(windowPicker).toContain('["24h", "7d", "30d"]');
    // The redesigned header has no date inputs, so nothing can request a range
    // the backend would have to reconcile against a window.
    for (const page of ["(dashboard)/usage/page.tsx", "(dashboard)/page.tsx"]) {
      const source = read(`apps/console/src/app/${page}`);
      expect(source, page).not.toContain('name="dateFrom"');
      expect(source, page).not.toContain('name="dateTo"');
    }
  });

  it("uses pooled clients for ordinary Console database modules", () => {
    const files = readdirSync("packages/db/src")
      .filter((file) => file.startsWith("console-") && file.endsWith(".ts"))
      .filter((file) => file !== "console-operation-error.ts");

    for (const file of files) {
      const source = read(`packages/db/src/${file}`);
      expect(source, file).not.toContain("new PostgresClient");
      expect(source, file).not.toMatch(/\bwithClient\(/);
    }
  });

  it("parallelizes independent page reads and removes the full analytics snapshot", () => {
    for (const page of [
      "(dashboard)/page.tsx",
      "(dashboard)/providers/page.tsx",
      "(dashboard)/models/page.tsx",
      "(dashboard)/api-keys/page.tsx",
      "(dashboard)/limits/page.tsx",
      "(dashboard)/activity/page.tsx",
      "(dashboard)/usage/page.tsx",
    ]) {
      expect(read(`apps/console/src/app/${page}`), page).toContain("Promise.all");
    }
    expect(existsSync("packages/db/src/console-analytics.ts")).toBe(false);
    expect(read("packages/db/package.json")).not.toContain('"./console-analytics"');
  });

  it("queries the Provider model library on the server instead of truncating client data", () => {
    const page = read("apps/console/src/app/(dashboard)/providers/page.tsx");
    const detail = read("apps/console/src/app/_ui/providers/detail.tsx");
    expect(page).toContain("listProviderModelPage");
    expect(page).toContain("modelPage");
    expect(page).toContain("modelQuery");
    expect(page).toContain("availability");
    // The rendered table takes the page the query returned; it never slices or
    // refilters, so the header count and the range always share a denominator.
    expect(detail).not.toContain(".slice(");
    expect(detail).not.toContain("modelPage.items.filter(");
  });
});
