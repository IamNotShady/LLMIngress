import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConsoleOperationError } from "@llmingress/db/console-operation-error";
import { describe, expect, it } from "vitest";
import { classifyConsoleActionError } from "../../apps/console/src/app/api/_error-classify";
import { consolePublicBaseUrl, validateConsoleOrigin } from "../../packages/config/src/index";

describe("console request security contract", () => {
  it("rejects unsafe methods without an exact allowed Origin", () => {
    const missing = validateConsoleOrigin({
      method: "POST",
      originHeader: null,
      requestUrl: "http://console.local/api/agents",
    });
    expect(missing).toMatchObject({
      code: "csrf_origin_mismatch",
      error: "Request origin is not allowed.",
    });

    const sameOrigin = validateConsoleOrigin({
      method: "POST",
      originHeader: "http://console.local",
      requestUrl: "http://console.local/api/agents",
    });
    expect(sameOrigin).toEqual({ ok: true });

    const crossOrigin = validateConsoleOrigin({
      method: "DELETE",
      originHeader: "http://evil.test",
      requestUrl: "http://console.local/api/providers",
    });
    expect(crossOrigin.ok).toBe(false);

    const nullOrigin = validateConsoleOrigin({
      method: "PATCH",
      originHeader: "null",
      requestUrl: "http://console.local/api/providers",
    });
    expect(nullOrigin.ok).toBe(false);

    const safeGet = validateConsoleOrigin({
      method: "GET",
      originHeader: null,
      requestUrl: "http://console.local/api/config-export",
    });
    expect(safeGet).toEqual({ ok: true });
  });

  it("uses CONSOLE_PUBLIC_BASE_URL as the only trusted public origin when configured", () => {
    expect(consolePublicBaseUrl({ CONSOLE_PUBLIC_BASE_URL: "https://console.example" })).toBe(
      "https://console.example",
    );
    expect(() =>
      consolePublicBaseUrl({ CONSOLE_PUBLIC_BASE_URL: "https://console.example/path" }),
    ).toThrow(/CONSOLE_PUBLIC_BASE_URL/);

    const configured = validateConsoleOrigin({
      configuredOrigin: "https://console.example",
      method: "POST",
      originHeader: "https://console.example",
      requestUrl: "http://127.0.0.1:3000/api/agents",
    });
    expect(configured).toEqual({ ok: true });

    const forwardedGuess = validateConsoleOrigin({
      configuredOrigin: "https://console.example",
      method: "POST",
      originHeader: "http://127.0.0.1:3000",
      requestUrl: "http://127.0.0.1:3000/api/agents",
    });
    expect(forwardedGuess.ok).toBe(false);
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
