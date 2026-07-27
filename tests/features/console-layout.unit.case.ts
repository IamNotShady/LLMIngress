import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

function uiSources(): Array<readonly [string, string]> {
  return readdirSync(join(appDir, "_ui"), { recursive: true })
    .map(String)
    .filter((file) => /\.tsx$/.test(file))
    .map((file) => [`_ui/${file}`, read(`_ui/${file}`)] as const);
}

function pageSources(): Array<readonly [string, string]> {
  return [
    "(dashboard)/page.tsx",
    "(dashboard)/providers/page.tsx",
    "(dashboard)/models/page.tsx",
    "(dashboard)/api-keys/page.tsx",
    "(dashboard)/limits/page.tsx",
    "(dashboard)/activity/page.tsx",
    "(dashboard)/usage/page.tsx",
    "(dashboard)/playground/page.tsx",
  ].map((file) => [file, read(file)] as const);
}

describe("console layout contract", () => {
  test("every table declares fixed pixel column tracks", () => {
    // Auto-sized tracks are what let one long cell push a table past the
    // container; each table states its widths and shares them with its header.
    const columnDeclarations = [...uiSources(), ...pageSources()]
      .flatMap(([, source]) => source.match(/const [A-Z_]*COLUMNS = "[^"]+"/g) ?? [])
      .map((line) => line.split('"')[1] ?? "");

    expect(columnDeclarations.length).toBeGreaterThan(5);
    for (const declaration of columnDeclarations) {
      expect(declaration, declaration).toMatch(/px/);
      expect(declaration, declaration).not.toMatch(/auto/);
    }
  });

  test("a table row and its header share one column declaration", () => {
    for (const [file, source] of [...uiSources(), ...pageSources()]) {
      const heads = source.match(/columns=\{([A-Z_]+)\}[^>]*head/g) ?? [];
      for (const head of heads) {
        const name = head.match(/columns=\{([A-Z_]+)\}/)?.[1];
        expect(name, file).toBeTruthy();
        // The same constant is used by at least one body row.
        expect(source.match(new RegExp(`columns=\\{${name}\\}`, "g"))?.length ?? 0).toBeGreaterThan(
          1,
        );
      }
    }
  });

  test("long-text cells clip instead of wrapping", () => {
    // The 1440px target leaves no room for a second line; a wrapped cell breaks
    // the row rhythm of every row beside it.
    const clipUsers = [...uiSources(), ...pageSources()].filter(([, source]) =>
      source.includes("cell-clip"),
    );
    expect(clipUsers.length).toBeGreaterThan(5);

    const css = read("globals.css");
    expect(css).toMatch(/@utility cell-clip \{[\s\S]*?white-space: nowrap;/);
    expect(css).toMatch(/@utility cell-clip \{[\s\S]*?text-overflow: ellipsis;/);
  });

  test("every paginated list uses the one Pagination component", () => {
    const paginated = [...uiSources(), ...pageSources()].filter(([, source]) =>
      source.includes("<Pagination"),
    );
    expect(paginated.length).toBeGreaterThan(1);
    for (const [file, source] of paginated) {
      expect(source, file).toContain("formatRange(");
    }
    // Nothing renders its own prev/next pair.
    for (const [file, source] of [...uiSources(), ...pageSources()]) {
      if (file.endsWith("table.tsx")) {
        continue;
      }
      expect(source, file).not.toMatch(/←\s*Prev/);
    }
  });

  test("activity pages twenty rows and counts with the same denominator", () => {
    const activity = read("(dashboard)/activity/page.tsx");
    expect(activity).toContain("const PAGE_SIZE = 20");
    expect(activity).toContain("countConsoleActivities({ filters })");
    // The header count and the range are both derived from that one total.
    expect(activity).toContain("{formatCount(total)} matching");
    expect(activity).toContain("total }");
  });

  test("the content container is declared once, at the shell", () => {
    const layout = read("_ui/layout.tsx");
    expect(layout).toContain("max-w-[1560px]");
    for (const [file, source] of pageSources()) {
      expect(source, file).toContain("<PageShell");
      expect(source, file).not.toContain("max-w-[1560px]");
    }
  });

  test("filters distinguish no matches from nothing configured", () => {
    const models = read("(dashboard)/models/page.tsx");
    expect(models).toContain("No virtual model uses this strategy.");
    expect(models).toContain("No virtual models yet");

    const apiKeys = read("(dashboard)/api-keys/page.tsx");
    expect(apiKeys).toContain("No API key matches that name.");
    expect(apiKeys).toContain("No API keys yet");
  });

  test("the playground key hint names the console's own key format", () => {
    const playground = read("_ui/playground/playground.tsx");
    expect(playground).toContain("llmi_");
    expect(playground).toContain("never stored");
  });

  test("an authorization url is actionable, not just printed", () => {
    const dialogs = read("_ui/providers/dialogs.tsx");
    expect(dialogs).toMatch(/href=\{authorizeUrl\}/);
    expect(dialogs).toContain("Open in browser");
    expect(dialogs).toContain("Copy url");
  });

  test("inline mutation errors shrink and wrap inside compact action rows", () => {
    const mutationForm = read("_ui/mutation-form.tsx");
    expect(mutationForm).toContain('className={`min-w-0 ${className ?? ""}`}');
    expect(mutationForm).toContain("max-w-full");
    expect(mutationForm).toContain("break-words");

    const providerDetail = read("_ui/providers/detail.tsx");
    expect(providerDetail).toContain("flex-wrap");
    expect(providerDetail).toContain(
      "grid-cols-[minmax(0,1fr)_auto] items-start gap-2",
    );
    expect(providerDetail).toContain('className="col-start-2 row-start-1"');
    const providersPage = read("(dashboard)/providers/page.tsx");
    expect(providersPage).toContain('data-testid="providers-master-detail"');
    expect(providersPage).toContain(
      "grid-cols-[minmax(0,344px)_minmax(0,1fr)]",
    );
    expect(
      providersPage.match(
        /data-testid="providers-master-detail"[\s\S]*?className="([^"]+)"/,
      )?.[1],
    ).not.toContain("overflow-x-auto");
  });
});
