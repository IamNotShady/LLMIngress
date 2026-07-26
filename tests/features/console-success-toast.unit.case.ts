import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console success toast", () => {
  test("the toast host announces politely and clears itself", () => {
    const src = read("_ui/toast.tsx");
    // <output> carries an implicit role=status, so a success notice never
    // interrupts a screen reader the way an alert would.
    expect(src).toMatch(/<output/);
    expect(src).toMatch(/const TOAST_MS = 4000/);
    expect(src).toMatch(/setTimeout\(\(\) => setToast\(null\), TOAST_MS\)/);
  });

  test("a toast is announced as an event rather than parked in the URL", () => {
    const src = read("_ui/toast.tsx");
    // A toast is something that just happened, not somewhere the operator is.
    // In the query string it outlives its action, survives a reload, and every
    // later link has to remember to strip it.
    expect(src).toContain("export function announceToast");
    expect(src).toContain("new CustomEvent<ConsoleToast>(TOAST_EVENT");
    // The no-JavaScript path still works: a server redirect can carry one.
    expect(src).toContain('params.get("toast")');
    expect(read("_ui/mutation-form.tsx")).toContain("announceToast(answer.toast)");
  });

  test("the host is mounted once, on the shell every module shares", () => {
    const layout = read("(dashboard)/layout.tsx");
    expect(layout).toMatch(/<ToastHost \/>/);
  });

  test("idempotent actions report through a toast rather than a confirm", () => {
    // Re-check and refresh change nothing that needs confirming, so they report
    // after the fact instead of asking first.
    expect(read("api/provider-health-probes/route.ts")).toMatch(/toast=/);
    expect(read("api/provider-model-refresh/route.ts")).toMatch(/toast=/);
  });
});
