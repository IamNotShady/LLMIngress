# Console Operator-Grade UI Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` or `superpowers:subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Polish the Console UI with the selected B direction: operator-grade, tactile, calm, and consistent, without changing layout or functionality.

**Architecture:** Keep changes in existing Console visual primitives. Prefer token and CSS cleanup over component rewrites. Do not install a UI library, do not restructure navigation, and do not change page layouts or product flows.

**Tech Stack:** Next.js App Router, React, CSS tokens in `apps/console/src/app/globals.css`, Vitest, Playwright, Biome.

---

## Scope

This is a visual-quality pass for the existing Console surface. It must preserve:

- Current routes, page layout, copy, and form behavior.
- Existing data flow, server actions, API routes, and database behavior.
- Current light/dark theme support.
- Existing accessibility affordances such as labels, focusability, and dialog semantics.

The selected scope is **Global primitives**:

- Design tokens.
- Buttons and links styled as buttons.
- Icon-only action buttons.
- Dialogs, scrims, popovers, and dropdown panels.
- Status pills, badges, warning/danger/ok colors.
- Table row hover, disclosure row hover, and focus states.
- Known hard-coded Console CSS colors in `globals.css`.

Out of scope:

- Pixel-perfect matching against `docs/UI/*.png`.
- Layout redesign.
- New visual components or new design system package.
- shadcn/ui installation or component replacement.
- API/schema/server behavior changes.
- Standalone one-time API-key HTML pages unless a later scope explicitly expands to the full chrome pass.

## File Map

- Modify `feature_list.json`
  - Add `feat-121` as the tracker source of truth before implementation.
- Modify `progress.md`
  - Record the session state, verification commands, and final evidence.
- Modify `apps/console/src/app/globals.css`
  - Implement the operator-grade polish through existing tokens and primitives.
- Create `tests/features/feat-121-console-ui-polish.unit.test.ts`
  - Static contract test for tokenized styling and shared primitive coverage.
- Create `tests/e2e/console-ui-polish.e2e.spec.ts`
  - Browser contract for button/dialog visual hierarchy and no horizontal overflow.

## Task 1: Register `feat-121`

**Files:**

- Modify `feature_list.json`
- Modify `progress.md`

- [ ] Add a new pending feature entry after `feat-120`:

```json
{
  "id": "feat-121",
  "name": "Console Operator-Grade UI Polish",
  "description": "Console keeps the existing layout and functionality while shared UI primitives use a consistent operator-grade visual system for buttons, dialogs, popovers, status colors, hover states, focus states, borders, and shadows.",
  "verification": "pnpm exec vitest run tests/features/feat-121-console-ui-polish.unit.test.ts && pnpm test:e2e tests/e2e/console-ui-polish.e2e.spec.ts",
  "dependencies": ["feat-120"],
  "status": "pending",
  "evidence": ""
}
```

- [ ] Add a short `progress.md` note stating that `feat-121` is opened for a no-layout-change Console polish pass.

- [ ] Run tracker sanity check:

```bash
node -e "const f=require('./feature_list.json').features; console.log(f.at(-1).id, f.at(-1).status, f.at(-1).name)"
```

Expected output includes:

```text
feat-121 pending Console Operator-Grade UI Polish
```

## Task 2: Write the Failing Unit Test

**Files:**

- Create `tests/features/feat-121-console-ui-polish.unit.test.ts`

- [ ] Create the test file:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = resolve(import.meta.dirname, "../../apps/console/src/app/globals.css");
const css = readFileSync(cssPath, "utf8");

describe("feat-121 console UI polish", () => {
  it("keeps global UI polish tokenized instead of hard-coded hex colors", () => {
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}/);

    for (const token of [
      "--danger-strong",
      "--danger-fg",
      "--shadow-control",
      "--shadow-control-hover",
      "--shadow-dialog",
      "--overlay",
    ]) {
      expect(css).toContain(token);
    }
  });

  it("defines polished shared primitives", () => {
    for (const selector of [
      "button,",
      ".secondary-button",
      ".console-dialog",
      ".console-dialog-scrim",
      ".agent-vm-multi-select-panel",
      ".date-picker-popover",
      ".pill--danger",
      ".provider-action-delete",
      ".limits-rule-delete-button",
      ".vm-candidate-remove",
    ]) {
      expect(css).toContain(selector);
    }
  });
});
```

- [ ] Run the test and confirm RED:

```bash
pnpm exec vitest run tests/features/feat-121-console-ui-polish.unit.test.ts
```

Expected: FAIL because `globals.css` still contains hard-coded hex colors and does not yet define all required polish tokens.

## Task 3: Write the Failing E2E Test

**Files:**

- Create `tests/e2e/console-ui-polish.e2e.spec.ts`

- [ ] Create the browser contract:

```ts
import { expect, test } from "@playwright/test";
import { withConsoleDevServer } from "../support/console-dev-server";

test("operator-grade primitives preserve layout and visual hierarchy", async ({ browser }) => {
  await withConsoleDevServer(browser, async ({ page, baseUrl }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${baseUrl}/agents`, { waitUntil: "domcontentloaded" });

    const primary = page.getByRole("link", { name: "Create Agent" });
    await expect(primary).toBeVisible();

    const primaryBefore = await primary.boundingBox();
    if (!primaryBefore) {
      throw new Error("Create Agent button did not render with measurable bounds.");
    }

    const primaryStyle = await primary.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        boxShadow: style.boxShadow,
        color: style.color,
      };
    });
    expect(primaryStyle.boxShadow).not.toBe("none");
    expect(primaryStyle.backgroundColor).not.toBe(primaryStyle.borderColor);

    await primary.click();
    const dialog = page.getByRole("dialog", { name: "New agent" });
    await expect(dialog).toBeVisible();

    const dialogStyle = await dialog.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        borderRadius: Number.parseFloat(style.borderRadius),
        boxShadow: style.boxShadow,
      };
    });
    expect(dialogStyle.borderRadius).toBeGreaterThanOrEqual(10);
    expect(dialogStyle.boxShadow).not.toBe("none");

    const secondary = dialog.getByRole("link", { name: "Close" });
    await expect(secondary).toBeVisible();
    const secondaryStyle = await secondary.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderColor: style.borderColor,
        color: style.color,
      };
    });
    expect(secondaryStyle.backgroundColor).not.toBe(primaryStyle.backgroundColor);
    expect(secondaryStyle.color).not.toBe(primaryStyle.color);

    const primaryAfter = await primary.boundingBox();
    if (!primaryAfter) {
      throw new Error("Create Agent button disappeared after opening dialog.");
    }
    expect(Math.abs(primaryAfter.width - primaryBefore.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(primaryAfter.height - primaryBefore.height)).toBeLessThanOrEqual(1);

    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${baseUrl}/playground`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { level: 1, name: "Playground" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );
  });
});
```

- [ ] Run the test and confirm RED:

```bash
pnpm test:e2e tests/e2e/console-ui-polish.e2e.spec.ts
```

Expected: FAIL until the primary/dialog primitives expose the required visual hierarchy.

## Task 4: Add Minimal Semantic Tokens

**Files:**

- Modify `apps/console/src/app/globals.css`

- [ ] In `:root`, add token names only:

```css
  --shadow-control: 0 0 0 transparent;
  --shadow-control-hover: 0 0 0 transparent;
  --shadow-dialog: var(--shadow-pop);
  --overlay: color-mix(in srgb, var(--canvas) 72%, transparent);
```

- [ ] In light theme, define semantic danger and elevation values:

```css
  --danger-strong: oklch(0.46 0.2 25);
  --danger-fg: oklch(0.99 0.012 25);
  --shadow-control: 0 1px 2px oklch(0.2 0.03 var(--hue) / 0.08),
    0 8px 18px -16px oklch(0.2 0.03 var(--hue) / 0.32);
  --shadow-control-hover: 0 2px 4px oklch(0.2 0.03 var(--hue) / 0.1),
    0 12px 22px -16px oklch(0.2 0.03 var(--hue) / 0.38);
  --shadow-dialog: 0 18px 48px -20px oklch(0.2 0.03 var(--hue) / 0.36),
    0 0 0 1px oklch(1 0 0 / 0.7) inset;
  --overlay: color-mix(in srgb, var(--canvas) 76%, transparent);
```

- [ ] In dark theme and the no-JS dark fallback block, define dark equivalents:

```css
  --danger-strong: oklch(0.62 0.18 25);
  --danger-fg: oklch(0.98 0.01 25);
  --shadow-control: 0 1px 2px oklch(0 0 0 / 0.36),
    0 10px 24px -18px oklch(0 0 0 / 0.7);
  --shadow-control-hover: 0 2px 5px oklch(0 0 0 / 0.42),
    0 16px 30px -18px oklch(0 0 0 / 0.82);
  --shadow-dialog: 0 22px 56px -22px oklch(0 0 0 / 0.78),
    0 0 0 1px oklch(1 0 0 / 0.04) inset;
  --overlay: color-mix(in srgb, var(--canvas) 68%, transparent);
```

Do not add theme-specific layout rules.

## Task 5: Polish Shared Controls

**Files:**

- Modify `apps/console/src/app/globals.css`

- [ ] Update `button, .btn` to use stronger hierarchy without changing size:

```css
button,
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  min-height: 2.75rem;
  padding: 0 var(--space-md);
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 650;
  color: var(--accent-fg);
  background: linear-gradient(
    180deg,
    color-mix(in oklch, var(--accent) 92%, var(--surface) 8%),
    var(--accent)
  );
  border: 1px solid color-mix(in oklch, var(--accent-strong) 78%, var(--border) 22%);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-control);
  cursor: pointer;
  transition: background-color 0.15s var(--ease-out), border-color 0.15s var(--ease-out),
    box-shadow 0.15s var(--ease-out), color 0.15s var(--ease-out),
    transform 0.05s var(--ease-out);
}
button:hover,
.btn:hover {
  background: var(--accent-strong);
  box-shadow: var(--shadow-control-hover);
}
button:active,
.btn:active {
  transform: translateY(1px);
}
```

- [ ] Keep `.secondary-button, .btn-ghost` visually quieter:

```css
.secondary-button,
.btn-ghost {
  color: var(--text);
  background: var(--surface);
  border-color: var(--border-strong);
  box-shadow: none;
}
.secondary-button:hover,
.btn-ghost:hover {
  background: var(--surface-inset);
  border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
```

- [ ] Replace destructive button hard-coded colors:

```css
.agent-action-delete,
.agent-delete-confirm,
.limits-rule-delete-button,
.vm-candidate-remove {
  color: var(--danger-fg) !important;
  background: var(--danger) !important;
  border-color: var(--danger) !important;
}
.agent-action-delete:hover,
.agent-delete-confirm:hover,
.limits-rule-delete-button:hover,
.vm-candidate-remove:hover {
  color: var(--danger-fg) !important;
  background: var(--danger-strong) !important;
  border-color: var(--danger-strong) !important;
}
```

If existing selectors are more specific, replace values in place instead of adding duplicate rules.

## Task 6: Polish Dialogs, Popovers, Rows, and Pills

**Files:**

- Modify `apps/console/src/app/globals.css`

- [ ] Update `.console-dialog`:

```css
.console-dialog {
  position: fixed;
  top: 5vh;
  right: auto;
  bottom: auto;
  left: 50%;
  transform: translateX(-50%);
  z-index: 50;
  width: min(46rem, calc(100vw - 2rem));
  max-height: 90vh;
  overflow-y: auto;
  margin: 0;
  padding: var(--space-lg);
  color: var(--text);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-dialog);
}
```

- [ ] Update `.console-dialog-scrim`:

```css
.console-dialog-scrim {
  position: fixed;
  inset: 0;
  z-index: 49;
  background: var(--overlay);
}
```

- [ ] Ensure popovers use the same elevation family:

```css
.agent-vm-multi-select-panel,
.date-picker-popover {
  box-shadow: var(--shadow-dialog);
}
```

- [ ] Strengthen hover feedback without moving layout:

```css
.activity-list-item,
.activity-list-item-selected,
.row-summary,
.data-table tbody tr.is-clickable {
  transition: border-color 0.15s var(--ease-out), background-color 0.15s var(--ease-out),
    box-shadow 0.15s var(--ease-out);
}
.activity-list-item:hover,
.row-summary:hover,
.data-table tbody tr.is-clickable:hover {
  box-shadow: var(--shadow-sm);
}
```

- [ ] Keep pills tokenized:

```css
.pill--ok {
  color: var(--ok);
  background: var(--ok-soft);
}
.pill--warn {
  color: var(--warn);
  background: var(--warn-soft);
}
.pill--danger {
  color: var(--danger);
  background: var(--danger-soft);
}
.pill--info {
  color: var(--accent-strong);
  background: var(--accent-soft);
}
```

Do not change pill text, padding, or placement.

## Task 7: Remove Hard-Coded Colors from `globals.css`

**Files:**

- Modify `apps/console/src/app/globals.css`

- [ ] Replace known hard-coded colors with tokens:

| Existing value | Replacement |
| --- | --- |
| `#fff` | `var(--danger-fg)` or `var(--surface)` depending on context |
| `#dc2626` | `var(--danger)` |
| `#b91c1c` | `var(--danger-strong)` |
| `#16a34a` | `var(--ok)` |
| `#dcfce7` | `var(--ok-soft)` |
| `#ef4444` | `var(--danger)` |
| `#fee2e2` | `var(--danger-soft)` |
| `#f59e0b` | `var(--warn)` |
| `#fef3c7` | `var(--warn-soft)` |
| `#7c3aed` | `var(--accent-strong)` |
| `#ede9fe` | `var(--accent-soft)` |
| `#0b1020` | `var(--surface-sunken)` |
| `#dbe7ff` | `var(--text)` |

- [ ] Run:

```bash
rg -n "#[0-9a-fA-F]{3,8}" apps/console/src/app/globals.css
```

Expected: no output.

Do not remove hard-coded chart colors in TypeScript in this scope unless the tests require it. This pass is scoped to `globals.css`.

## Task 8: Focused Verification

- [ ] Run the unit test:

```bash
pnpm exec vitest run tests/features/feat-121-console-ui-polish.unit.test.ts
```

Expected: PASS.

- [ ] Run the E2E test:

```bash
pnpm test:e2e tests/e2e/console-ui-polish.e2e.spec.ts
```

Expected: PASS.

- [ ] Run Console coverage smoke:

```bash
pnpm run test:e2e:coverage
```

Expected: all Console nav pages visited and JavaScript coverage collected.

## Task 9: Browser Visual Check

- [ ] Start the standard dev path only if a live visual check is needed:

```bash
./init.sh
```

- [ ] Open Console and check at least:

```text
/
/agents
/providers
/models
/playground
```

- [ ] Verify:
  - primary buttons have clear hierarchy but no oversized hero styling,
  - secondary buttons recede,
  - destructive buttons are tokenized and legible in light/dark,
  - dialogs and popovers feel consistent,
  - hover/focus states do not shift layout,
  - no horizontal overflow at desktop or mobile widths.

If `./init.sh` blocks as expected, stop it after the visual check.

## Task 10: Full Verification and Tracker Update

- [ ] Run:

```bash
pnpm run lint
pnpm run typecheck
pnpm run verify
pnpm run verify:features
```

- [ ] If all verification passes, update `feature_list.json`:

```json
"status": "passing",
"evidence": "YYYY-MM-DD: TDD red observed for feat-121 unit and E2E tests before implementation. Operator-grade Console primitive polish implemented without layout or functionality changes. Focused unit/E2E, Console E2E coverage, lint, typecheck, pnpm run verify, and pnpm run verify:features passed."
```

- [ ] Update `progress.md` with:
  - files changed,
  - verification commands and results,
  - any intentional non-changes such as no layout rewrite and no new dependencies.

## Acceptance Criteria

- Console layout and workflows are unchanged.
- Global UI primitives feel more consistent and operator-grade.
- `globals.css` no longer contains hard-coded hex colors.
- Light and dark themes both use tokens.
- Primary, secondary, and destructive actions have clear hierarchy.
- Dialogs and popovers share consistent border, radius, shadow, and overlay treatment.
- Hover/focus states are visible and do not cause layout shift.
- No horizontal overflow at `1280px` desktop or `390px` mobile.
- Focused tests, `pnpm run verify`, and `pnpm run verify:features` pass.

## Ponytail Notes

- No new component abstraction unless a selector cannot be expressed safely in CSS.
- No new package.
- Do not touch server code, migrations, or Console data queries.
- Do not chase pixel-perfect `docs/UI` screenshots in this pass.
- If a polish idea requires JSX restructuring, skip it unless it fixes a concrete failing test.
