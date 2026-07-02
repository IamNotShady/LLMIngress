# Console Operator-Grade UI Design

Date: 2026-07-03
Status: Design approved in conversation; written spec pending user review

## Context

The Console layout is acceptable: sidebar, topbar, KPI cards, filter bars,
tables, charts, detail panels, dialogs, and forms should stay in their current
positions and keep their current behavior.

The current visual quality is the problem. Buttons, cards, charts, lists,
tables, and typography read as a soft SaaS prototype instead of a durable
developer control plane. The target user is a developer using LLMIngress for
daily debugging and operations, so the UI should prioritize scan speed,
long-session readability, clear status signals, and low visual noise.

## Chosen Direction

Use the **Operator-grade** direction:

- Lower radii and less decorative depth.
- Border-first surfaces instead of shadow-heavy cards.
- Strong table readability and numeric scanning.
- Restrained color use, with status colors reserved for operational meaning.
- Good light and dark theme behavior for daily debugging.
- No page layout redesign.

The approved implementation scope is **token + shared components polish**:
global CSS is the primary change surface, with small shared component updates
only where CSS-only overrides would be brittle.

## Goals

- Make the Console feel like a mature developer control plane while preserving
  the current information architecture.
- Normalize visual rules for buttons, cards, tables, charts, status pills,
  filter bars, dialogs, and selectable option cards.
- Improve typography by using stable system font stacks for text and numeric
  data instead of display-heavy Google font choices.
- Keep charts readable and token-driven in both themes.
- Add focused verification so future changes cannot silently regress the
  operator-grade visual contract.

## Non-Goals

- No navigation, routing, page-layout, or data-flow redesign.
- No new UI framework, shadcn install, Tailwind migration, or design-system
  package.
- No custom date picker or replacement for native controls.
- No new screenshot-generation script.
- No marketing-style hero, illustration, or decorative visual treatment.

## File Boundaries

Primary implementation file:

- `apps/console/src/app/globals.css`

Allowed shared component edits:

- `apps/console/src/app/_components/stat-card.tsx`
- `apps/console/src/app/_components/charts/trend-line-chart.tsx`
- `apps/console/src/app/_components/charts/donut-breakdown.tsx`
- `apps/console/src/app/_components/charts/palette.ts`
- `apps/console/src/app/layout.tsx` only if removing Google font imports is
  needed to adopt the system font stack.

Tracker and continuity files:

- `feature_list.json`
- `progress.md`

Do not edit page data loading, server logic, route handlers, database code, or
Gateway / Worker code for this feature.

## Visual System

### Tokens

Use the existing CSS variable system, but tune it toward a quieter operational
style:

- Radii: small and consistent; cards and panels should sit near `6px-8px`, not
  soft rounded blocks.
- Shadows: default surfaces should use borders first. Shadows are only for
  overlays, dialogs, sticky chrome, or explicit focus depth.
- Canvas and surfaces: keep light mode neutral and slightly cool. Dark mode
  should avoid pure black and keep borders readable.
- Accent: use one primary blue for actions and selection. Do not let blue
  dominate every surface.
- Status colors: green, amber, red, and info blue should be limited to status
  pills, callouts, and chart series where the meaning is explicit.
- Letter spacing: keep it at `0` for normal UI text. Avoid negative tracking
  and wide uppercase styling except for compact metadata labels.

### Typography

Adopt system font stacks:

- Body and display: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif`.
- Mono and numeric data: `ui-monospace, SFMono-Regular, Menlo, Consolas,
  "Liberation Mono", monospace`.

Keep fixed rem sizes. Do not scale fonts with viewport width.

### Buttons

Normalize four button types:

- Primary: solid accent, no oversized glow, stable hover/active states.
- Secondary: neutral surface with clear border.
- Danger: red only for destructive actions, with independent shadow/reset rules.
- Icon-only: square, compact, tooltip/accessibility labels preserved through
  existing visible or aria labels.

Primary, secondary, and danger buttons must not inherit each other's shadows.

### Cards And Panels

KPI cards, chart cards, detail panels, provider summary cards, settings panels,
and dialogs should share:

- Similar border color and radius.
- Flat or near-flat depth.
- Clear internal spacing.
- No nested-card look unless a repeated item genuinely needs a framed row.

### Tables And Lists

Tables are the Console's main scanning surface:

- Header backgrounds should be subtle and consistent.
- Numeric columns should keep tabular mono styling.
- Selected and hover rows should be visible without changing row height.
- Action buttons inside rows should remain compact and not shift layout.
- Empty states should remain simple text inside the existing table/panel area.

### Charts

Keep Recharts and the current chart wrappers. Tune charts to feel operational:

- Use token-driven chart colors from `palette.ts`.
- Remove hardcoded series colors from page modules where practical.
- Use thinner strokes, restrained grid lines, and consistent tooltip styling.
- Donut legends should align and truncate predictably.
- Chart containers should match the same card/panel surface rules.

## Tracker Handling

Because `feature_list.json` currently tracks compressed V1 milestones only,
implementation should add one new pending feature entry for this accepted UI
polish before writing tests. Suggested feature id:

`v1-console-operator-grade-ui`

The feature should depend on `v1-console`, and its verification should point to
a focused unit or static test plus a focused Playwright E2E that covers the
operator-grade visual contract.

After implementation, update `progress.md` and mark the feature passing only
after required verification and full feature regression pass.

## Verification

Required checks for implementation:

- A focused Console UI polish test verifies the visual contract with
  `getComputedStyle`, not just text presence.
- Test representative surfaces across Overview, Agents, Usage, Activity, and
  Virtual Models or equivalent shared components.
- Assert key properties for:
  - root font family and theme tokens,
  - card radius and default shadow,
  - primary, secondary, danger, and icon-button states,
  - table header background and selected/hover row behavior,
  - status pill colors,
  - chart stroke/fill colors and tooltip/card styling,
  - dark-mode canvas/surface contrast.
- Browser verification checks desktop around `1280px` and mobile around `390px`
  for no horizontal overflow, no overlapping text, and no hover/focus reflow.
- Run the repo verification ladder:
  - focused unit/static test,
  - focused E2E,
  - `pnpm run verify`,
  - `pnpm run verify:features`.

## Risks

- CSS-only overrides can become fragile if local component rules keep fighting
  global rules. Keep small shared component edits allowed for that reason.
- Visual tests can become brittle if they assert exact colors too deeply. Assert
  the small set of durable contract values and avoid screenshot-pixel matching.
- Removing Google font imports changes typography globally. Verify the auth
  screens, dialogs, code blocks, and dense tables after the change.
