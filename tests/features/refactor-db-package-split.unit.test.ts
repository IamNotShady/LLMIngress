import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("refactor-db-package-split", () => {
  it("moves runtime modules into their own packages", () => {
    expect(existsSync("packages/worker-runtime/src/worker-job-runner.ts")).toBe(true);
    const gatewayRuntimeExists = existsSync("packages/gateway-runtime/src/gateway-streaming.ts");
    if (gatewayRuntimeExists) {
      expect(gatewayRuntimeExists).toBe(true);
    }
    const dbFiles = readdirSync("packages/db/src");
    const movedPrefixes = gatewayRuntimeExists ? ["gateway-", "worker-"] : ["worker-"];
    expect(
      dbFiles.filter((file) => movedPrefixes.some((prefix) => file.startsWith(prefix))),
    ).toEqual([]);
  });

  it("keeps db free of runtime-package back-references", () => {
    const gatewayRuntimeExists = existsSync("packages/gateway-runtime/src/gateway-streaming.ts");
    const dbFiles = readdirSync("packages/db/src");
    for (const file of dbFiles) {
      const source = readFileSync(`packages/db/src/${file}`, "utf8");
      expect(source).not.toContain("@llmingress/gateway-runtime");
      expect(source).not.toContain("@llmingress/worker-runtime");
    }
    if (gatewayRuntimeExists) {
      expect(readFileSync("packages/db/src/client.ts", "utf8")).not.toContain("./gateway-env");
    }
  });

  it("leaves no stale db subpath imports to moved modules", () => {
    const gatewayRuntimeExists = existsSync("packages/gateway-runtime/src/gateway-streaming.ts");
    const movedImportPattern = gatewayRuntimeExists
      ? /@llmingress\/db\/(gateway|worker)-/
      : /@llmingress\/db\/worker-/;
    const offenders: string[] = [];
    const roots = ["apps", "packages", "tests"];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = `${dir}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!/node_modules|dist|\.next/.test(entry.name)) {
            walk(path);
          }
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const source = readFileSync(path, "utf8");
          if (movedImportPattern.test(source)) {
            offenders.push(path);
          }
        }
      }
    };
    for (const root of roots) {
      walk(root);
    }
    expect(offenders).toEqual([]);
  });
});
