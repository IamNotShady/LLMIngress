import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const rootDir = process.cwd();
const source = (file: string) => readFileSync(join(rootDir, file), "utf8");

describe("provider list collapse static contract", () => {
  test("provider selection has no default-expanded fallback", () => {
    for (const file of [
      "apps/console/src/app/_modules/providers-section.tsx",
      "apps/console/src/app/_modules/providers-client-section.tsx",
    ]) {
      const src = source(file);
      expect(src, file).not.toContain('providerKey === "openai"');
      expect(src, file).not.toContain("providers[0]");
    }
  });

  test("the selected provider row link collapses the row", () => {
    const src = source("apps/console/src/app/_modules/providers-client-section.tsx");
    expect(src).toContain("selected: isSelected ? undefined : provider.id");
  });

  test("provider model page query treats providerId as optional", () => {
    const src = source("packages/db/src/console-route-policies.ts");
    expect(src).toContain("$1::uuid is null or provider_models.provider_id = $1::uuid");
  });
});
