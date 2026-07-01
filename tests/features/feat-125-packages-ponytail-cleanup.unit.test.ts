import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

const removedFiles = [
  "packages/db/src/activity.ts",
  "packages/db/src/agents.ts",
  "packages/db/src/health.ts",
  "packages/db/src/jobs.ts",
  "packages/db/src/maintenance.ts",
  "packages/db/src/notifications.ts",
  "packages/db/src/routes.ts",
  "packages/db/src/console-agent-integrations.ts",
  "packages/db/src/console-model-refresh-jobs.ts",
  "packages/db/src/console-provider-connectivity-jobs.ts",
  "packages/config/src/config-publisher.ts",
  "packages/billing/src/index.ts",
  "packages/provider/src/index.ts",
  "packages/security/src/index.ts",
];

const removedDbExports = [
  "./activity",
  "./agents",
  "./health",
  "./jobs",
  "./maintenance",
  "./notifications",
  "./routes",
  "./console-agent-integrations",
  "./console-model-refresh-jobs",
  "./console-provider-connectivity-jobs",
];

const removedDbSubpaths = [
  "@llmingress/db/activity",
  "@llmingress/db/agents",
  "@llmingress/db/health",
  "@llmingress/db/jobs",
  "@llmingress/db/maintenance",
  "@llmingress/db/notifications",
  "@llmingress/db/routes",
  "@llmingress/db/console-agent-integrations",
  "@llmingress/db/console-model-refresh-jobs",
  "@llmingress/db/console-provider-connectivity-jobs",
];

describe("feat-125 package API surface cleanup", () => {
  it("removes shim and barrel files that only widen package API surface", () => {
    const existing = removedFiles.filter((file) => existsSync(join(repoRoot, file)));

    expect(existing).toEqual([]);
  });

  it("removes obsolete private package exports", () => {
    const dbManifest = readJson<PackageManifest>("packages/db/package.json");
    const configManifest = readJson<PackageManifest>("packages/config/package.json");
    const billingManifest = readJson<PackageManifest>("packages/billing/package.json");
    const providerManifest = readJson<PackageManifest>("packages/provider/package.json");
    const securityManifest = readJson<PackageManifest>("packages/security/package.json");

    for (const subpath of removedDbExports) {
      expect(dbManifest.exports).not.toHaveProperty(subpath);
    }
    expect(configManifest.exports).not.toHaveProperty("./config-publisher");
    expect(configManifest.dependencies ?? {}).not.toHaveProperty("@llmingress/db");
    expect(Object.hasOwn(billingManifest.exports ?? {}, ".")).toBe(false);
    expect(Object.hasOwn(providerManifest.exports ?? {}, ".")).toBe(false);
    expect(Object.hasOwn(securityManifest.exports ?? {}, ".")).toBe(false);
  });

  it("updates production imports to the real owning modules", () => {
    const offenders = listSourceFiles("apps", "packages", "scripts")
      .filter((file) => !file.endsWith("package.json"))
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return removedDbSubpaths.some((subpath) => source.includes(subpath));
      });

    expect(offenders.map((file) => relative(repoRoot, file))).toEqual([]);
  });

  it("removes speculative exported APIs that have no callers", () => {
    const files = [
      "packages/db/src/console-auth.ts",
      "packages/db/src/console-price-overrides.ts",
      "packages/db/src/console-provider-keys.ts",
    ];
    const exportedDeadApis = [
      "export function getConsoleDatabaseUrl",
      "export async function getManualPriceOverride",
      "export async function updateProviderApiKeyMetadata",
    ];
    const offenders = files.flatMap((file) => {
      const source = readFileSync(join(repoRoot, file), "utf8");
      return exportedDeadApis.filter((api) => source.includes(api)).map((api) => `${file}:${api}`);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps provider job helpers exported only by provider-jobs", () => {
    const offenders = ["packages/db/src/providers.ts", "packages/db/src/index.ts"].filter((file) =>
      readFileSync(join(repoRoot, file), "utf8").includes("@llmingress/db/provider-jobs"),
    );

    expect(offenders).toEqual([]);
  });

  it("centralizes provider adapter HTTP helper code", () => {
    const helperPath = join(repoRoot, "packages/provider/src/adapters/adapter-http.ts");
    expect(existsSync(helperPath)).toBe(true);

    const adapterFiles = [
      "packages/provider/src/adapters/openai.ts",
      "packages/provider/src/adapters/anthropic.ts",
      "packages/provider/src/adapters/ollama.ts",
      "packages/provider/src/adapters/subscription.ts",
    ];
    const duplicateHelpers = adapterFiles.filter((file) => {
      const source = readFileSync(join(repoRoot, file), "utf8");
      return (
        /function readResponseBody\b/.test(source) ||
        /function readProviderRequestId\b/.test(source) ||
        /function isRecord\b/.test(source)
      );
    });

    expect(duplicateHelpers).toEqual([]);
  });

  it("uses a compact table for gateway error status mapping", () => {
    const source = readFileSync(join(repoRoot, "packages/db/src/gateway-error-mapping.ts"), "utf8");

    expect(source).toContain("gatewayErrorStatusByCode");
    expect(source).not.toContain('if (code === "missing_agent_api_key"');
  });

  it("removes the stale config-publisher package tree entry from architecture docs", () => {
    const architecture = readFileSync(join(repoRoot, "docs/ARCHITECTURE.md"), "utf8");

    expect(architecture).not.toContain("config-publisher.ts");
  });
});

type PackageManifest = {
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
};

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(repoRoot, path), "utf8")) as T;
}

function listSourceFiles(...roots: string[]): string[] {
  return roots.flatMap((root) => listFiles(join(repoRoot, root)));
}

function listFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  if (
    root.endsWith("/node_modules") ||
    root.endsWith("/dist") ||
    root.endsWith("/.next") ||
    root.includes("/node_modules/")
  ) {
    return [];
  }

  return readdirSync(root)
    .map((name) => join(root, name))
    .flatMap((entry) => {
      if (statSync(entry).isDirectory()) {
        return listFiles(entry);
      }
      return entry.endsWith(".ts") || entry.endsWith(".tsx") ? [entry] : [];
    });
}
