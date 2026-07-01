import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTestPostgresFixture,
  loadSqlMigrations,
  runMigrations,
} from "../../packages/db/src/index";
import { shippedSqlMigrations } from "../../packages/db/src/migration-status";

const repoRoot = process.cwd();
const testFile = "tests/features/feat-127-safe-ponytail-follow-up-cleanup.unit.test.ts";
const removedProviderKeys = ["fireworks", "groq", "mistral"] as const;

describe("feat-127 safe ponytail follow-up cleanup", () => {
  it("removes unused Console screenshot tooling", () => {
    expect(existsSync(join(repoRoot, "scripts/console-screenshots.mts"))).toBe(false);

    const references = listSourceFiles("apps", "packages", "scripts", "tests")
      .filter((file) => relative(repoRoot, file) !== testFile)
      .filter((file) => readFileSync(file, "utf8").includes("console-screenshots"))
      .map((file) => relative(repoRoot, file));

    expect(references).toEqual([]);
  });

  it("keeps Console navigation flat with consoleNavItems as the only exported nav list", () => {
    const source = readFileSync(join(repoRoot, "apps/console/src/app/_lib/nav.ts"), "utf8");

    expect(source).toContain("export const consoleNavItems");
    expect(source).not.toContain("ConsoleNavGroup");
    expect(source).not.toContain("consoleNavGroups");
  });

  it("keeps Agent connection detail formatting private to the route", () => {
    const route = readFileSync(join(repoRoot, "apps/console/src/app/api/agents/route.ts"), "utf8");

    expect(
      existsSync(join(repoRoot, "apps/console/src/app/api/agents/connection-details.ts")),
    ).toBe(false);
    expect(route).not.toContain("./connection-details");
    expect(route).toContain("function buildAgentConnectionDetails");
    expect(route).toContain('"<Virtual Model Name>"');
  });

  it("requires the current providerModelIds import shape", () => {
    const source = readFileSync(join(repoRoot, "packages/db/src/console-import-export.ts"), "utf8");

    expect(source).toContain("providerModelIds: normalizeUuidArray");
    expect(source).not.toContain("primaryProviderModelIds");
    expect(source).not.toContain("fallbackProviderModelIds");
  });

  it("removes the runtime removed-provider blacklist", () => {
    const providers = readFileSync(join(repoRoot, "packages/db/src/providers.ts"), "utf8");
    const offenders = listSourceFiles("packages/db/src")
      .filter((file) => relative(repoRoot, file) !== testFile)
      .filter((file) => readFileSync(file, "utf8").includes("isRemovedProviderKey"))
      .map((file) => relative(repoRoot, file));

    expect(providers).not.toContain("removedProviderKeys");
    expect(providers).not.toContain("isRemovedProviderKey");
    expect(offenders).toEqual([]);
  });

  it("ships migration 0049 and keeps the Console migration manifest aligned", () => {
    const migration = loadSqlMigrations().find(
      (candidate) => candidate.id === "0049" && candidate.name === "remove_legacy_provider_keys",
    );

    expect(migration, "missing 0049_remove_legacy_provider_keys migration").toBeDefined();
    const sql = (migration?.sql ?? "").toLowerCase();
    expect(sql).toContain("deleted_at");
    expect(sql).toContain("enabled = false");
    for (const key of removedProviderKeys) {
      expect(sql).toContain(`'${key}'`);
    }
    expect(shippedSqlMigrations.find((entry) => entry.id === "0049")).toEqual({
      checksum: migration?.checksum,
      id: "0049",
      name: "remove_legacy_provider_keys",
    });
  });

  it("soft-deletes legacy provider rows without breaking provider model foreign keys", async () => {
    const fixture = await createTestPostgresFixture({
      databaseNamePrefix: `llmingress_legacy_provider_${randomUUID().replaceAll("-", "_")}`,
    });
    const previousMigrations = copyMigrationsBefore("0049");

    try {
      await runMigrations({
        databaseUrl: fixture.databaseUrl,
        migrationsDirectory: previousMigrations,
      });

      const providerId = randomUUID();
      const providerModelId = randomUUID();
      await fixture.query(
        `
          insert into providers (id, provider_type, provider_key, display_name, base_url, enabled)
          values ($1, 'api_key', 'groq', 'Legacy Groq', 'https://api.groq.com/openai/v1', true)
        `,
        [providerId],
      );
      await fixture.query(
        `
          insert into provider_models (
            id,
            provider_id,
            model_id,
            display_name,
            context_window,
            supports_streaming,
            supports_tools,
            availability
          )
          values ($1, $2, 'llama-3.1', 'Llama 3.1', 128000, true, true, 'available')
        `,
        [providerModelId, providerId],
      );

      await runMigrations({ databaseUrl: fixture.databaseUrl });

      const provider = await fixture.query<{
        deleted_at: Date | null;
        enabled: boolean;
      }>("select enabled, deleted_at from providers where id = $1", [providerId]);
      const model = await fixture.query<{
        availability: string;
        deleted_at: Date | null;
      }>("select availability, deleted_at from provider_models where id = $1", [providerModelId]);

      expect(provider.rows[0]).toMatchObject({ enabled: false });
      expect(provider.rows[0]?.deleted_at).toBeInstanceOf(Date);
      expect(model.rows[0]).toMatchObject({ availability: "deprecated" });
      expect(model.rows[0]?.deleted_at).toBeInstanceOf(Date);
    } finally {
      rmSync(previousMigrations, { force: true, recursive: true });
      await fixture.dispose();
    }
  });
});

function copyMigrationsBefore(stopId: string): string {
  const sourceDir = join(repoRoot, "packages/db/migrations");
  const targetDir = mkdtempSync(join(tmpdir(), "llmingress-migrations-"));
  for (const name of readdirSync(sourceDir)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    if (name.startsWith(`${stopId}_`)) {
      break;
    }
    copyFileSync(join(sourceDir, name), join(targetDir, name));
  }
  return targetDir;
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
    root.includes("/node_modules/") ||
    root.includes("/dist/") ||
    root.includes("/.next/")
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
