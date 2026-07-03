# Console Dark Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reskin the Console to the approved dark-only / violet / Geist design (spec: `docs/superpowers/specs/2026-07-03-console-dark-restyle-design.md`) without touching page layout or module logic.

**Architecture:** Everything in the Console is styled through CSS custom properties in `apps/console/src/app/globals.css` plus semantic class recipes. We collapse the light+dark token blocks into one dark token layer, then adjust the handful of recipes whose *shape* (not color) changes: buttons, inputs, stat cards, nav chips, tables, glows. Charts already consume `var(--token)` colors, so they follow automatically once `palette.ts` points at new chart tokens. Theme toggle and its bootstrap script are deleted; `v1-console`'s E2E contract moves to dark-only.

**Tech Stack:** Next.js 16 (App Router), `next/font/google` (Geist, Geist Mono), plain CSS custom properties (OKLCH), Recharts, Vitest, Playwright.

**Working directory:** the `console-dark-restyle` worktree (branch `worktree-console-dark-restyle`). All commands run from the worktree root. Database-backed E2E needs `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres`.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `tests/support/console-app.ts` | Create | Shared Playwright harness: boot/stop the real console `next dev` process, first-run sign-in |
| `tests/e2e/v1-console.e2e.spec.ts` | Modify | Use shared harness; theme-toggle assertions → dark-only assertions |
| `tests/features/console-dark-restyle.unit.test.ts` | Create | Static contract of the token layer (dark-only, Geist, compact buttons, chart tokens) |
| `tests/e2e/console-dark-restyle.e2e.spec.ts` | Create | Rendered contract on the real app (dark canvas, Geist, violet primary, 30px buttons, no toggle, no overflow at 1280/390) |
| `feature_list.json` | Modify | Add `console-dark-restyle` entry |
| `apps/console/src/app/layout.tsx` | Modify | Geist fonts, hardcoded `data-theme="dark"`, delete theme bootstrap |
| `apps/console/src/app/_components/theme-toggle.tsx` | Delete | Gone with light theme |
| `apps/console/src/app/_components/sidebar.tsx` | Modify | Drop ThemeToggle import/render |
| `apps/console/src/app/_components/stat-card.tsx` | Modify | Stop rendering the circular icon chip |
| `apps/console/src/app/globals.css` | Modify | Token recast + recipe edits (the bulk of the work) |
| `apps/console/src/app/_components/charts/palette.ts` | Modify | Categorical palette → `--chart-1..6` |
| `apps/console/src/app/_components/charts/trend-line-chart.tsx` | Modify | Grid/tooltip use hairline / raised-surface tokens |
| `apps/console/src/app/_modules/sections.tsx` | Modify | Replace 3 hardcoded hex chart colors with chart tokens |
| `progress.md` | Modify | Session log |

---

### Task 1: Extract shared console E2E harness

The theme assertions in `tests/e2e/v1-console.e2e.spec.ts` change in Task 4, and the new E2E (Task 3) needs the same boot/sign-in helpers. Extract them once so the two specs don't duplicate ~100 lines.

**Files:**
- Create: `tests/support/console-app.ts`
- Modify: `tests/e2e/v1-console.e2e.spec.ts`

- [ ] **Step 1: Create `tests/support/console-app.ts`**

Move these five helpers verbatim from `tests/e2e/v1-console.e2e.spec.ts` (lines 79–188) and export them. Only the `Page`/`expect` imports change source file:

```ts
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createServer } from "node:net";
import { expect, type Page } from "@playwright/test";

export type ConsoleProcess = {
  child: ChildProcessWithoutNullStreams;
  port: number;
  stderr: string[];
  stdout: string[];
};

export async function signInFromFirstRun(page: Page, baseUrl: string) {
  const password = "correct horse battery staple";

  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "First run setup" })).toBeVisible();
  await page.getByLabel("Admin password").fill(password);
  await page.getByRole("button", { name: "Create admin" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Admin password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate TCP port.")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitForConsole(baseUrl: string, consoleApp: ConsoleProcess): Promise<void> {
  await expect
    .poll(
      async () => {
        if (consoleApp.child.exitCode !== null) {
          return `exited:${consoleApp.child.exitCode}`;
        }

        try {
          const response = await fetch(baseUrl);
          return response.status;
        } catch {
          return "not-ready";
        }
      },
      {
        message: "Console did not start.",
        timeout: 30_000,
      },
    )
    .toBe(200);
}

export function startConsoleProcess(options: { databaseUrl: string; port: number }): ConsoleProcess {
  const child = spawn(
    "pnpm",
    [
      "--filter",
      "@llmingress/console",
      "exec",
      "next",
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(options.port),
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONSOLE_PORT: String(options.port),
        DATABASE_URL: options.databaseUrl,
        MASTER_KEY: "test-master-key",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const consoleApp: ConsoleProcess = {
    child,
    port: options.port,
    stderr: [],
    stdout: [],
  };
  child.stderr.on("data", (chunk) => consoleApp.stderr.push(String(chunk)));
  child.stdout.on("data", (chunk) => consoleApp.stdout.push(String(chunk)));
  return consoleApp;
}

export async function stopConsoleProcess(consoleApp: ConsoleProcess): Promise<void> {
  if (consoleApp.child.exitCode !== null) {
    return;
  }

  consoleApp.child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    consoleApp.child.once("exit", () => resolve());
    setTimeout(() => {
      if (consoleApp.child.exitCode === null) {
        consoleApp.child.kill("SIGKILL");
      }
      resolve();
    }, 2_000);
  });
}
```

- [ ] **Step 2: Rewire `tests/e2e/v1-console.e2e.spec.ts` to import the harness**

Delete lines 79–188 (the `ConsoleProcess` type and the five helper functions) and the now-unused imports `spawn`, `ChildProcessWithoutNullStreams`, `createServer`, `Page`. Add:

```ts
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
```

- [ ] **Step 3: Verify v1-console E2E still passes (pure refactor, no behavior change)**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres pnpm test:e2e tests/e2e/v1-console.e2e.spec.ts`
Expected: PASS (1 test)

- [ ] **Step 4: Lint and commit**

```bash
pnpm run lint:fix
git add tests/support/console-app.ts tests/e2e/v1-console.e2e.spec.ts
git commit -m "refactor(tests): extract shared console E2E process harness"
```

---

### Task 2: Register the feature and write the failing unit test

**Files:**
- Modify: `feature_list.json`
- Create: `tests/features/console-dark-restyle.unit.test.ts`

- [ ] **Step 1: Add the feature entry**

Append to the `features` array in `feature_list.json`:

```json
{
  "id": "console-dark-restyle",
  "name": "Console Dark Restyle",
  "description": "The Console serves a dark-only skin from the real app: dark canvas and Geist fonts render on live pages, primary buttons are compact 30px violet, the theme toggle is gone, and pages show no horizontal overflow at 1280px and 390px.",
  "verification": "pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts && pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts",
  "dependencies": ["v1-console"],
  "status": "failing",
  "evidence": "2026-07-03: Registered with failing tests ahead of implementation (TDD)."
}
```

- [ ] **Step 2: Write the failing unit test**

Create `tests/features/console-dark-restyle.unit.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const appDir = join(process.cwd(), "apps/console/src/app");
const css = () => readFileSync(join(appDir, "globals.css"), "utf8");
const layout = () => readFileSync(join(appDir, "layout.tsx"), "utf8");

describe("console dark restyle static contract", () => {
  test("globals.css defines a single dark-only token layer", () => {
    const text = css();
    // No theme switching selectors remain.
    expect(text).not.toMatch(/\[data-theme=/);
    // Dark canvas: OKLCH lightness below 0.2.
    expect(text).toMatch(/--canvas:\s*oklch\(0\.1\d*\s/);
    // Violet accent hue anchor.
    expect(text).toMatch(/--hue:\s*288\b/);
    // Hairline + glow tokens exist.
    expect(text).toContain("--hairline:");
    expect(text).toContain("--glow-accent:");
    // Fixed categorical chart tokens.
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(text).toContain(`--chart-${n}:`);
    }
  });

  test("buttons are compact (30px), not the old 44px", () => {
    expect(css()).toMatch(/min-height:\s*1\.875rem/);
    expect(css()).not.toMatch(/min-height:\s*2\.75rem/);
  });

  test("layout serves Geist fonts and a hardcoded dark theme", () => {
    const text = layout();
    expect(text).toMatch(/Geist,?\s/);
    expect(text).toContain("Geist_Mono");
    expect(text).not.toContain("Bricolage_Grotesque");
    expect(text).not.toContain("Hanken_Grotesk");
    expect(text).not.toContain("Spline_Sans_Mono");
    expect(text).toContain('data-theme="dark"');
    // Theme persistence bootstrap is gone.
    expect(text).not.toContain("llmingress-theme");
    expect(text).not.toContain("prefers-color-scheme");
  });

  test("theme toggle component is deleted and unreferenced", () => {
    expect(existsSync(join(appDir, "_components/theme-toggle.tsx"))).toBe(false);
    const sidebar = readFileSync(join(appDir, "_components/sidebar.tsx"), "utf8");
    expect(sidebar).not.toContain("ThemeToggle");
    expect(css()).not.toContain(".theme-toggle");
  });

  test("chart palette uses the fixed chart tokens", () => {
    const palette = readFileSync(join(appDir, "_components/charts/palette.ts"), "utf8");
    for (const n of [1, 2, 3, 4, 5, 6]) {
      expect(palette).toContain(`var(--chart-${n})`);
    }
    expect(palette).not.toContain("color-mix");
    const sections = readFileSync(join(appDir, "_modules/sections.tsx"), "utf8");
    expect(sections).not.toMatch(/"#[0-9a-fA-F]{6}"/);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`
Expected: FAIL — every test red (light tokens still present, Bricolage still imported, toggle still exists).

- [ ] **Step 4: Commit**

```bash
git add feature_list.json tests/features/console-dark-restyle.unit.test.ts
git commit -m "test: register console-dark-restyle with failing static contract"
```

---

### Task 3: Write the failing E2E test

**Files:**
- Create: `tests/e2e/console-dark-restyle.e2e.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import {
  getFreePort,
  signInFromFirstRun,
  startConsoleProcess,
  stopConsoleProcess,
  waitForConsole,
} from "../support/console-app";
import { withProcessLock } from "../support/process-lock";

function parseRgb(color: string): [number, number, number] {
  const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`Unexpected color format: ${color}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

test("console serves the dark violet Geist skin with compact controls and no overflow", async ({
  browser,
}) => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_console_dark_${randomUUID().replaceAll("-", "_")}`,
  });

  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });

    await withProcessLock("llmingress-console-next-dev", async () => {
      const consoleApp = startConsoleProcess({
        databaseUrl: fixture.databaseUrl,
        port: await getFreePort(),
      });

      try {
        const baseUrl = `http://localhost:${consoleApp.port}`;
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
          await waitForConsole(baseUrl, consoleApp);
          await page.goto(baseUrl);

          // Auth screens already wear the skin: violet primary button, 30px tall.
          const createAdmin = page.getByRole("button", { name: "Create admin" });
          await expect(createAdmin).toBeVisible();
          const [r, g, b] = parseRgb(
            await createAdmin.evaluate((el) => getComputedStyle(el).backgroundColor),
          );
          expect(b).toBeGreaterThan(150); // violet: blue dominates
          expect(b).toBeGreaterThan(g);
          expect(r).toBeGreaterThan(g);
          const box = await createAdmin.boundingBox();
          expect(box).not.toBeNull();
          expect(Math.round(box?.height ?? 0)).toBe(30);

          await signInFromFirstRun(page, baseUrl);
          await expect(
            page.getByRole("heading", { level: 1, name: "Overview", exact: true }),
          ).toBeVisible();

          // Dark-only document theme, no toggle anywhere.
          expect(
            await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
          ).toBe("dark");
          await expect(page.getByRole("button", { name: /theme/i })).toHaveCount(0);

          // Dark canvas: every channel of the body background is deep.
          const canvas = parseRgb(
            await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
          );
          for (const channel of canvas) {
            expect(channel).toBeLessThan(40);
          }

          // Geist is the rendered UI font.
          const fontFamily = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
          expect(fontFamily).toContain("Geist");

          // No horizontal overflow at desktop and mobile checkpoints.
          for (const viewport of [
            { width: 1280, height: 800 },
            { width: 390, height: 844 },
          ]) {
            await page.setViewportSize(viewport);
            const overflow = await page.evaluate(
              () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
            );
            expect(overflow).toBeLessThanOrEqual(0);
          }
        } finally {
          await context.close();
        }
      } finally {
        await stopConsoleProcess(consoleApp);
      }
    });
  } finally {
    await fixture.dispose();
  }
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts`
Expected: FAIL — primary button is blue (not violet) and 44px tall; default theme is light.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/console-dark-restyle.e2e.spec.ts
git commit -m "test: add failing dark-restyle E2E contract"
```

---

### Task 4: Move v1-console's E2E contract to dark-only

**Files:**
- Modify: `tests/e2e/v1-console.e2e.spec.ts`

- [ ] **Step 1: Replace the theme-toggle block**

In the main test, replace the block starting at the comment `// Theme toggle flips the document theme between light and dark.` through the `expect(["light", "dark"]).toContain(themeAfter);` line with:

```ts
          // The console is dark-only: no toggle exists and the theme never changes.
          await expect(page.getByRole("button", { name: /theme/i })).toHaveCount(0);
          expect(
            await page.evaluate(() => document.documentElement.getAttribute("data-theme")),
          ).toBe("dark");
```

Also update the test title from
`"sidebar groups modules and routes each nav item to its own page with a theme toggle"` to
`"sidebar groups modules and routes each nav item to its own page in the dark-only shell"`.

- [ ] **Step 2: Run to confirm it fails for the right reason**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres pnpm test:e2e tests/e2e/v1-console.e2e.spec.ts`
Expected: FAIL — the theme button still exists and `data-theme` resolves to `"light"` in Playwright's default (light) color scheme. Nav assertions still pass.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/v1-console.e2e.spec.ts
git commit -m "test: move v1-console E2E contract to dark-only shell"
```

---

### Task 5: Fonts and hardcoded dark theme in layout.tsx

**Files:**
- Modify: `apps/console/src/app/layout.tsx` (full replacement below)

- [ ] **Step 1: Replace the file**

```tsx
import "./globals.css";
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";

const sans = Geist({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-geist-sans",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-geist-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "LLMIngress Console",
  description: "LLMIngress management console",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
```

Notes: the pre-paint `themeBootstrap` script, `suppressHydrationWarning`, and the `<head>` block are intentionally gone — the theme is a constant attribute, so there is nothing to flash. The `--font-geist-*` variable names are new on purpose; the token layer (Task 6) maps `--font-body`/`--font-display`/`--font-mono` onto them so the 3600-line CSS file needs no font-stack edits.

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @llmingress/console run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/console/src/app/layout.tsx
git commit -m "feat(console): serve Geist fonts and hardcode dark theme"
```

---

### Task 6: Delete the theme toggle

**Files:**
- Delete: `apps/console/src/app/_components/theme-toggle.tsx`
- Modify: `apps/console/src/app/_components/sidebar.tsx`
- Modify: `apps/console/src/app/globals.css` (theme-toggle rules)

- [ ] **Step 1: Delete the component**

```bash
git rm apps/console/src/app/_components/theme-toggle.tsx
```

- [ ] **Step 2: Remove it from the sidebar**

In `sidebar.tsx`: delete the import `import { ThemeToggle } from "./theme-toggle";` and delete the `<ThemeToggle />` line inside `.sidebar-footer-row` (the Sign out form stays).

- [ ] **Step 3: Remove its CSS**

In `globals.css`:
- Around line 457, the shared rule `.sidebar-footer-row .theme-toggle, .sidebar-footer-row button { ... }` — remove only the `.sidebar-footer-row .theme-toggle,` selector line.
- Delete the whole `/* ---- Theme toggle ---- */` section (the `.theme-toggle`, `.theme-toggle:hover`, `.theme-toggle svg` rules, roughly lines 464–492).

- [ ] **Step 4: Typecheck and grep for stragglers**

Run: `pnpm --filter @llmingress/console run typecheck && grep -rn "theme-toggle\|ThemeToggle" apps/console/src || echo CLEAN`
Expected: typecheck PASS, then `CLEAN`.

- [ ] **Step 5: Commit**

```bash
git add -A apps/console/src/app
git commit -m "feat(console): remove theme toggle for dark-only shell"
```

---

### Task 7: Recast the token layer in globals.css

**Files:**
- Modify: `apps/console/src/app/globals.css` lines 1–156 (the header comment, `:root`, light block, and dark block)

- [ ] **Step 1: Replace lines 1–156 with the single dark token layer**

```css
/* ============================================================================
   LLMIngress Console — design system
   Dark-only control-plane skin: violet accent, glow depth, Geist type.
   Tokens in OKLCH; neutrals tinted toward the accent hue. Target hex values
   from the approved spec are noted per token.
   ========================================================================== */

:root {
  color-scheme: dark;

  /* Accent hue anchor (violet). Neutrals are tinted toward it for cohesion. */
  --hue: 288;

  /* Spacing — 4pt scale, semantic names */
  --space-2xs: 0.25rem;
  --space-xs: 0.5rem;
  --space-sm: 0.75rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2rem;
  --space-2xl: 3rem;
  --space-3xl: 4rem;

  /* Radii */
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-pill: 999px;

  /* Type scale — fixed rem for product UI, ~1.25 ratio */
  --text-2xs: 0.6875rem;
  --text-xs: 0.75rem;
  --text-sm: 0.8125rem;
  --text-base: 0.9375rem;
  --text-md: 1.0625rem;
  --text-lg: 1.3125rem;
  --text-xl: 1.6875rem;
  --text-2xl: 2.125rem;

  --leading-tight: 1.2;
  --leading-snug: 1.4;
  --leading-normal: 1.6;
  --leading-relaxed: 1.75;

  --font-body: var(--font-geist-sans), ui-sans-serif, system-ui, sans-serif;
  --font-display: var(--font-body);
  --font-mono: var(--font-geist-mono), ui-monospace, "SFMono-Regular", monospace;

  --sidebar-width: 15.625rem;
  --content-max: 76rem;

  --ease-out: cubic-bezier(0.22, 1, 0.36, 1);

  /* Surfaces */
  --canvas: oklch(0.16 0.008 var(--hue)); /* ~#0b0c0f */
  --surface: oklch(0.2 0.01 var(--hue)); /* ~#131418 */
  --surface-raised: oklch(0.225 0.011 var(--hue)); /* ~#17181d */
  --surface-sunken: oklch(0.145 0.007 var(--hue));
  --surface-inset: oklch(0.175 0.009 var(--hue)); /* ~#0f1014 */

  --border: oklch(0.27 0.015 var(--hue)); /* ~#232530 */
  --border-strong: oklch(0.33 0.02 var(--hue)); /* ~#2e3140 */
  --hairline: oklch(0.23 0.012 var(--hue)); /* ~#1c1d24 — row dividers, gridlines */

  /* Text — four steps */
  --text: oklch(0.93 0.005 var(--hue)); /* ~#e8e9ee */
  --text-muted: oklch(0.71 0.01 var(--hue)); /* ~#a0a3af */
  --text-subtle: oklch(0.59 0.012 var(--hue)); /* ~#7c7f8c */
  --text-faint: oklch(0.47 0.012 var(--hue)); /* ~#5c5f6b */

  /* Accent — violet */
  --accent: oklch(0.65 0.19 var(--hue)); /* ~#8b7cff */
  --accent-strong: oklch(0.7 0.17 var(--hue)); /* ~#9d90ff */
  --accent-fg: oklch(0.2 0.09 var(--hue)); /* ~#16113a, contrast > 7:1 on accent */
  --accent-soft: oklch(0.65 0.19 var(--hue) / 0.1);
  --accent-soft-border: oklch(0.65 0.19 var(--hue) / 0.35);
  --accent-text: oklch(0.73 0.15 var(--hue)); /* ~#a99dff — violet text on dark */

  /* Semantic */
  --ok: oklch(0.76 0.15 160); /* ~#3ecf8e */
  --ok-soft: oklch(0.76 0.15 160 / 0.09);
  --warn: oklch(0.78 0.15 70); /* ~#f5a623 */
  --warn-soft: oklch(0.78 0.15 70 / 0.09);
  --danger: oklch(0.68 0.19 25); /* ~#ff6b6b */
  --danger-soft: oklch(0.68 0.19 25 / 0.09);
  --danger-strong: oklch(0.74 0.15 20); /* ~#ff8a8a */
  --danger-fg: oklch(0.99 0.012 25);

  /* Depth — borders first; shadows only for overlays; glow for emphasis */
  --shadow-sm: none;
  --shadow-md: 0 10px 30px -14px oklch(0 0 0 / 0.5);
  --shadow-pop: 0 18px 48px -20px oklch(0 0 0 / 0.65);
  --glow-accent: 0 0 14px oklch(0.65 0.19 var(--hue) / 0.3);
  --glow-accent-strong: 0 0 18px oklch(0.65 0.19 var(--hue) / 0.45);
  --glow-ok: 0 0 6px oklch(0.76 0.15 160 / 0.8);
  --glow-warn: 0 0 6px oklch(0.78 0.15 70 / 0.8);
  --glow-danger: 0 0 6px oklch(0.68 0.19 25 / 0.8);

  /* Charts — fixed categorical order */
  --chart-1: var(--accent);
  --chart-2: oklch(0.65 0.16 262); /* blue ~#5b8def */
  --chart-3: var(--ok);
  --chart-4: var(--warn);
  --chart-5: oklch(0.72 0.18 350); /* pink ~#f472b6 */
  --chart-6: oklch(0.83 0.12 210); /* cyan ~#67e3f4 */
}
```

- [ ] **Step 2: Run the unit test — token assertions go green**

Run: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`
Expected: "single dark-only token layer" test PASSES; button/chart tests still FAIL (recipes not touched yet).

- [ ] **Step 3: Eyeball the app once**

Run: `pnpm --filter @llmingress/console exec next dev --port 3000` (needs `DATABASE_URL` and `MASTER_KEY=test-master-key` env; reuse the local dev database from `.env` / `init.sh` conventions), open http://localhost:3000 — everything should already be dark violet, with layout intact. Stop the server.

- [ ] **Step 4: Commit**

```bash
git add apps/console/src/app/globals.css
git commit -m "feat(console): recast design tokens to dark-only violet layer"
```

---

### Task 8: Compact buttons and inputs

**Files:**
- Modify: `apps/console/src/app/globals.css` — the `button, .btn` rules (old lines 823–898) and the `input, select, textarea` rules (old lines ~733–760; line numbers shift after Task 6/7)

- [ ] **Step 1: Replace the button family**

Find the `button, .btn { ... }` rule group (search `min-height: 2.75rem`). Replace from `button,` down through the `.secondary-button:active` rule with:

```css
button,
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-xs);
  min-height: 1.875rem;
  padding: 0 var(--space-sm);
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--accent-fg);
  background: var(--accent);
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background-color 0.15s var(--ease-out), border-color 0.15s var(--ease-out),
    box-shadow 0.15s var(--ease-out), transform 0.05s var(--ease-out);
}
button:hover,
.btn:hover {
  background: var(--accent-strong);
}
button:active,
.btn:active {
  transform: translateY(1px);
}
.btn {
  box-shadow: var(--glow-accent);
}
.btn:hover {
  box-shadow: var(--glow-accent-strong);
}
.btn:active {
  box-shadow: var(--glow-accent);
}
```

Keep the `.flat-icon` sizing rules that sit between the button rules unchanged. Then replace the `.secondary-button` rules with:

```css
.secondary-button {
  color: var(--text);
  background: transparent;
  border-color: var(--border-strong);
  box-shadow: none;
}
.secondary-button:hover {
  background: var(--surface-raised);
  border-color: var(--border-strong);
  box-shadow: none;
}
.secondary-button:active {
  transform: translateY(1px);
}
```

- [ ] **Step 2: Retune the input family**

Find the `input, select, textarea { ... }` rule (search `input,` near the Forms & controls section). Do not remove layout properties (`width`, `display`, etc.) that are already there; set these properties to these exact values (add any that are missing, replace existing ones):

```css
input,
select,
textarea {
  min-height: 2rem;
  font-size: var(--text-sm);
  color: var(--text);
  background: var(--surface-inset);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
}
input::placeholder,
textarea::placeholder {
  color: var(--text-faint);
}
input:focus,
select:focus,
textarea:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
```

- [ ] **Step 3: Unit test — button contract green**

Run: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts`
Expected: "compact buttons" test PASSES. Chart test still FAILS.

- [ ] **Step 4: Commit**

```bash
git add apps/console/src/app/globals.css
git commit -m "feat(console): compact button and input recipes"
```

---

### Task 9: Stat cards, nav chips, tables, glows

**Files:**
- Modify: `apps/console/src/app/_components/stat-card.tsx`
- Modify: `apps/console/src/app/globals.css` — `.stat-card*`, `.nav-item-icon`, `.nav-item.is-active`, `.data-table`, status-dot rules

- [ ] **Step 1: Stop rendering the KPI icon chip**

In `stat-card.tsx`, delete the `<span className="stat-card-icon" ...>{icon}</span>` element. Keep the `icon` prop in the type so the ~5 call sites don't change; prefix it with underscore to satisfy lint:

```tsx
export function StatCard({
  icon: _icon,
  label,
  value,
  delta,
  deltaTone,
}: {
```

- [ ] **Step 2: Rewrite the `.stat-card` rules**

Replace the whole `/* ---- KPI stat cards ---- */` rule block for `.stat-card`, `.stat-card-head`, `.stat-card-icon`, `.stat-card-label`, `.stat-card-value`, `.stat-card-delta` (keep `.stat-grid`/`.overview-stat-grid`/`.agents-stat-grid` as they are) with:

```css
.stat-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-2xs);
  min-width: 0;
  padding: 0.6875rem 0.8125rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.stat-card-head {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
}
.stat-card-label {
  font-size: var(--text-2xs);
  font-weight: 400;
  color: var(--text-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-card-value {
  font-family: var(--font-mono);
  font-feature-settings: "tnum" 1;
  font-variant-numeric: tabular-nums;
  font-size: var(--text-md);
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-card-delta {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  font-size: var(--text-2xs);
  color: var(--text-subtle);
}
.stat-card-delta.is-up {
  color: var(--ok);
}
.stat-card-delta.is-down {
  color: var(--danger);
}
```

(`.stat-card-icon` rules are deleted entirely.)

- [ ] **Step 3: Square nav chips + violet active indicator**

In the `/* ---- Sidebar: flat icon-chip list ---- */` section, find the `.nav-item-icon` rule and set these properties (keep others):
- `width: 1.5rem; height: 1.5rem;`
- `border-radius: var(--radius-sm);` (was pill)
- `font-family: var(--font-mono);`
- `background: var(--surface-raised); border: 1px solid var(--border); color: var(--text-subtle);`

Find the `.nav-item.is-active` rule and add/replace:
- `background: var(--accent-soft);`
- `box-shadow: inset 2px 0 0 var(--accent);`
- `color: var(--text);`

And on `.nav-item.is-active .nav-item-icon` (add the rule if missing):

```css
.nav-item.is-active .nav-item-icon {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  color: var(--accent-text);
}
```

- [ ] **Step 4: Table scanning surface**

In the `/* ---- Data tables ---- */` section, adjust the header and row rules (property-level edits, keep everything else):
- `.data-table th` (or `.data-table thead th`, whichever exists): `font-size: var(--text-2xs); font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-faint);`
- Row divider borders inside `.data-table` change `var(--border)` to `var(--hairline)`.
- Row hover rule (search `:hover` within the section): `background: var(--surface-raised);`
- Selected row (`.data-table tbody tr.is-selected`, ~line 2014): set `background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent);` — same selection language as the sidebar's active nav item.

- [ ] **Step 5: Glowing status dots**

Append at the end of the `/* ---- Status pills ---- */` section:

```css
/* Health dots glow in the dark shell. */
.topbar-status-dot,
.sidebar-account-dot {
  box-shadow: var(--glow-ok);
}
.topbar-status.is-warn .topbar-status-dot,
.sidebar-account-dot.is-warn {
  box-shadow: var(--glow-warn);
}
```

Then two property-level edits elsewhere:
- `.sidebar-mark` (~line 343): add `box-shadow: var(--glow-accent);`
- `.usage-bar-fill` (~line 2361): change `background: var(--accent);` to `background: linear-gradient(90deg, oklch(0.55 0.19 var(--hue)), var(--accent));`; in `.usage-bar-fill.is-warn` change to `background: linear-gradient(90deg, oklch(0.68 0.15 70), var(--warn));`; in `.usage-bar-fill.is-danger` change to `background: linear-gradient(90deg, oklch(0.58 0.19 25), var(--danger));`

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm --filter @llmingress/console run typecheck`
Expected: PASS

```bash
git add apps/console/src/app
git commit -m "feat(console): dark recipes for stat cards, nav chips, tables, status dots"
```

---

### Task 10: Chart theming

**Files:**
- Modify: `apps/console/src/app/_components/charts/palette.ts`
- Modify: `apps/console/src/app/_components/charts/trend-line-chart.tsx`
- Modify: `apps/console/src/app/_modules/sections.tsx:98-100`

- [ ] **Step 1: Point the palette at the fixed chart tokens**

Replace the body of `palette.ts`:

```ts
// Chart colors expressed as design-system CSS variables so charts track the
// console skin. recharts accepts any CSS color string, including var(--token).
export const chartAccent = "var(--chart-1)";
export const chartOk = "var(--ok)";
export const chartWarn = "var(--warn)";
export const chartDanger = "var(--danger)";

// Ordered categorical palette for breakdown donuts (cycled when exhausted).
export const chartCategorical = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
];

export function categoricalColor(index: number): string {
  return chartCategorical[index % chartCategorical.length] ?? chartAccent;
}
```

- [ ] **Step 2: Retune the trend chart chrome**

In `trend-line-chart.tsx`:
- `CartesianGrid`: `stroke="var(--hairline)"` (was `var(--border)`), keep `strokeDasharray="3 3"`.
- `XAxis` `axisLine`: `{ stroke: "var(--hairline)" }`.
- `Tooltip` `contentStyle`: `background: "var(--surface-raised)"`, `border: "1px solid var(--border-strong)"` (radius/fontSize/color stay).

- [ ] **Step 3: De-hardcode the usage trend series colors**

In `_modules/sections.tsx` lines 98–100, replace:

```ts
const usageTrendActualColor = "var(--chart-3)";
const usageTrendBaselineColor = "var(--chart-2)";
const usageTrendTokenColor = "var(--chart-4)";
```

(green→chart-3, blue→chart-2, amber→chart-4 — same semantics, token-driven.)

- [ ] **Step 4: Unit test fully green + typecheck**

Run: `pnpm exec vitest run tests/features/console-dark-restyle.unit.test.ts && pnpm --filter @llmingress/console run typecheck`
Expected: unit test PASS (all 5), typecheck PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/app/_components/charts apps/console/src/app/_modules/sections.tsx
git commit -m "feat(console): token-driven chart palette and chrome"
```

---

### Task 11: Uppercase / shadow / leftover sweep

The long-tail page sections (playground, usage, limits, activity, auth) are token-driven and have already flipped dark. This task removes styling that contradicts the spec's rules.

**Files:**
- Modify: `apps/console/src/app/globals.css`

- [ ] **Step 1: Uppercase sweep**

Run: `grep -n "text-transform: uppercase" apps/console/src/app/globals.css`

For every hit EXCEPT the `.data-table` header rule (Task 9): delete the `text-transform: uppercase;` line and any accompanying `letter-spacing: 0.0Xem;` line in the same rule, and if the rule's `color` is `var(--text-faint)` change it to `var(--text-subtle)` (regular-case labels read one step stronger).

- [ ] **Step 2: Letter-spacing sweep**

Run: `grep -n "letter-spacing" apps/console/src/app/globals.css`
Allowed survivors: the `.data-table` header rule and any `letter-spacing: -0.01em` display-heading rules (negative tracking on large text is fine). Delete wide positive tracking (`0.04em`+) everywhere else.

- [ ] **Step 3: Hardcoded-color sweep**

Run: `grep -n "oklch(" apps/console/src/app/globals.css | grep -v "^\s*--" | grep -v "var(--hue)" | grep -v "0 0 0"`
Any rule using a literal oklch color outside the token block gets rewritten to the nearest token (`var(--accent…)`, `var(--ok…)`, etc.). Pure-black shadow literals are fine.

- [ ] **Step 4: Full-app eyeball at both widths**

Start the dev server as in Task 7 Step 3. Visit every module (Overview, Agents, Providers, Virtual Models, Activity, Usage & Cost, Limits, Playground, Gateway Runtime, Settings) at 1280px and 390px. Check: no light-colored patches, no unreadable text, no horizontal scrollbar, dialogs/forms styled. Fix anything found by the token/recipe rules above — do not add page-specific hacks.

- [ ] **Step 5: Commit**

```bash
git add apps/console/src/app/globals.css
git commit -m "feat(console): sweep uppercase, tracking, and hardcoded colors"
```

---

### Task 12: Green the E2E suites and close out the feature

**Files:**
- Modify: `feature_list.json`, `progress.md`

- [ ] **Step 1: Run both console E2E specs**

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres pnpm test:e2e tests/e2e/console-dark-restyle.e2e.spec.ts tests/e2e/v1-console.e2e.spec.ts --workers=1`
Expected: PASS (2 tests). If the overflow assertion fails at 390px, find the offending element with `page.evaluate` + `document.querySelectorAll` width scan and fix via the responsive section (`@media (max-width: 56rem)`) — never by hiding content.

- [ ] **Step 2: Full verification ladder**

Run: `pnpm run verify`
Expected: lint, typecheck, test, build all PASS.

Run: `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres pnpm run verify:features`
Expected: every passing feature re-verifies green (v1-console included).

- [ ] **Step 3: Mark the feature passing**

In `feature_list.json`, set `console-dark-restyle` `status` to `"passing"` and `evidence` to (adjust date/results to reality):

```
2026-07-03: Unit + E2E green (dark canvas, Geist, violet 30px buttons, no toggle, no overflow at 1280/390). pnpm run verify and verify:features green after restyle.
```

- [ ] **Step 4: Update progress.md**

Add a dated entry: dark restyle implemented per spec; v1-console E2E contract moved to dark-only; light theme + toggle removed; verification results.

- [ ] **Step 5: Final commit**

```bash
git add feature_list.json progress.md
git commit -m "feat(console): dark restyle passing with full regression"
```

---

## Self-Review Notes

- Spec coverage: tokens→Task 7, buttons/forms→Task 8, stat cards/nav/tables/dots→Task 9, charts→Task 10, sweep + long-tail sections→Task 11, theme removal→Tasks 5–6, contract migration→Tasks 2–4 & 12. Master-detail active-state and pill recipes are token-driven (accent-soft/hairline) and covered by Tasks 7 + 11's sweep.
- Type consistency: harness helper names (`startConsoleProcess` etc.) match between Tasks 1, 3; `--font-geist-*` names match between Tasks 5 and 7; `--chart-N`/`--hairline`/`--glow-*` defined in Task 7 before use in Tasks 9–10.
- The unit test's `expect(css()).not.toMatch(/\[data-theme=/)` requires Task 6 Step 3 (toggle CSS deletion) *and* Task 7 (token collapse); both precede the final green check in Task 10 Step 4.
