import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(root, relativePath), "utf8")) as T;
}

type PackageJson = {
  name: string;
  scripts?: Record<string, string>;
};

type FeatureList = {
  features: Array<Record<string, unknown>>;
};

const projects = [
  {
    name: "@llmingress/gateway",
    packagePath: "apps/gateway/package.json",
    entryPath: "apps/gateway/src/main.ts",
    requiredScripts: ["dev", "build", "start", "typecheck"],
  },
  {
    name: "@llmingress/console",
    packagePath: "apps/console/package.json",
    entryPath: "apps/console/src/app/page.tsx",
    requiredScripts: ["dev", "build", "start", "typecheck"],
  },
  {
    name: "@llmingress/worker",
    packagePath: "apps/worker/package.json",
    entryPath: "apps/worker/src/main.ts",
    requiredScripts: ["dev", "build", "start", "typecheck"],
  },
];

const sharedPackages = [
  {
    name: "@llmingress/domain",
    packagePath: "packages/domain/package.json",
    entryPath: "packages/domain/src/index.ts",
    requiredScripts: ["build", "typecheck"],
  },
  {
    name: "@llmingress/config",
    packagePath: "packages/config/package.json",
    entryPath: "packages/config/src/index.ts",
    requiredScripts: ["build", "typecheck"],
  },
  {
    name: "@llmingress/db",
    packagePath: "packages/db/package.json",
    entryPath: "packages/db/src/index.ts",
    requiredScripts: ["build", "typecheck"],
  },
];

describe("workspace scaffold", () => {
  it("declares the expected pnpm workspace packages", () => {
    const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");

    expect(workspace).toContain('"apps/*"');
    expect(workspace).toContain('"packages/*"');
  });

  it("fails when a requested test file is missing", () => {
    const vitestConfig = readFileSync(path.join(root, "vitest.config.ts"), "utf8");

    expect(vitestConfig).toContain("passWithNoTests: false");
  });

  it("uses description and status fields for feature tracking", () => {
    const featureList = readJson<FeatureList>("feature_list.json");

    expect(featureList.features.length).toBeGreaterThan(0);
    for (const feature of featureList.features) {
      expect(feature.description).toBeTypeOf("string");
      expect(feature.status).toBeTypeOf("string");
      expect(feature).not.toHaveProperty("behavior");
      expect(feature).not.toHaveProperty("state");
    }
  });

  it.each(projects)("$name has package metadata, scripts, and an entrypoint", (project) => {
    const packageJson = readJson<PackageJson>(project.packagePath);

    expect(packageJson.name).toBe(project.name);
    expect(statSync(path.join(root, project.entryPath)).isFile()).toBe(true);
    for (const scriptName of project.requiredScripts) {
      expect(packageJson.scripts?.[scriptName]).toBeTypeOf("string");
    }
  });

  it.each(sharedPackages)("$name has package metadata, scripts, and an entrypoint", (project) => {
    const packageJson = readJson<PackageJson>(project.packagePath);

    expect(packageJson.name).toBe(project.name);
    expect(statSync(path.join(root, project.entryPath)).isFile()).toBe(true);
    for (const scriptName of project.requiredScripts) {
      expect(packageJson.scripts?.[scriptName]).toBeTypeOf("string");
    }
  });

  it("provides an executable init script that starts all three projects", () => {
    const initPath = path.join(root, "init.sh");
    const initScript = readFileSync(initPath, "utf8");
    const packageJson = readJson<PackageJson>("package.json");
    const mode = statSync(initPath).mode;

    expect(mode & 0o111).not.toBe(0);
    expect(packageJson.scripts?.init).toBe("bash init.sh");
    expect(initScript).toContain("--filter @llmingress/gateway dev");
    expect(initScript).toContain("--filter @llmingress/console dev");
    expect(initScript).toContain("--filter @llmingress/worker dev");
  });
});
