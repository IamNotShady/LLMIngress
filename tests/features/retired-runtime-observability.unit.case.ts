import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("retired runtime surfaces", () => {
  it("removes metrics, traces, runtime persistence, and non-core Console pages", () => {
    for (const path of [
      "packages/gateway-runtime/src/gateway-metrics.ts",
      "packages/gateway-runtime/src/gateway-tracing.ts",
      "packages/gateway-runtime/src/gateway-runtime-status.ts",
      "packages/db/src/traces.ts",
      "packages/db/src/console-runtime.ts",
      "apps/console/src/app/_modules/runtime-section.tsx",
      "apps/console/src/app/_modules/settings-section.tsx",
      "apps/console/src/app/(dashboard)/runtime/page.tsx",
      "apps/console/src/app/(dashboard)/settings/page.tsx",
    ]) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }

    const gatewayMain = readFileSync(join(repoRoot, "apps/gateway/src/main.ts"), "utf8");
    expect(gatewayMain).not.toContain('app.get("/metrics"');

    const dbPackage = JSON.parse(
      readFileSync(join(repoRoot, "packages/db/package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(dbPackage.exports["./traces"]).toBeUndefined();
    expect(dbPackage.exports["./console-runtime"]).toBeUndefined();
  });

  it("keeps only core Console navigation", () => {
    const nav = readFileSync(join(repoRoot, "apps/console/src/app/_lib/nav.ts"), "utf8");
    expect(nav).not.toContain('href: "/runtime"');
    expect(nav).not.toContain('href: "/settings"');
    expect(nav).toContain('href: "/playground"');
  });
});
