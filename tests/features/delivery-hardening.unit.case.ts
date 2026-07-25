import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("core delivery hardening", () => {
  it("uses one overlay contract for every modal and drawer", () => {
    const overlay = read("apps/console/src/app/_ui/overlay.tsx");
    // Native modals: the browser owns focus, Tab and Escape, which is why the
    // ARIA role is not hand-written here.
    expect(overlay).toContain("<dialog");
    expect(overlay).toContain("showModal()");
    // Open state is a URL, so closing is a navigation and every dialog is
    // server-rendered from the selected object rather than client state.
    expect(overlay).toContain("closeHref");
    expect(overlay).toContain("export function Drawer");

    const uiFiles = readdirSync("apps/console/src/app/_ui", { recursive: true })
      .map(String)
      .filter((file) => file.endsWith(".tsx") && !file.endsWith("overlay.tsx"));
    for (const file of uiFiles) {
      const source = read(`apps/console/src/app/_ui/${file}`);
      // No module builds its own scrim, modal element or dialog role.
      expect(source, file).not.toContain('role="dialog"');
      expect(source, file).not.toContain("aria-modal");
      expect(source, file).not.toContain("showModal");
    }
  });

  it("builds one non-root multi-role runtime image without repository source", () => {
    const dockerfile = read("Dockerfile");
    const compose = read("docker-compose.yml");
    const entrypoint = read("scripts/docker/docker-entrypoint.sh");
    expect(dockerfile).toContain("AS runtime");
    expect(dockerfile.match(/^USER /gm)).toHaveLength(1);
    expect(dockerfile).toContain('ENTRYPOINT ["/app/docker-entrypoint.sh"]');
    expect(dockerfile).toContain('CMD ["all"]');
    expect(compose).toContain("command: all");
    expect(entrypoint).toContain("all)");
    expect(compose).not.toContain("command: gateway");
    expect(compose).not.toContain("command: console");
    expect(compose).not.toContain("command: worker");
    expect(compose).not.toContain("command: migrate");
    expect(compose.match(/image: llmingress-app:local/g)).toHaveLength(1);
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
