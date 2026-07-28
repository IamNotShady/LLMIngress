import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { consoleStatusLine } from "../../apps/console/src/app/_ui/status-line.ts";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console in-flight feedback", () => {
  test("the playground reports an in-flight send and cannot be double-submitted", () => {
    const src = read("_ui/playground/playground.tsx");
    expect(src).toMatch(/Sending…/);
    expect(src).toMatch(/disabled=\{sending/);
  });

  test("skeleton rows announce what is loading rather than spinning silently", () => {
    const src = read("_ui/layout.tsx");
    expect(src).toMatch(/export function LoadingRows/);
    expect(src).toMatch(/note/);
  });

  test("the one spinner is shared, named, and drops its motion when asked", () => {
    const spinner = read("_ui/spinner.tsx");
    // A spinner that does not say what it is waiting on tells nobody anything.
    expect(spinner).toMatch(/aria-label=\{label\}/);
    expect(spinner).toMatch(/motion-reduce:animate-none/);

    // Nothing else spins: one primitive, used where a wait is client-side.
    const uiFiles = readdirSync(join(appDir, "_ui"), { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".tsx") && !file.endsWith("spinner.tsx"));
    for (const file of uiFiles) {
      expect(read(`_ui/${file}`), file).not.toMatch(/animate-spin/);
    }
  });
});

describe("what a module shows while it is being fetched", () => {
  const dashboardDir = join(appDir, "(dashboard)");

  test("every module has a loading state, so navigation is never a blank frame", () => {
    // These pages are server-rendered and query on every request: without a
    // loading.tsx the router holds the old screen and then swaps, which reads
    // as a click that did nothing. One per segment that has a page.
    const segments = readdirSync(dashboardDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(dashboardDir, name, "page.tsx")));

    expect(segments.length).toBeGreaterThan(6);
    for (const segment of [...segments, ""]) {
      const loading = join(dashboardDir, segment, "loading.tsx");
      expect(existsSync(loading), `${segment || "overview"} has a loading state`).toBe(true);
      expect(readFileSync(loading, "utf8"), segment).toMatch(/export default function/);
    }
  });
});

describe("the line the sign-in screens carry", () => {
  test("says only what it has actually looked at", () => {
    // It renders before anything queries, so a word about the database would
    // print the same whether the database were up or down — and a version
    // would be a fingerprint handed to anyone who can reach the port.
    const line = consoleStatusLine({ encryptionReady: true, version: "1.2.3" });
    expect(line).toContain("LLMIngress 1.2.3");
    expect(line).toContain("encryption ok");
    // The product's own version is deliberately here; the database's is not,
    // and neither is a word about the database at all.
    expect(line.toLowerCase()).not.toMatch(/postgres|postgresql|\bpg\b/);
    expect(consoleStatusLine({ encryptionReady: false, version: "dev" })).toContain(
      "encryption unavailable",
    );
  });
});
