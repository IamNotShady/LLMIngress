import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveConsoleUsageDateRange } from "../../apps/console/src/app/_lib/usage-date-range";

const read = (path: string) => readFileSync(path, "utf8");

describe("core Console performance", () => {
  it("uses inclusive UTC calendar dates for default and custom Usage windows", () => {
    const now = new Date("2024-03-01T12:34:56.000Z");

    expect(resolveConsoleUsageDateRange({ now, window: "24h" })).toEqual({
      dateFromValue: "2024-03-01",
      dateToValue: "2024-03-01",
      endExclusive: new Date("2024-03-02T00:00:00.000Z"),
      start: new Date("2024-03-01T00:00:00.000Z"),
    });
    expect(resolveConsoleUsageDateRange({ now, window: "7d" }).dateFromValue).toBe("2024-02-24");
    expect(resolveConsoleUsageDateRange({ now, window: "30d" }).dateFromValue).toBe("2024-02-01");
    expect(
      resolveConsoleUsageDateRange({
        dateFrom: "2024-02-28",
        dateTo: "2024-02-29",
        now,
        window: "7d",
      }),
    ).toEqual({
      dateFromValue: "2024-02-28",
      dateToValue: "2024-02-29",
      endExclusive: new Date("2024-03-01T00:00:00.000Z"),
      start: new Date("2024-02-28T00:00:00.000Z"),
    });

    const newYear = resolveConsoleUsageDateRange({
      now: new Date("2025-01-01T01:00:00.000Z"),
      window: "7d",
    });
    expect(newYear.dateFromValue).toBe("2024-12-26");
    expect(newYear.dateToValue).toBe("2025-01-01");
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
    expect(read("apps/console/src/app/_modules/api-keys-section-data.ts")).toContain("Promise.all");
    expect(read("apps/console/src/app/_modules/limits-section.tsx")).toContain("Promise.all");
    expect(read("apps/console/src/app/_modules/providers-section.tsx")).toContain("Promise.all");
    expect(read("apps/console/src/app/_modules/overview-section.tsx")).toContain("Promise.all");
    expect(existsSync("packages/db/src/console-analytics.ts")).toBe(false);
    expect(read("packages/db/package.json")).not.toContain('"./console-analytics"');
  });

  it("queries the Provider model library on the server instead of truncating client data", () => {
    const server = read("apps/console/src/app/_modules/providers-section.tsx");
    const client = read("apps/console/src/app/_modules/providers-client-section.tsx");
    expect(server).toContain("listProviderModelPage");
    expect(server).toContain("modelPage");
    expect(server).toContain("modelQuery");
    expect(client).not.toContain(".slice(0, MODEL_LIBRARY_PAGE_SIZE)");
    expect(client).not.toContain("filter((model)");
  });
});
