import { readFileSync } from "node:fs";
import { ConsoleOperationError } from "@llmingress/db/console-operation-error";
import { describe, expect, it } from "vitest";
import { classifyConsoleActionError } from "../../apps/console/src/app/api/_error-classify";
import { renderOneTimeAgentResponse } from "../../apps/console/src/app/api/agents/_created-page";

const guardedRoutes = [
  "apps/console/src/app/api/agent-limits/route.ts",
  "apps/console/src/app/api/agents/route.ts",
  "apps/console/src/app/api/playground/result/route.ts",
  "apps/console/src/app/api/prices/override/route.ts",
  "apps/console/src/app/api/provider-keys/route.ts",
  "apps/console/src/app/api/provider-model-capabilities/route.ts",
  "apps/console/src/app/api/provider-model-refresh/route.ts",
  "apps/console/src/app/api/provider-oauth/route.ts",
  "apps/console/src/app/api/providers/route.ts",
  "apps/console/src/app/api/route-policies/route.ts",
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

  it("keeps the agent-created HTML out of the route handler", () => {
    const source = readFileSync("apps/console/src/app/api/agents/route.ts", "utf8");
    expect(source).not.toContain("<!doctype");
    expect(source).toContain("renderOneTimeAgentResponse");
  });

  it("returns the actual virtual model name in one-time agent connection details", async () => {
    const response = renderOneTimeAgentResponse(
      {
        keyPrefix: "llmi_test_key",
        plaintext: "llmi_test_key_value",
        virtualModelName: "audit-probe-vm",
      },
      "json",
    );

    await expect(response.json()).resolves.toMatchObject({
      virtualModelName: "audit-probe-vm",
    });
  });

  it("sanitizes provider action errors before surfacing them", () => {
    const providers = readFileSync("apps/console/src/app/api/providers/route.ts", "utf8");
    expect(providers).toContain("classifyConsoleActionError");
    const oauth = readFileSync("apps/console/src/app/api/provider-oauth/route.ts", "utf8");
    expect(oauth).toContain("classifyConsoleActionError");
    expect(oauth).toContain("consoleActionErrorResponse");
  });
});
