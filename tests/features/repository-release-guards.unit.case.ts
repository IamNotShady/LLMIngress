import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const milestoneIds = [
  "core-platform-security",
  "provider-model-management",
  "virtual-model-routing",
  "gateway-protocol-execution",
  "agent-access-and-limits",
  "usage-and-activity",
  "worker-model-operations",
  "console-core",
  "release-guards",
];

const retiredPaths = [
  "apps/console/src/app/(dashboard)/routing/page.tsx",
  "apps/console/src/app/(dashboard)/runtime/page.tsx",
  "apps/console/src/app/(dashboard)/settings/page.tsx",
  "apps/console/src/app/api/notifications/route.ts",
  "apps/console/src/app/api/route-policies/preview/route.ts",
  "packages/gateway-runtime/src/gateway-embeddings.ts",
  "packages/db/src/console-notification-channels.ts",
  "packages/worker-runtime/src/worker-alerts.ts",
  "packages/worker-runtime/src/worker-backup.ts",
  "packages/worker-runtime/src/worker-export.ts",
  "packages/worker-runtime/src/worker-notification-dispatch.ts",
  "packages/worker-runtime/src/worker-periodic-scheduler.ts",
  "scripts/backup.ts",
  "scripts/docker/install.sh.template",
  "scripts/docker/init-state.ts",
  "scripts/render-release-assets.ts",
  "docs/DOCKER_DEPLOYMENT.md",
  ".github/workflows/release.yml",
  "tests/features/docker-lifecycle.unit.test.ts",
  "tests/features/docker-lifecycle.unit.case.ts",
  "tests/e2e/docker-lifecycle.e2e.spec.ts",
  "tests/e2e/docker-lifecycle.e2e.case.ts",
];

const retiredProductionTerms = [
  "notification_channels",
  "notification_events",
  "webhook_deliveries",
  "gateway_runtime_status",
  "runtime_errors",
  "quality_first",
  "request_logging_enabled",
  "billing_reconciliation",
];

describe("core release guards", () => {
  it("pins local and CI PostgreSQL to 18.4 Alpine", () => {
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");
    const ci = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");

    expect(compose).toContain("image: postgres:18.4-alpine");
    expect(compose).toMatch(/^\s+- postgres-data:\/var\/lib\/postgresql$/m);
    expect(compose).not.toContain("- postgres-data:/var/lib/postgresql/data");
    expect(ci).toContain("image: postgres:18.4-alpine");
    expect(`${compose}\n${ci}`).not.toMatch(/image:\s*postgres:16(?:\b|-)/);
  });

  it("tracks exactly nine passing core milestones", () => {
    const tracker = JSON.parse(readFileSync(join(repoRoot, "feature_list.json"), "utf8")) as {
      features: Array<{ id: string; status: string; verification: string }>;
    };
    expect(tracker.features.map(({ id }) => id)).toEqual(milestoneIds);
    for (const feature of tracker.features) {
      expect(feature.status).toBe("passing");
      expect(feature.verification).toContain("tests/features/");
      expect(feature.verification).toContain("tests/e2e/");
    }
  });

  it("maps every current unit and E2E suite to exactly one release domain", () => {
    const tracker = JSON.parse(readFileSync(join(repoRoot, "feature_list.json"), "utf8")) as {
      features: Array<{ verification: string }>;
    };
    const unitReferences = tracker.features.flatMap(({ verification }) =>
      verification.match(/tests\/features\/[\w-]+\.unit\.test\.ts/g),
    );
    const e2eReferences = tracker.features.flatMap(({ verification }) =>
      verification.match(/tests\/e2e\/[\w-]+\.e2e\.spec\.ts/g),
    );
    const unitSuites = listFiles(join(repoRoot, "tests/features"))
      .map((path) => relative(repoRoot, path))
      .filter((path) => path.endsWith(".unit.test.ts"))
      .sort();
    const e2eSuites = listFiles(join(repoRoot, "tests/e2e"))
      .map((path) => relative(repoRoot, path))
      .filter((path) => path.endsWith(".e2e.spec.ts"))
      .sort();

    expect([...unitReferences].sort()).toEqual(unitSuites);
    expect([...e2eReferences].sort()).toEqual(e2eSuites);
    expect(new Set(unitReferences).size).toBe(unitReferences.length);
    expect(new Set(e2eReferences).size).toBe(e2eReferences.length);
    for (const { verification } of tracker.features) {
      expect(verification).toMatch(
        /^pnpm exec vitest run (?:tests\/features\/[\w-]+\.unit\.test\.ts ?)+ && pnpm test:e2e (?:tests\/e2e\/[\w-]+\.e2e\.spec\.ts ?)+ --workers=1$/,
      );
    }

    const caseFiles = listFiles(join(repoRoot, "tests"))
      .map((path) => relative(repoRoot, path))
      .filter((path) => path.endsWith(".unit.case.ts") || path.endsWith(".e2e.case.ts"))
      .sort();
    const caseReferences = [...unitSuites, ...e2eSuites].flatMap((suite) => {
      const source = readFileSync(join(repoRoot, suite), "utf8");
      return [...source.matchAll(/^import "([^"]+\.(?:unit|e2e)\.case)";$/gm)].map(
        ([, importPath]) =>
          relative(repoRoot, resolveImport(join(repoRoot, suite), `${importPath}.ts`)),
      );
    });
    expect([...caseReferences].sort()).toEqual(caseFiles);
    expect(new Set(caseReferences).size).toBe(caseReferences.length);
  });

  it("keeps development-history test entrypoints out of the release suites", () => {
    const historicalName =
      /(?:-removal|-simplification|post-slimming|refactor-|core-baseline-compression|worker-job-churn|worker-noncore)/;
    const suites = listFiles(join(repoRoot, "tests"))
      .map((path) => relative(repoRoot, path))
      .filter((path) => path.endsWith(".unit.test.ts") || path.endsWith(".e2e.spec.ts"));
    expect(suites.filter((path) => historicalName.test(path))).toEqual([]);
  });

  it("keeps retired routes and modules deleted", () => {
    expect(retiredPaths.filter((path) => existsSync(join(repoRoot, path)))).toEqual([]);
  });

  it("keeps the embeddings protocol retired while retaining embedding model metadata", () => {
    const gatewayMain = readFileSync(join(repoRoot, "apps/gateway/src/main.ts"), "utf8");
    const providerAdapter = readFileSync(
      join(repoRoot, "packages/provider/src/adapters/openai.ts"),
      "utf8",
    );
    const providerTemplates = readFileSync(
      join(repoRoot, "packages/db/src/console-provider-templates.ts"),
      "utf8",
    );
    const domain = readFileSync(join(repoRoot, "packages/domain/src/index.ts"), "utf8");
    const baseline = readFileSync(
      join(repoRoot, "packages/db/migrations/0001_core_baseline.sql"),
      "utf8",
    );
    const product = readFileSync(join(repoRoot, "docs/PRODUCT.md"), "utf8");
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");

    expect(gatewayMain).not.toContain("/v1/embeddings");
    expect(providerAdapter).not.toMatch(/Embeddings|embeddings/);
    expect(providerTemplates).not.toMatch(/embeddingsEndpoint|path: "embeddings"/);
    expect(domain.match(/routeEndpointProtocols = \[([\s\S]*?)\]/)?.[1]).not.toContain(
      "embeddings",
    );
    expect(domain.match(/modelOutputModalities = \[([^\]]+)\]/)?.[1]).toContain("embedding");
    expect(baseline).not.toContain("'embeddings'::text");
    expect(baseline).toContain("'embedding'::text");
    expect(`${product}\n${readme}`).not.toContain("/v1/embeddings");
  });

  it("keeps Compose as the supported Docker path without one-command install.sh", () => {
    const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
    const product = readFileSync(join(repoRoot, "docs/PRODUCT.md"), "utf8");
    const architecture = readFileSync(join(repoRoot, "docs/ARCHITECTURE.md"), "utf8");
    const dockerfile = readFileSync(join(repoRoot, "Dockerfile"), "utf8");
    const entrypoint = readFileSync(join(repoRoot, "scripts/docker/docker-entrypoint.sh"), "utf8");
    const compose = readFileSync(join(repoRoot, "docker-compose.yml"), "utf8");

    expect(readme).toContain("docker compose up --build");
    expect(readme).toContain("./scripts/deploy.sh");
    expect(`${readme}\n${product}`).not.toContain("/latest/download/install.sh");
    expect(`${readme}\n${product}`).not.toContain("install.sh");
    expect(product).toContain("one-command remote installer");
    expect(architecture).not.toContain("Installer-managed instances");
    expect(architecture).not.toContain("stop-the-world transactions");
    expect(dockerfile).not.toContain("init-state.ts");
    expect(dockerfile).not.toContain("install/state.mjs");
    expect(entrypoint).not.toContain("install/state.mjs");
    expect(compose).toContain("command: all");
    expect(compose).toContain("GATEWAY_URL");
    expect(entrypoint).toContain("all)");
  });

  it("keeps retired tables, configuration, and behavior out of production", () => {
    const sources = listFiles(join(repoRoot, "apps"))
      .concat(listFiles(join(repoRoot, "packages")))
      .concat(listFiles(join(repoRoot, "scripts")))
      .concat([join(repoRoot, ".env.example"), join(repoRoot, "docker-compose.yml")])
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    for (const retired of retiredProductionTerms) {
      expect(sources, retired).not.toContain(retired);
    }
    for (const config of [
      "GATEWAY_METRICS_TOKEN",
      "OTEL_",
      "WORKER_WEBHOOK_",
      "BACKUP_ENCRYPTION_KEY",
    ]) {
      expect(sources, config).not.toContain(config);
    }
  });

  it("keeps one core migration and three persistent Worker handlers", () => {
    expect(
      readdirSync(join(repoRoot, "packages/db/migrations")).filter((name) => name.endsWith(".sql")),
    ).toEqual(["0001_core_baseline.sql"]);

    const workerMain = readFileSync(join(repoRoot, "apps/worker/src/main.ts"), "utf8");
    const handlers = [...workerMain.matchAll(/^\s{6}([a-z_]+): create\w+JobHandler/gm)]
      .map(([, jobType]) => jobType)
      .sort();
    expect(handlers).toEqual(["model_refresh", "price_sync", "provider_connection_probe"]);
  });

  it("keeps app shells thin and stale artifacts absent", () => {
    expect(
      listFiles(join(repoRoot, "apps/worker/src")).map((file) => relative(repoRoot, file)),
    ).toEqual(["apps/worker/src/main.ts"]);
    for (const path of [
      "docs/PLAN.md",
      "session-handoff.md",
      "scripts/console-screenshots.mts",
      "scripts/console-e2e-coverage.ts",
    ]) {
      expect(existsSync(join(repoRoot, path)), path).toBe(false);
    }
  });
});

function listFiles(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  if (
    root.endsWith("/.llmingress") ||
    root.endsWith("/.next") ||
    root.endsWith("/dist") ||
    root.endsWith("/node_modules")
  ) {
    return [];
  }
  return readdirSync(root)
    .map((name) => join(root, name))
    .flatMap((entry) => {
      if (
        entry.endsWith("/.llmingress") ||
        entry.endsWith("/node_modules") ||
        entry.endsWith("/.next") ||
        entry.endsWith("/dist") ||
        entry.includes("/node_modules/") ||
        entry.includes("/.next/") ||
        entry.includes("/dist/")
      ) {
        return [];
      }
      if (statSync(entry).isDirectory()) {
        return listFiles(entry);
      }
      return /\.(?:ts|tsx|sql|json|md|mjs)$/.test(entry) ? [entry] : [];
    });
}

function resolveImport(importer: string, importPath: string): string {
  return join(dirname(importer), importPath);
}
