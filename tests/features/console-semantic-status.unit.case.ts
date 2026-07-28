import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { failureRateTone, formatDelta } from "../../apps/console/src/app/_ui/format";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console semantic status contract", () => {
  test("deltas speak valence, not direction", () => {
    // More requests is good; the same rise in cost would not be.
    expect(formatDelta(110, 100, "up-good")?.tone).toBe("good");
    expect(formatDelta(110, 100, "down-good")?.tone).toBe("bad");
    expect(formatDelta(90, 100, "down-good")?.tone).toBe("good");
    expect(formatDelta(100, 100)?.tone).toBe("neutral");
    // With no prior window there is no delta to state.
    expect(formatDelta(100, 0)).toBeNull();
  });

  test("every KPI delta states which direction is good", () => {
    const overview = read("(dashboard)/page.tsx");
    expect(overview).toMatch(/formatDelta\([^)]*"(up|down)-good"\)/);
  });

  test("failure rates cross into warn and danger at fixed thresholds", () => {
    expect(failureRateTone(0)).toBe("neutral");
    expect(failureRateTone(0.049)).toBe("neutral");
    expect(failureRateTone(0.05)).toBe("warn");
    expect(failureRateTone(0.2)).toBe("danger");

    for (const file of ["(dashboard)/page.tsx", "(dashboard)/usage/page.tsx"]) {
      expect(read(file), file).toContain("failureRateTone(");
    }
  });

  test("disabled wears a neutral tone, never error red", () => {
    const providerModel = read("_ui/providers/model.ts");
    // A disabled connection is not probed; it is neither healthy nor failing.
    expect(providerModel).toContain('{ text: "not probed · disabled", tone: "dim" }');
    expect(providerModel).not.toMatch(/disabled[^\n]*tone: "red"/);

    const apiKeyDetail = read("_ui/api-keys/detail.tsx");
    expect(apiKeyDetail).toContain('apiKey.enabled ? "text-green" : "text-faint"');
  });

  test("destructive emphasis is limited to delete actions", () => {
    for (const file of [
      "_ui/providers/detail.tsx",
      "_ui/api-keys/detail.tsx",
      "_ui/virtual-models/detail.tsx",
    ]) {
      const src = read(file);
      const dangerUses = src.match(/tone="danger"/g) ?? [];
      const deleteLinks = src.match(/tone="danger"[\s\S]{0,120}?Delete/g) ?? [];
      expect(dangerUses.length, file).toBe(deleteLinks.length);
    }
  });
});
