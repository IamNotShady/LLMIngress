# Console UI Quality Polish — Implementation Design (feat-121)

Date: 2026-06-28
Branch: `console-ui-polish` worktree off `dev` HEAD

## Goal

Raise the **perceived quality / 质感** of the LLMIngress console — buttons, popups,
colors, borders, hover, shadows — **without changing page layout or functionality**.
Follow-on to the 2026-06-23 console-ui-refresh; works within the existing OKLCH token
system in `apps/console/src/app/globals.css`.

### Decisions (confirmed with user)

| Question | Decision |
|---|---|
| Polish depth | **Polish + more character** — overlay motion, card depth/hover, refined buttons/elevation, token cleanup |
| Modal scrim | **Subtle backdrop blur** (purposeful focus, consistent with the topbar's existing blur) |
| Hover lift | **Only on truly-clickable choice cards** (`.option-card`); lists/table rows use border/shadow/background, no transform |
| Chart colors in `sections.tsx` | **Out of scope** (would break the CSS-only constraint; not required by any test) |

## Hard Constraints (apply to every change)

- **UI implementation is CSS-only** — visual changes confined to
  `apps/console/src/app/globals.css` (plus the new test files). Tracker/progress updates
  (`feature_list.json`, `progress.md`) are required and expected, not a violation of this.
- **No DOM-structure or class-name changes**, no element moves → every Playwright e2e
  selector and interaction stays intact.
- **No layout geometry changes**: do not touch `padding`, `margin`, `gap`, grid,
  `width`, or `min-height`. The only transform used is `translateY(-1px)` hover lift, and
  **only on `.option-card`**.
- **Tokens only** — no new hardcoded colors (charter principle 5).
- **No AI-slop tells** (`.impeccable.md`): no border accent stripes, no gradient text, no
  decorative glass. The scrim blur is the lone backdrop, purposeful focus only.
- **Invariant preserved**: no horizontal overflow at **1280px** and **390px** on any page.
- Green gates: `pnpm run verify` and `pnpm run verify:features` must pass.

## Background (current state)

- Single stylesheet `apps/console/src/app/globals.css` (~4030 lines); markup is
  className-only. Tokens (OKLCH, light/dark/no-JS-fallback) at lines ~7-148.
- `prefers-reduced-motion` is already globally neutralized (~1476-1483), so added motion
  is auto-suppressed for those users — no per-rule guards needed.
- Gaps: overlays have **no entrance motion**; cards are **flat** (`--shadow-md` defined
  but **never used**); hardcoded hex bypasses tokens and breaks dark mode;
  `--leading-relaxed` is **referenced but never defined**.

---

## Workstream A — Register feature + write failing tests FIRST (TDD red)

Per AGENTS.md: register the feature, write the unit + E2E tests, and **observe them fail
before any CSS changes**.

1. **Add `feat-121` to `feature_list.json`** (registered as `status: "pending"`):
   - **id**: `feat-121`
   - **name**: `Console UI Quality Polish`
   - **description**: "Console visual polish, markup- and layout-stable. Overlays
     (dialog, scrim, virtual-model multi-select panel, date popover) animate in via CSS
     keyframes; the modal scrim uses a backdrop blur. Cards carry a resting elevation and
     clickable strategy/option cards lift on hover; primary and secondary buttons have
     refined shadow and press feedback. All danger controls, the agent code snippet, and
     limits KPI icons use OKLCH theme tokens (no hardcoded hex) so they render correctly
     in both light and dark themes; `--leading-relaxed` is defined. No markup, class
     names, layout geometry, or interactions change, and there is no horizontal overflow
     at 1280px or 390px."
   - **verification**: `pnpm exec vitest run tests/features/feat-121-console-ui-polish.unit.test.ts && pnpm test:e2e tests/e2e/feat-121-console-ui-polish.e2e.spec.ts --grep 'console UI polish themes overlays and preserves layout'`
   - **dependencies**: `["feat-013", "feat-061", "feat-098"]` (auth sign-in, layout invariant, sidebar nav)
   - **status**: `"pending"`; **evidence**: `""`. (Lifecycle: register as `pending`;
     after the tests are written and observed RED, flip to `"failing"` and record the
     RED evidence; after the implementation passes focused verification, flip to
     `"passing"` with full evidence. `verify:features` only regresses `passing` features,
     so `pending`/`failing` are safely skipped during regression.)

2. **Unit test** — `tests/features/feat-121-console-ui-polish.unit.test.ts` (reads
   `globals.css` as text; asserts CSS-level invariants). RED before changes:
   - `--leading-relaxed`, `--danger-strong`, `--danger-fg` are each defined.
   - `@keyframes dialog-in`, `@keyframes scrim-in`, `@keyframes popover-in` all exist.
   - `.console-dialog-scrim` block contains `backdrop-filter`.
   - `var(--shadow-md)` is now referenced at least once (was never used).
   - The previously-hardcoded hex strings no longer appear anywhere in `globals.css`
     (all verified present pre-change): `#dc2626`, `#b91c1c`, `#fff` (4× `color: #fff` on
     danger controls → `var(--danger-fg)`), `#0b1020`, `#dbe7ff`, `#f59e0b`, `#16a34a`,
     `#ef4444`, `#7c3aed`, `#fee2e2`, `#dcfce7`, `#fef3c7`, `#ede9fe`, `#fecaca`,
     `#fca5a5` — assert the danger/limits hex set is gone. (Do
     **not** assert `#2563eb`: it lives only in `_modules/sections.tsx`, which is out of
     scope, so it would never contribute RED.)

3. **E2E test** — `tests/e2e/feat-121-console-ui-polish.e2e.spec.ts`. Use the shared
   harness `withConsoleDevServer(browser, async ({ page, baseUrl }) => { ... })` from
   `tests/support/console-dev-server.ts` (it owns the Postgres fixture, migrations,
   process lock, `next dev` boot, and `signInFromFirstRun`); import `openDisclosure` from
   `tests/support/console-ui.ts` when a disclosure must be opened. Set viewport per
   assertion via `page.setViewportSize(...)`. Single test titled
   **"console UI polish themes overlays and preserves layout"**, asserting rendered
   behavior at description altitude. RED before changes:
   - **Overlay motion (real render):** on `/providers`, open the "Add Provider" dialog;
     `getComputedStyle(dialog).animationName === "dialog-in"` (not `none`); the
     `.console-dialog-scrim` computed `backdrop-filter` contains `blur`.
   - **Token-driven theming (the dark-mode fix):** `withConsoleDevServer` starts from a
     **fresh** Postgres, so seed the target first via the `seed` option — **copy the
     minimal seed SQL** into feat-121's own local seed function, modeled on
     `seedAgentsData` in `tests/e2e/console-ui-agents.e2e.spec.ts` or `seedReferenceLimits`
     in `tests/e2e/console-ui-limits.e2e.spec.ts` (these are local helpers inside their
     spec files, **not** shared exports — do not import them) — to insert an agent
     (and/or a limit rule). Navigate to that row, open the delete confirmation, and
     read the danger button's computed `background-color` (`.agent-delete-confirm` or
     `.limits-rule-delete-button`) in **light** theme; switch to **dark**
     (`localStorage['llmingress-theme'] = 'dark'` + reload, or click `theme-toggle`),
     re-open, and re-read. Assert the two differ — a hardcoded `#dc2626` is identical in
     both themes; a token-driven color must change.
   - **No layout regression (the invariant):** at viewport **1280×720** and again at
     **390×844**, on Overview + Providers + Activity + Limits, assert
     `document.documentElement.scrollWidth <= <viewportWidth>`.
   - **Hover causes no reflow:** `.option-card` only renders in the VM route dialog
     (`virtual-model-route-dialog.tsx`, the strategy choices), so navigate to
     `/models?virtualModelDialog=new` (or click the "Create Virtual Model" link on
     `/models`) and wait for the "Create Virtual Model" dialog. The `.option-cards`
     container holds several `.option-card` siblings — capture the **next sibling's**
     `getBoundingClientRect()`, hover the first card, and assert that sibling's box is
     unchanged (the hovered card's `translateY(-1px)` transform must not push neighbors).

Run the focused verification command and confirm both specs FAIL for the right reasons
before touching `globals.css`.

---

## Workstream B — New tokens

In the token block (`globals.css` ~7-148). `--leading-relaxed` in `:root`; danger tokens
in all three blocks (`:root,[data-theme="light"]`, `[data-theme="dark"]`, and the
`@media (prefers-color-scheme: dark) :root:not([data-theme])` fallback).

```css
/* :root, with the --leading-* tokens (~line 41) */
--leading-relaxed: 1.75;

/* Light block (~after line 81) */
--danger-strong: oklch(0.46 0.20 25);
--danger-fg: oklch(0.99 0.012 25);

/* Dark block + no-JS fallback (~after lines 115 / 146) */
--danger-strong: oklch(0.76 0.16 25);
--danger-fg: oklch(0.99 0.012 25);
```

Reuse the existing unused `--shadow-md` for hover elevation — no new shadow token.

---

## Workstream C — Overlay entrance motion

Add keyframes near `@keyframes page-enter` (~line 275) and apply to existing overlays.

```css
@keyframes dialog-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
  to   { opacity: 1; transform: translateX(-50%); }
}
@keyframes scrim-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes popover-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.985); }
  to   { opacity: 1; transform: none; }
}
```

Apply:
- `.console-dialog` (~1354) — `animation: dialog-in 0.16s var(--ease-out) both;`. The
  keyframe **must** keep `translateX(-50%)` in both frames or the dialog jumps off-center.
- `.console-dialog-scrim` (~1373) — `animation: scrim-in 0.16s var(--ease-out) both;`,
  plus `backdrop-filter: blur(3px) saturate(1.05);` and a slightly deeper dim — raise the
  canvas mix from the current 72% to `background: color-mix(in srgb, var(--canvas) 78%, transparent);`
  (higher canvas % = stronger veil; the blur does the rest of the focus work).
- `.agent-vm-multi-select-panel` (~888-987) and `.date-picker-popover` (~3048) — add
  `transform-origin: top;` and `animation: popover-in 0.14s var(--ease-out) both;`.

---

## Workstream D — Card depth + restrained hover

Resting shadow (add `box-shadow: var(--shadow-sm);`): `.card` siblings (~607-618),
`.stat-card` (~1651-1660), `.chart-card` (~2462-2470), `.detail-panel` (~2075-2085).
These are resting-only — **no hover** (not clickable).

Hover lift — **only** the clickable choice card:
```css
.option-card { /* ~2683-2702 — currently no hover */
  transition: border-color 0.15s var(--ease-out), box-shadow 0.15s var(--ease-out),
    transform 0.15s var(--ease-out);
}
.option-card:hover {
  border-color: var(--accent-soft-border);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}
```

Lists/rows get depth **without** transform (avoids jitter while scanning):
```css
.activity-list-item { /* extend transition ~1117 with box-shadow (no transform) */ }
.activity-list-item:hover {
  border-color: var(--accent-soft-border);
  box-shadow: var(--shadow-sm);
}
```
Clickable table rows keep their existing background hover — unchanged.

---

## Workstream E — Button refinement

```css
button, .btn { /* ~990-1016 */
  transition: background-color 0.15s var(--ease-out), border-color 0.15s var(--ease-out),
    box-shadow 0.15s var(--ease-out), transform 0.05s var(--ease-out);
  box-shadow: 0 1px 2px -1px color-mix(in oklch, var(--accent) 45%, transparent);
}
button:hover, .btn:hover {
  background: var(--accent-strong);
  box-shadow: 0 2px 6px -2px color-mix(in oklch, var(--accent) 55%, transparent);
}
button:active, .btn:active {
  transform: translateY(1px);
  box-shadow: 0 1px 2px -1px color-mix(in oklch, var(--accent) 40%, transparent);
}
/* Secondary/ghost are NOT primary — drop the inherited accent shadow at rest */
.secondary-button, .btn-ghost { box-shadow: none; }
.secondary-button:hover, .btn-ghost:hover { /* ~1042-1052 */
  background: var(--surface-inset); border-color: var(--border-strong);
  box-shadow: var(--shadow-sm);
}
.secondary-button:active, .btn-ghost:active { transform: translateY(1px); }
```

**Important — the base `button, .btn` rule matches every `<button>`, so the new accent
shadow leaks onto secondary AND danger controls.** Reset it on non-primary controls so a
red danger button never carries a blue accent glow: secondary/ghost use the neutral reset
above; **danger** controls get a `var(--danger)`-tinted shadow in Workstream F. Keep the
CTA override (~4022-4030) as the strongest accent shadow (it wins by source order); verify
it layers cleanly.

---

## Workstream F — Token cleanup (hex → tokens; fixes dark mode)

Swap hex **values inside the existing rules**; keep selectors and `!important` so
specificity is unchanged.

| Rule (approx line) | Change |
|---|---|
| `.agent-delete-confirm` / `:hover` (~2450-2459) | `#fff`→`var(--danger-fg)`, `#dc2626`→`var(--danger)`, `#b91c1c`→`var(--danger-strong)` |
| `.agent-table-actions .agent-action-delete` (~2320-2328) | same red/hover mapping |
| `.vm-candidate-remove` (~3795-3813) | red→`var(--danger)`/`var(--danger-strong)`, fg→`var(--danger-fg)` |
| `.limits-rule-delete-button` (~3325-3341) | text→`var(--danger)`, bg→`var(--danger-soft)`, border→`var(--danger)` |
| `.agent-snippet` (~1875-1883) | `#0b1020`→`var(--surface-sunken)`, `#dbe7ff`→`var(--text)`; add `line-height: var(--leading-relaxed)` |
| `.limits-kpi-grid .stat-card-icon:nth-child(n)` (~3215-3228) | green→`--ok`/`--ok-soft`, red→`--danger`/`--danger-soft`, amber→`--warn`/`--warn-soft`, violet→`--accent`/`--accent-soft` |
| `.limits-usage-block` amber (~3413-3419) | `#f59e0b`→`var(--warn)` |

Each danger control above also **overrides the inherited base accent shadow** (see
Workstream E) with a danger-tinted one so it reads elevated, not blue:
`box-shadow: 0 1px 2px -1px color-mix(in oklch, var(--danger) 45%, transparent)`, hover
`0 2px 6px -2px color-mix(in oklch, var(--danger) 55%, transparent)`.

Also unify the overlay border: set the date popover (`.date-picker-popover`, ~3048,
currently `--border`) to `var(--border-strong)` so it matches the multi-select dropdown
panel — both overlays use `var(--border-strong)`.

---

## Verification (executable)

**Order:** TDD red (Workstream A) → implement B-F → focused verification → full
regression → manual screenshot supplement.

1. **Focused (the feat-121 `verification` command):**
   `pnpm exec vitest run tests/features/feat-121-console-ui-polish.unit.test.ts && pnpm test:e2e tests/e2e/feat-121-console-ui-polish.e2e.spec.ts --grep 'console UI polish themes overlays and preserves layout'`
   — must go from RED (pre-change) to GREEN (post-change).
2. **Full health gate:** `pnpm run verify` (lint (Biome) → typecheck → test → build).
3. **Full feature regression:** `pnpm run verify:features` (markup unchanged → all
   prior selectors hold). On green, set feat-121 `status: "passing"` and record evidence
   (incl. the observed RED reasons).
4. **Browser/IAB or Playwright screenshot pass (required for UI work — `verify` alone is
   not enough):** boot the console and capture Overview + Providers + Activity + Limits in
   **light and dark** at both **1280px and 390px**, plus the open
   provider/agent-delete/route dialogs and the date picker. Explicitly check: **no
   browser Console errors**, motion/scrim blur render, hover states, dark-mode danger
   colors, and no horizontal overflow at either width. Screenshots are throwaway.

### Definition of Done
- [ ] feat-121 registered; unit + E2E written and observed RED before CSS changes
- [ ] Focused verification GREEN
- [ ] `pnpm run verify` GREEN; `pnpm run verify:features` GREEN
- [ ] `grep -nE '#[0-9a-fA-F]{3,6}'` over the danger/limits/snippet rules in `globals.css`
      is clean
- [ ] No horizontal overflow at 1280px and 390px (asserted by E2E)
- [ ] feat-121 marked `passing` with evidence; `progress.md` updated; repo restartable

## Out of Scope
- Chart series colors in `_modules/sections.tsx` (would break CSS-only; no test needs it).
- Any functional, routing, data, or interaction change.
- Layout/geometry changes, markup/class edits, new pages/components.
- Backend / gateway / worker code.

## Risks & Mitigations
- **`!important` danger rules** → swap only hex *values*; selectors/`!important` unchanged.
- **Dialog centering jump** → `dialog-in` keeps `translateX(-50%)` in both frames.
- **CSS feature is hard to TDD** → assert real rendered `animationName`,
  `backdrop-filter`, cross-theme `background-color` deltas, and the overflow invariant via
  Playwright `getComputedStyle`/`getBoundingClientRect` — not just source-text greps.
- **"More character" scope creep** → token-level, markup-stable; hover lift only on
  `.option-card`; lists/rows depth-only.
