import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  activityHref,
  activityWindowForUsageWindow,
  limitsHref,
} from "../../apps/console/src/app/_ui/cross-links.ts";

const appDir = join(process.cwd(), "apps/console/src/app");
const source = (file: string) => readFileSync(join(appDir, file), "utf8");

describe("cross-module links", () => {
  test("a jump into Activity carries the subject it was standing next to", () => {
    expect(activityHref({ apiKeyId: "key-1" })).toBe("/activity?apiKey=key-1");
    expect(activityHref({ status: "failed", virtualModelId: "vm-1" })).toBe(
      "/activity?status=failed&virtualModel=vm-1",
    );
    expect(activityHref({ status: "failed", window: "7d" })).toBe(
      "/activity?status=failed&window=7d",
    );
    // Nothing to carry is still a valid link — the module's own home.
    expect(activityHref()).toBe("/activity");
    expect(activityHref({ apiKeyId: "" })).toBe("/activity");
  });

  test("a jump into Limits narrows the list and opens the key's rules", () => {
    expect(limitsHref({ id: "key-1", name: "cursor agent" })).toBe(
      "/limits?q=cursor+agent&selected=key-1",
    );
  });

  test("Usage windows map onto the shorter horizon Activity keeps", () => {
    expect(activityWindowForUsageWindow("24h")).toBe("24h");
    expect(activityWindowForUsageWindow("7d")).toBe("7d");
    // Activity has no 30d window; the longest one it has is the honest answer.
    expect(activityWindowForUsageWindow("30d")).toBe("7d");
  });

  test("the parameter names are the ones the two pages read", () => {
    const activity = source("(dashboard)/activity/page.tsx");
    for (const param of ["apiKey", "provider", "status", "virtualModel", "window"]) {
      expect(activity, param).toContain(`readParam(params, "${param}")`);
    }
    const limits = source("(dashboard)/limits/page.tsx");
    for (const param of ["q", "selected", "state"]) {
      expect(limits, param).toContain(`readParam(params, "${param}")`);
    }
  });

  test("every cross-module link goes through the helper", () => {
    // A hand-written "/activity" or "/limits" href is how these drifted back to
    // unfiltered pages; the two that remain are deliberate.
    const files = [
      "_ui/api-keys/detail.tsx",
      "_ui/virtual-models/detail.tsx",
      "_ui/usage/panels.tsx",
      "_ui/masthead.tsx",
      "(dashboard)/page.tsx",
    ];
    for (const file of files) {
      expect(source(file), file).not.toMatch(/href="\/(activity|limits)"/);
    }
    // The Activity page's own "Clear filters" is meant to drop them all.
    expect(source("(dashboard)/activity/page.tsx")).toContain('href="/activity"');
  });
});
