import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConsoleOperationError } from "@llmingress/db/console-operation-error";
import { describe, expect, it } from "vitest";
import { classifyConsoleActionError } from "../../apps/console/src/app/api/_error-classify";

describe("console request security contract", () => {
  it("does not inspect request origins before Console handlers", () => {
    const authSource = readFileSync("apps/console/src/app/api/_auth.ts", "utf8");
    const configSource = readFileSync("packages/config/src/index.ts", "utf8");

    expect(authSource).not.toContain('headers.get("origin")');
    expect(authSource).not.toContain("withConsoleOrigin");
    expect(configSource).not.toContain("CONSOLE_PUBLIC_BASE_URL");
    expect(configSource).not.toContain("csrf_origin_mismatch");
  });

  it("maps explicit console operation errors by fixed kind without constructor checks", () => {
    expect(
      classifyConsoleActionError(
        new ConsoleOperationError("validation", "Provider key is required.", {
          code: "provider_key_required",
          details: { field: "providerKey" },
        }),
        "fallback",
      ),
    ).toEqual({
      code: "provider_key_required",
      details: { field: "providerKey" },
      message: "Provider key is required.",
      status: 400,
    });

    expect(
      classifyConsoleActionError(
        new ConsoleOperationError("not_found", "Provider was not found.", {
          code: "provider_not_found",
        }),
        "fallback",
      ),
    ).toMatchObject({ code: "provider_not_found", status: 404 });

    expect(
      classifyConsoleActionError(
        new ConsoleOperationError("conflict", "Virtual Model already has a route policy.", {
          code: "route_policy_conflict",
        }),
        "fallback",
      ),
    ).toMatchObject({ code: "route_policy_conflict", status: 409 });

    expect(readFileSync("apps/console/src/app/api/_error-classify.ts", "utf8")).not.toContain(
      "constructor === Error",
    );
  });

  it("classifies unexpected exceptions as internal_error and the response helper assigns error ids", () => {
    const verdict = classifyConsoleActionError(
      new Error("relation provider_api_keys missing at /tmp/secret.sql"),
      "Config import failed.",
    );
    expect(verdict).toMatchObject({
      code: "internal_error",
      message: "Config import failed.",
      status: 500,
    });
    const responseSource = readFileSync("apps/console/src/app/api/_errors.ts", "utf8");
    expect(responseSource).toContain("randomUUID()");
    expect(responseSource).toContain("errorId");
    expect(responseSource).not.toContain("error.message");
  });

  it("keeps direct Console JSON error responses code-addressable", () => {
    for (const filePath of listSourceFiles("apps/console/src/app/api")) {
      const source = readFileSync(filePath, "utf8");
      const directErrorResponses = source.matchAll(/NextResponse\.json\(\s*\{[^}]*error:[^}]*\}/gs);
      for (const match of directErrorResponses) {
        expect(match[0], `${filePath} JSON error response must include code`).toContain("code:");
      }
    }
  });
});

function listSourceFiles(root: string): string[] {
  const entries = readdirSync(root);
  return entries.flatMap((entry) => {
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      return listSourceFiles(path);
    }
    return path.endsWith(".ts") ? [path] : [];
  });
}
