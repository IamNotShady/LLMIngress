# Console Dark Restyle — Design Spec

Date: 2026-07-03
Status: approved in brainstorm session (direction, tokens, components, scope all user-confirmed)

## Goal

Replace the Console's visual skin with a dark-only, violet-accented, Geist-typeset design ("dark tech" direction: Supabase / Railway / Vercel-dark lineage). The functional page layout — navigation structure, page composition, DOM hierarchy — stays exactly as it is today.

## Non-goals

- No layout, navigation, or page-structure changes.
- No component-library or Tailwind migration; the existing `globals.css` semantic-class architecture stays.
- No changes to Gateway, Worker, or `packages/`.

## Approved decisions

| Decision | Choice |
|---|---|
| Visual direction | Dark tech (glowing accents, mono identifiers, terminal feel) |
| Theme strategy | **Dark only** — light theme and theme toggle removed |
| Accent | Violet `#8b7cff` |
| Typography | Geist (UI) + Geist Mono (numbers, IDs, timestamps, code) |
| Density | Compact controls (30px buttons, tightened paddings) |
| Execution | Token recast + component-recipe rewrite inside existing CSS architecture |

## Design tokens

Implementation stays in OKLCH CSS variables (same mechanism as today); hex values below are the target appearance. The light token block and `[data-theme="dark"]` block collapse into a single `:root` definition.

### Surfaces & borders

| Token | Value | Use |
|---|---|---|
| canvas | `#0b0c0f` | page background |
| surface | `#131418` | cards, panels |
| surface-raised | `#17181d` | hover rows, tooltips, nested chrome |
| surface-inset | `#0f1014` | inputs, code/key blocks |
| border | `#232530` | default 1px card/table borders |
| border-strong | `#2e3140` | secondary buttons, inputs |
| hairline | `#1c1d24` | row dividers, chart gridlines, shell borders |

### Text

`#e8e9ee` (primary) → `#a0a3af` (muted) → `#7c7f8c` (subtle) → `#5c5f6b` (faint). Four steps, mapped onto the existing `--text*` variable names.

### Accent (violet)

| Token | Value |
|---|---|
| accent | `#8b7cff` |
| accent-strong (hover) | `#9d90ff` |
| accent-fg (text on accent) | `#16113a` (contrast > 7:1) |
| accent-soft | `rgba(139,124,255,.10)` |
| accent-text (violet text on dark) | `#a99dff` |

### Semantic

ok `#3ecf8e` · warn `#f5a623` · danger `#ff6b6b` (text-on-dark variant `#ff8a8a`), each with a ~9%-opacity soft background token.

### Glow (replaces gray shadows)

Dark surfaces make drop shadows invisible; elevation comes from borders + surface steps. Glow is used for emphasis only:

- Primary button / brand mark: `0 0 14px rgba(139,124,255,.3)` (hover `.45`)
- Status dots: `0 0 6px` same-color at ~80% alpha

### Shape & type

- Radii: 6 / 8 / 10 px (sm/md/lg) + pill. Replaces 7 / 11 / 18.
- Type scale: unchanged rem scale is kept; KPI labels drop uppercase+letterspacing and become regular-case 11.5px.
- Fonts: `--font-display` and `--font-body` → Geist; `--font-mono` → Geist Mono, all via `next/font/google` in `layout.tsx`. Variable names unchanged, so the CSS font stack lines need no edits. All numerals get `tabular-nums`.

## Component recipes

**Buttons** — 30px height, 12px horizontal padding, radius-sm, 12.5px/500 text. Roles: primary (violet fill, dark-violet text, glow), secondary (border-strong outline), ghost (borderless, for in-table actions), danger (soft red background + red border — no solid red fills), icon-only (30×30). The current global 44px `button` rule is replaced.

**Forms** — inputs/selects 32px, inset background, border-strong; focus = accent border + 3px `rgba(139,124,255,.18)` ring. Toggle switches 32×18, violet when on.

**Status system** — health dots 6px with same-color glow; HTTP-code pills in Geist Mono over semantic soft backgrounds; model/virtual-model IDs always violet mono chips; capability tags neutral gray chips with border.

**KPI stat cards** — drop the circular icon chip and uppercase label. Three rows: regular-case 11.5px subtle label, Geist Mono 17px value, 11px colored delta. radius-md, 11px/13px (v/h) padding.

**Master-detail lists** — active item: `accent-soft` background + inset 2px violet left indicator (same language as sidebar active nav). Row dividers use hairline.

**Data tables** — header 11px uppercase faint (the only uppercase text that remains), ~36px rows, hover = surface-raised, numeric columns right-aligned tabular mono, hairline row dividers.

**Charts (Recharts)** — primary series violet with gradient area fill (25% → 0 opacity); categorical palette in fixed order: `#8b7cff` `#5b8def` `#3ecf8e` `#f5a623` `#f472b6` `#67e3f4`; gridlines hairline; axis text Geist Mono 11px faint; tooltip = surface-raised panel with border-strong; bar charts 3px radius.

**Progress/usage bars** — 6px pill track on hairline, violet gradient fill; amber/red gradient when approaching limits.

**Code/key display** — inset background, violet mono text, radius-sm.

**Sidebar** — nav icon chips become 24px rounded squares (mono 2-letter glyphs); active item = accent-soft background + 2px violet left inset + violet chip; brand mark violet gradient with glow; footer keeps gateway status card + account + Sign out (theme toggle removed).

**Topbar** — unchanged structure; status pill green with glowing dot, violet-tinted avatar chip.

## Scope

### Files changed

- `apps/console/src/app/globals.css` — token recast + all component-recipe sections rewritten; light theme deleted. Net line count expected to drop.
- `apps/console/src/app/layout.tsx` — font swap to Geist/Geist Mono; `data-theme` hardcoded to `"dark"`; theme-initialization logic removed.
- `apps/console/src/app/_components/theme-toggle.tsx` — deleted; `sidebar.tsx` drops the import and render.
- `apps/console/src/app/_components/charts/palette.ts`, `trend-line-chart.tsx`, `donut-breakdown.tsx` — new palette + grid/axis/tooltip theming.

### Untouched

All page/module TSX structure and layout, nav config, module logic, `packages/`, gateway, worker. E2E selectors are role/text-based and unaffected except the theme-toggle assertions below.

## Feature & test migration

1. **`v1-console` contract update** — its E2E currently asserts a theme button exists and flips `data-theme`. Rewrite to dark-only: `data-theme` is always `"dark"`, no theme button is rendered. Update the unit test in step.
2. **New feature `console-dark-restyle`** registered in `feature_list.json` (unit + E2E verification commands). Per project TDD rule, tests are written first and must fail before implementation:
   - Unit: token layer asserts (dark values, no light block, font variables → Geist).
   - E2E (Playwright): dark canvas applied, Geist rendered, primary buttons measure 30px tall, and **no horizontal overflow at 1280px and 390px** viewports.
3. Regression gate: `pnpm run verify` and `pnpm run verify:features` green before the feature is marked passing.

## Risks / notes

- Geist and Geist Mono are served from `next/font/google` (self-hosted at build); CJK text falls back to system fonts (PingFang/Microsoft YaHei) by design.
- The globals.css rewrite is large but mechanical; the section-comment structure of the file is kept so diffs stay reviewable.
- Reference mockups from the brainstorm live in `.superpowers/brainstorm/` (gitignored); this spec is self-contained.
