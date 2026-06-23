# Console UI Refresh + English Translation — Design

Date: 2026-06-23
Branch / worktree: `console-ui-refresh` (based on `dev` HEAD)

## Goal

Polish the LLMIngress **console** front-end and bring it fully to English, without
changing any behavior or interaction. Three outcomes:

1. A meaningful **visual refresh** of the console (style-level only).
2. Replace the multicolor `flat-color-icons` with **clean monochrome line icons**,
   fixing semantically-wrong icon choices along the way.
3. **Translate all remaining Chinese to English** in the console code, the tests
   that assert those strings, and small repo artifacts. (Big design docs deferred.)

## Hard Constraints (apply to every change)

- **No behavior or interaction changes.** Edits are limited to CSS, the icon
  component's *rendering*, and string *values*.
- **No DOM-structure or class-name changes**, no element moves. This keeps every
  Playwright e2e selector and every interaction intact.
- Translation changes string contents only — never structure or logic.
- Green gates: `pnpm run verify` and `pnpm run verify:features` must pass.

## Scope Decisions (confirmed with user)

| Question | Decision |
|---|---|
| Icon strategy | Monochrome line icons (Lucide-style, inline SVG, `currentColor`) |
| Refresh depth | Fuller visual refresh (cards, palette, density, type scale) — CSS only |
| Translation scope | Console code + affected tests + `feature_list.json` + `progress.md` |
| Big docs (`PRODUCT.md`, `ARCHITECTURE.md`, `PLAN.md`) | **Deferred** — not this PR |
| Dead `flat-color-icons` dep + `public/flat-color-icons/*` assets | **Remove** |

## Workstream A — Worktree (done)

Isolated worktree at `.claude/worktrees/console-ui-refresh` off `dev` HEAD.
Baseline verified clean (typecheck + lint). All work happens here.

## Workstream B — Icons → monochrome line icons

All ~60 icon usages funnel through one component:
`apps/console/src/app/_components/flat-icon.tsx` (`<FlatIcon name="..." />`).

**Approach:** keep the exact public API (`FlatIcon` component, `FlatIconName`
union, same names) and swap only the implementation — from `<Image>` pointing at
`/flat-color-icons/*.svg` to **inline `<svg>`** line glyphs (stroke 1.5,
`currentColor`, 24-box, `width/height` 1em-ish). Result: 60 call sites and all
tests untouched; icons become monochrome and inherit each button's text color.

**Name → glyph mapping** (Lucide-style):

| name | glyph intent |
|---|---|
| add | plus |
| cancel | x |
| confirm | check |
| delete | trash |
| disable | ban / slash-circle |
| edit | pencil |
| enable | check-circle |
| export | arrow out / down-to-disk |
| filter | funnel (currently a magnifier — wrong) |
| import | arrow in / up-from-disk |
| key | key |
| lock | lock (closed) |
| refresh | rotate-cw |
| save | floppy disk (currently a checkmark — wrong) |
| settings | gear / sliders |
| unlock | lock (open) |
| view | eye |

**CSS cleanup tied to this:**
- Simplify the `:where(button,a):has(.flat-icon)` override block in `globals.css`
  — keep icon-only buttons icon-only (sr-only label preserved), but let icons use
  `currentColor` instead of forcing transparent/`!important` chrome where possible.
- Remove leftover text-glyph styling now that real icons render inside them:
  `.provider-refresh-button`, `.provider-key-add-button`,
  `.provider-key-delete-button`, `.provider-action-button` (font-size/weight 800),
  and the `.vm-drag-handle` "`::`" grip.

**Dead-code removal:** drop `flat-color-icons` from
`apps/console/package.json` and delete `apps/console/public/flat-color-icons/*`
once nothing references them.

## Workstream C — Visual refresh (CSS only)

Work entirely within the existing OKLCH design system in
`apps/console/src/app/globals.css` (light + dark), refreshing:

- Color/accent palette, surfaces, elevation/shadows.
- Card treatment (radius, border, shadow, hover) — `.panel`, `.card`,
  `.stat-card`, `.chart-card`, detail cards.
- Data tables — header, row hover, selection.
- Pills/badges contrast; button hierarchy (primary / secondary / ghost / danger);
  focus rings.
- Sidebar nav + topbar polish; density and type scale.

**Markup-stable:** no class renames or structural edits, so e2e selectors and
interactions are unaffected. (`tests/support/console-ui.ts` selectors rely on
classes like `summary.row-summary`, `table.providers-table` — these stay.)

## Workstream D — Translation → English

Three lockstep groups (UI strings and their test assertions change together):

1. **Console code** (strings + comments):
   - `apps/console/src/app/_modules/sections.tsx` (~82 lines)
   - `apps/console/src/app/_modules/virtual-model-route-dialog.tsx` (~35)
   - `apps/console/src/server/provider-keys.ts` (~6, status labels)
   - `apps/console/src/app/(dashboard)/providers/page.tsx` (~2)
   - `apps/console/src/app/(dashboard)/models/page.tsx` (~2)
   - plus any others surfaced by `grep -rn '[一-龥]' apps/console/src`.
2. **Tests asserting Chinese** (update to the new English strings):
   - `tests/support/console-ui.ts` (e.g. "添加 Provider", "创建 Virtual Model")
   - e2e: `console-ui-providers`, `console-ui-virtual-models`, `console-ui-models`,
     `feat-016`, `feat-028`, `feat-029`, `feat-030`, `feat-015`, `feat-057`,
     `feat-076`, `feat-080`, `feat-064`, `feat-063`, `feat-056`, `feat-050`
   - unit: `feat-102-provider-key-operational-metadata.unit.test.ts`
3. **Small artifacts:** `feature_list.json`, `progress.md`.

**Deferred (not this PR):** `docs/PRODUCT.md`, `docs/ARCHITECTURE.md`,
`docs/PLAN.md` (~1,100 lines, orthogonal to the UI).

**Done check:** `grep -rn '[一-龥]'` over the in-scope paths returns nothing.

## Workstream E — Visual verification (Playwright)

Postgres is up on `127.0.0.1:55432` and `@playwright/test` is installed.

- Boot the console against local Postgres and capture **before/after** screenshots
  of all pages — Overview, Agents, Providers, Models, Virtual Models, Activity,
  Usage, Limits, Playground, Runtime, Settings — in **light + dark**.
- Iterate on the CSS using the screenshots until the refresh looks right.
- Capture key dialogs (provider create/edit, route policy editor) too.
- Screenshots are throwaway verification artifacts (not committed).

## Verification / Definition of Done

- [ ] `pnpm run verify` green (lint → typecheck → test → build)
- [ ] `pnpm run verify:features` green (no regression)
- [ ] No Chinese remains in in-scope paths (`grep` clean)
- [ ] Before/after screenshots reviewed (all pages, light + dark)
- [ ] `flat-color-icons` dep + assets removed; no dangling references
- [ ] `progress.md` updated; worktree restartable via standard path

## Out of Scope

- Any functional, routing, data, or interaction change.
- New pages, components, or features.
- Translating the large design docs (deferred).
- Backend/gateway/worker code unrelated to console strings.

## Risks & Mitigations

- **e2e assertions on Chinese strings** → update tests in lockstep; rely on
  `verify:features` to catch misses.
- **`:has(.flat-icon)` `!important` overrides are intricate** → refine
  incrementally with screenshot checks; preserve icon-only vs labeled button
  behavior exactly.
- **"Fuller refresh" scope creep** → stay CSS/token-level, markup-stable.
