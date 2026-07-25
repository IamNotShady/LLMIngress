import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { formatRelativeDateTime } from "../../apps/console/src/app/_ui/provider-relative-time";

const appDir = join(process.cwd(), "apps/console/src/app");
const read = (rel: string) => readFileSync(join(appDir, rel), "utf8");

describe("console providers IA contract", () => {
  test("relative Provider timestamps use one server-provided reference time", () => {
    const reference = Date.parse("2026-07-25T12:00:00.000Z");
    expect(formatRelativeDateTime("2026-07-25T11:59:30.000Z", reference)).toBe("just now");
    expect(formatRelativeDateTime("2026-07-25T11:30:00.000Z", reference)).toBe("30 min ago");
    expect(formatRelativeDateTime("2026-07-25T09:00:00.000Z", reference)).toBe("3 h ago");
    expect(formatRelativeDateTime("2026-07-20T09:00:00.000Z", reference)).toBe("2026-07-20");
    expect(formatRelativeDateTime("not-a-date", reference)).toBe("-");

    // The page passes one `now` down rather than each component reading a clock,
    // so two rows rendered together can never disagree about the present.
    const page = read("(dashboard)/providers/page.tsx");
    expect(page).toContain("const now = new Date()");
    expect(page).toContain("now={now}");
  });

  test("providers page has one representation: a list and its detail", () => {
    const page = read("(dashboard)/providers/page.tsx");
    expect(page).toContain("grid-cols-[344px_minmax(0,1fr)]");
    expect(page).toContain("<ProviderDetail");
    // No second summary grid duplicating the same providers above the list.
    expect(page).not.toMatch(/summary-card|provider-card-grid/);
  });

  test("model library search, availability and pagination execute on the server", () => {
    const page = read("(dashboard)/providers/page.tsx");
    expect(page).toContain("listProviderModelPage({");
    expect(page).toContain("availability,");
    expect(page).toContain('page: readIntParam(params, "modelPage", 1)');
    expect(page).toContain("query: modelQuery || null");
  });

  test("the virtual model dialog says Create when creating and Save when editing", () => {
    const dialogs = read("_ui/virtual-models/dialogs.tsx");
    expect(dialogs).toContain('editing ? "Save virtual model" : "Create virtual model"');
    expect(dialogs).toContain('editing ? "updateWithRoute" : "createWithRoute"');
  });

  test("display-only fields are disabled rather than styled to look editable", () => {
    const providerDialogs = read("_ui/providers/dialogs.tsx");
    // Template and provider type are fixed after creation.
    expect(providerDialogs).toMatch(/labelNote="\(fixed after creation\)"[\s\S]{0,400}?disabled/);
  });
});
