import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBootstrapConfigFile } from "../../packages/config/src/index.ts";
import { readPostgresDatabaseUrl } from "../../packages/db/src/client.ts";
import { normalizeRoutePreviewInput } from "../../packages/db/src/console-route-preview.ts";

function writeTempConfig(content: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "arch-hardening-")), "bootstrap.json");
  writeFileSync(path, content, "utf8");
  return path;
}

describe("refactor-zod-boundaries", () => {
  it("uses zod at the preview and bootstrap boundaries", () => {
    expect(readFileSync("packages/db/src/console-route-preview.ts", "utf8")).toContain(
      'from "zod"',
    );
    expect(readFileSync("packages/config/src/index.ts", "utf8")).toContain('from "zod"');
    expect(
      readFileSync("apps/console/src/app/api/route-policies/preview/route.ts", "utf8"),
    ).toContain("const body: unknown");
  });

  it("keeps the legacy preview validation messages", () => {
    expect(() => normalizeRoutePreviewInput("nope")).toThrow(
      "Route preview request must be a JSON object.",
    );
    expect(() =>
      normalizeRoutePreviewInput({
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
        usesTools: false,
      }),
    ).toThrow("Route preview requires virtualModelId or virtualModelName.");
    expect(() =>
      normalizeRoutePreviewInput({
        virtualModelId: "",
      }),
    ).toThrow("virtualModelId must be a non-empty string.");
    expect(() =>
      normalizeRoutePreviewInput({
        estimatedInputTokens: Number.NaN,
        estimatedOutputTokens: 1,
        usesTools: false,
        virtualModelName: "vm",
      }),
    ).toThrow("estimatedInputTokens must be a non-negative finite number.");
    expect(() =>
      normalizeRoutePreviewInput({
        estimatedInputTokens: 1,
        estimatedOutputTokens: 1,
        taskType: "definitely-not-a-task",
        usesTools: false,
        virtualModelName: "vm",
      }),
    ).toThrow("taskType must be a valid route task type.");
  });

  it("keeps valid preview input normalization (trim + null tolerance)", () => {
    expect(
      normalizeRoutePreviewInput({
        estimatedInputTokens: 10,
        estimatedOutputTokens: 20,
        taskType: null,
        usesTools: true,
        virtualModelName: "  vm  ",
      }),
    ).toEqual({
      estimatedInputTokens: 10,
      estimatedOutputTokens: 20,
      usesTools: true,
      virtualModelName: "vm",
    });
  });

  it("rejects a bootstrap config file with wrongly typed fields", () => {
    const path = writeTempConfig('{ "masterKey": 123 }');
    expect(() => readBootstrapConfigFile(path)).toThrow(
      /LLMINGRESS_BOOTSTRAP_CONFIG could not be read/,
    );
  });

  it("lets the database URL reader ignore unrelated malformed bootstrap fields", () => {
    const databaseUrl = "postgresql://postgres:postgres@127.0.0.1:55432/postgres";
    const path = writeTempConfig(
      JSON.stringify({
        databaseUrl,
        gatewayPort: null,
        masterKey: 12345,
      }),
    );

    expect(readPostgresDatabaseUrl({ configFilePath: path, env: {} })).toBe(databaseUrl);
    expect(() => readBootstrapConfigFile(path)).toThrow(
      /LLMINGRESS_BOOTSTRAP_CONFIG could not be read/,
    );
  });

  it("accepts a valid bootstrap config file", () => {
    const path = writeTempConfig('{ "gatewayPort": 4100, "masterKey": "k" }');
    expect(readBootstrapConfigFile(path)).toMatchObject({ gatewayPort: 4100, masterKey: "k" });
  });
});
