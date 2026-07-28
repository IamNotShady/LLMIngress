import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console success toast", () => {
  test("the toast host uses status for success, alert and red text for errors, then clears itself", () => {
    const src = read("_ui/toast.tsx");
    expect(src).toMatch(/<output/);
    expect(src).toContain('toast.tone === "red" ? "alert" : "status"');
    expect(src).toContain('toast.tone === "red" ? "text-redtx" : "text-ink"');
    expect(src).toContain('toast.tone === "red" ? "text-redtx" : "text-faint"');
    expect(src).toContain('red: "var(--red)"');
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

  test("button-only idempotent failures use the same red toast", () => {
    const mutationForm = read("_ui/mutation-form.tsx");
    const providerDetail = read("_ui/providers/detail.tsx");
    const overview = read("(dashboard)/page.tsx");
    const copyButton = read("_ui/copy-button.tsx");
    const playground = read("_ui/playground/playground.tsx");

    expect(mutationForm).toContain('errorPresentation?: "inline" | "toast"');
    expect(mutationForm).toContain('announceToast({ message, tone: "red" })');
    expect(providerDetail.match(/errorPresentation="toast"/g)).toHaveLength(3);
    expect(overview.match(/errorPresentation="toast"/g)).toHaveLength(1);
    expect(copyButton).toContain('tone: "red"');
    expect(playground).toContain("announceToast({");
    expect(playground).toContain('tone: response.ok ? "green" : "red"');
    expect(playground).not.toContain('className="fixed bottom-14');
  });
});
