import { readdirSync, readFileSync } from "node:fs";
import { ConsoleOperationError } from "@llmingress/db/console-operation-error";
import { describe, expect, it } from "vitest";
import { classifyConsoleActionError } from "../../apps/console/src/app/api/_error-classify";
import { classifyAndLogConsoleActionError } from "../../apps/console/src/app/api/_errors";
import { readNumber } from "../../apps/console/src/app/api/_form";
import { renderOneTimeApiKeyResponse } from "../../apps/console/src/app/api/api-keys/_created-page";

const guardedRoutes = [
  "apps/console/src/app/api/api-key-limits/route.ts",
  "apps/console/src/app/api/api-keys/route.ts",
  "apps/console/src/app/api/playground/result/route.ts",
  "apps/console/src/app/api/prices/override/route.ts",
  "apps/console/src/app/api/provider-keys/route.ts",
  "apps/console/src/app/api/provider-model-capabilities/route.ts",
  "apps/console/src/app/api/provider-model-refresh/route.ts",
  "apps/console/src/app/api/provider-oauth/route.ts",
  "apps/console/src/app/api/providers/route.ts",
  "apps/console/src/app/api/virtual-models/route.ts",
];

class FakeDatabaseError extends Error {}

describe("console api hygiene", () => {
  it("maps explicit validation errors to 400 with their message and code", () => {
    expect(
      classifyConsoleActionError(
        new ConsoleOperationError("validation", "name is required.", {
          code: "name_required",
        }),
        "fallback",
      ),
    ).toEqual({
      code: "name_required",
      message: "name is required.",
      status: 400,
    });
  });

  it("maps plain errors, error subclasses, non-errors, and empty messages to 500 with the fallback", () => {
    expect(classifyConsoleActionError(new Error("name is required."), "fallback")).toEqual({
      code: "internal_error",
      message: "fallback",
      status: 500,
    });
    expect(
      classifyConsoleActionError(new FakeDatabaseError("relation missing"), "fallback"),
    ).toEqual({
      code: "internal_error",
      message: "fallback",
      status: 500,
    });
    expect(classifyConsoleActionError(new TypeError("x is not a function"), "fallback")).toEqual({
      code: "internal_error",
      message: "fallback",
      status: 500,
    });
    expect(classifyConsoleActionError("string throw", "fallback")).toEqual({
      code: "internal_error",
      message: "fallback",
      status: 500,
    });
    expect(classifyConsoleActionError(new Error(""), "fallback")).toEqual({
      code: "internal_error",
      message: "fallback",
      status: 500,
    });
  });

  it("routes authenticate through the shared wrapper only", () => {
    for (const file of guardedRoutes) {
      const source = readFileSync(file, "utf8");
      expect(source, file).toContain("withConsoleAuth(");
      expect(source, file).not.toContain("verifyConsoleSession");
    }
  });

  it("keeps the api-key-created HTML out of the route handler", () => {
    const source = readFileSync("apps/console/src/app/api/api-keys/route.ts", "utf8");
    expect(source).not.toContain("<!doctype");
    expect(source).toContain("renderOneTimeApiKeyResponse");
  });

  it("delegates each Console business mutation to one database transaction owner", () => {
    const providerKeyRoute = readFileSync(
      "apps/console/src/app/api/provider-keys/route.ts",
      "utf8",
    );
    expect(providerKeyRoute).toMatch(
      /updateProviderApiKeySettings\(\{[\s\S]*?quotaProbeEnabled:[\s\S]*?\}\)/,
    );
    expect(providerKeyRoute).toMatch(
      /saveProviderApiKey\(\{[\s\S]*?quotaProbeEnabled:[\s\S]*?\}\)/,
    );

    const providerOAuthRoute = readFileSync(
      "apps/console/src/app/api/provider-oauth/route.ts",
      "utf8",
    );
    expect(providerOAuthRoute).toMatch(
      /completeProviderOAuthAuthorization\(\{[\s\S]*?quotaProbeEnabled:[\s\S]*?\}\)/,
    );
    expect(providerOAuthRoute).toMatch(
      /updateProviderOAuthConnectionSettings\(\{[\s\S]*?quotaProbeEnabled:[\s\S]*?\}\)/,
    );

    const providerOAuthService = readFileSync("packages/db/src/console-provider-oauth.ts", "utf8");
    expect(providerOAuthService).toContain("replaceProviderOAuthDevicePendingConnection");
    expect(providerOAuthService).not.toContain("deletePendingProviderOAuthDeviceConnections");

    const auth = readFileSync("packages/db/src/console-auth.ts", "utf8");
    expect(auth).toMatch(/loginConsoleAdmin[\s\S]*?withPostgresTransaction/);
    expect(auth).toMatch(/createAdminPassword[\s\S]*?withPostgresTransaction/);

    const activity = readFileSync("packages/db/src/console-activity.ts", "utf8");
    expect(activity).toMatch(/getConsoleActivityDetail[\s\S]*?withPostgresTransaction/);
  });

  it("returns the actual virtual model name in one-time apiKey connection details", async () => {
    const response = renderOneTimeApiKeyResponse(
      {
        createdAt: new Date("2026-07-18T00:00:00.000Z"),
        defaultVirtualModelName: "audit-probe-vm",
        enabled: true,
        keyPrefix: "llmi_test_key",
        limits: [],
        name: "audit-probe-apiKey",
        plaintext: "llmi_test_key_value",
        virtualModelName: "audit-probe-vm",
        virtualModels: [],
      },
      "json",
    );

    const payload = await response.json();
    expect(payload).toMatchObject({
      keyPrefix: "llmi_test_key",
      virtualModelName: "audit-probe-vm",
    });
    expect(payload.guides).toHaveLength(8);
    expect(payload).not.toHaveProperty("integrationPlatform");
  });

  it("keeps an unexpected failure behind an id wherever it is shown", () => {
    // A refusal rendered into a dialog and a refusal returned as JSON are the
    // same event: the id is minted and logged once, here, so the operator can
    // quote it and the log holds the cause. A validation refusal has no id — it
    // is not a fault to look up, it is a field to fix.
    const unexpected = classifyAndLogConsoleActionError(
      new Error("connection refused"),
      "fallback",
    );
    expect(unexpected).toMatchObject({ code: "internal_error", message: "fallback", status: 500 });
    expect(unexpected.errorId).toMatch(/^[0-9a-f-]{36}$/);

    const validation = classifyAndLogConsoleActionError(
      new ConsoleOperationError("validation", "name is required.", { code: "name_required" }),
      "fallback",
    );
    expect(validation.errorId).toBeUndefined();
  });

  it("sanitizes action errors before surfacing them, on every route", () => {
    // The sanitizing happens inside consoleActionErrorResponse, which classifies
    // the error and keeps an unexpected one behind an id. A route that builds
    // its own body from the caught error is what this guards against.
    const routes = readdirSync("apps/console/src/app/api", { recursive: true })
      .map(String)
      .filter((file) => file.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThan(5);
    for (const file of routes) {
      const source = readFileSync(`apps/console/src/app/api/${file}`, "utf8");
      if (!source.includes("catch (error)")) {
        continue;
      }
      expect(source, file).toContain("consoleActionErrorResponse");
      expect(source, file).not.toMatch(/error:\s*(String\(error\)|error\.message|`\$\{error)/);
    }
  });
});

describe("form values the console reads back", () => {
  const form = (values: Record<string, string>) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(values)) {
      data.set(key, value);
    }
    return data;
  };

  it("refuses a number that is not one instead of falling back to a default", () => {
    // PRIORITY is a text field with inputMode=numeric, so "high" reaches the
    // route. Reading it as undefined let the caller's ?? 100 stand in, and the
    // operator got a row back that disagreed with what they typed.
    expect(readNumber(form({ priority: "20" }), "priority")).toBe(20);
    expect(readNumber(form({}), "priority")).toBeUndefined();
    expect(readNumber(form({ priority: "   " }), "priority")).toBeUndefined();

    let refused: unknown;
    try {
      readNumber(form({ priority: "high" }), "priority");
    } catch (error) {
      refused = error;
    }
    expect(classifyConsoleActionError(refused, "fallback")).toMatchObject({
      code: "priority_not_a_number",
      status: 400,
    });
    // And it names the field, so the dialog can ring the one that was refused.
    expect((refused as { details?: { field?: string } }).details?.field).toBe("priority");
  });
});
