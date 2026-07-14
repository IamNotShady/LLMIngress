import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("core delivery hardening", () => {
  it("uses one native ConsoleDialog contract for every retained modal", () => {
    const component = read("apps/console/src/app/_components/console-dialog.tsx");
    expect(component).toContain("<dialog");
    expect(component).toContain("showModal()");
    expect(component).toContain("event.preventDefault()");
    expect(component).toContain("router.push(closeHref)");
    expect(component).toContain("triggerId");

    const modules = readdirSync("apps/console/src/app/_modules")
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => read(`apps/console/src/app/_modules/${file}`))
      .join("\n");
    expect(modules).not.toContain('role="dialog"');
    expect(modules).not.toContain("console-dialog-scrim");
    expect(modules).toContain("<ConsoleDialog");
  });

  it("builds one non-root multi-role runtime image without repository source", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("docker-compose.yml");
    expect(dockerfile).toContain("AS runtime");
    expect(dockerfile.match(/^USER /gm)).toHaveLength(1);
    expect(dockerfile).toContain('ENTRYPOINT ["/app/docker-entrypoint.sh"]');
    for (const role of ["gateway", "worker", "migrate", "console"]) {
      expect(compose).toContain(`command: ${role}`);
    }
    expect(compose.match(/image: llmingress-app:local/g)).toHaveLength(4);
    expect(compose.match(/target: runtime/g)).toHaveLength(1);
    expect(dockerfile).not.toContain("COPY --from=build /app /app");
    expect(compose).toContain("/health/ready");
    expect(compose).not.toContain("exec tsx");
  });

  it("provides CommonJS require to bundled ESM runtime images", () => {
    const dockerfile = read("Dockerfile");
    expect(
      dockerfile.match(/--banner:js="import \{ createRequire \} from 'node:module'/g),
    ).toHaveLength(3);
  });

  it("uses node:util parseArgs in both migration CLIs", () => {
    for (const file of ["scripts/migrate.ts", "scripts/migration-status.ts"]) {
      const source = read(file);
      expect(source, file).toContain('from "node:util"');
      expect(source, file).toContain("parseArgs(");
      expect(source, file).not.toContain("readFlagValue");
    }
  });

  it("emits JSON coverage and enforces the accepted global thresholds", () => {
    const config = read("vitest.config.ts");
    expect(config).toContain('"json-summary"');
    expect(config).toContain("branches: 38");
    expect(config).toContain("functions: 50");
    expect(config).toContain("lines: 45");
    expect(config).toContain("statements: 45");
  });
});
