# LLMIngress Marketing Website — UI Design Specification

Deliverables: this spec + `index.html` (self-contained high-fidelity prototype,
open directly in a browser). Single-page landing site, English copy, desktop
1280 / tablet 768 / mobile 390 responsive targets.

## 1. Goals And Audience

- Audience: personal developers, indie hackers, AI power users who run several
  coding agents (Codex, Claude Code, Cursor, OpenCode, Hermes, OpenClaw,
  Copilot) against several model providers and subscriptions at once.
- Job to be done on this page: understand in under 30 seconds that LLMIngress
  is a self-hosted gateway that gives every agent one endpoint, routes each
  request to the right model, falls back on failure, and meters cost — then
  copy one command and deploy it.
- Primary conversion: `docker compose up` command copy + GitHub link.
  There is no signup, no pricing, no email capture. The page sells a repo.

Narrative chosen with the product owner: **gateway topology**. The hero draws
the product concept (agents → gateway core → providers) instead of describing
it, and the hero diagram shows a live fallback (`429` reroute) because
reliability is the emotional hook for the target user.

## 2. Brand Voice And Aesthetic Direction

Three words: **wired-in, deliberate, self-possessed.**

Physical object: the faceplate of a rack-mounted network switch in a home lab —
matte dark metal, engraved labels, one purposeful indicator LED. The brand icon
(`docs/brand/llmingress-icon.svg`) already is this object: a dark rounded panel
of sockets with a single glowing violet slot.

Consequences:

- Dark theme, derived from the audience (developers, terminal-adjacent,
  often at night) and from the existing brand icon. Not a style default.
- Violet is the *indicator LED*, not the paint. It appears only where the
  product is "live": the gateway core node, the primary CTA, active markers,
  small status glyphs. Everything else is violet-tinted neutral.
- Engraved-label typography: headings are wide and industrial, data is
  monospaced, body copy is calm and humanist.
- No glassmorphism, no gradient text, no decorative glow outside the gateway
  core, no identical icon-card grids.

## 3. Design Tokens

### 3.1 Color (OKLCH, brand hue 292)

All neutrals carry chroma 0.010–0.020 toward hue 292 (the icon violet
`#8b6cff` ≈ `oklch(0.63 0.19 292)`), so surfaces and brand cohere.

| Token | Value | Role |
| --- | --- | --- |
| `--bg` | `oklch(0.15 0.012 292)` | Page background (≈ `#0e0c14`) |
| `--bg-raised` | `oklch(0.18 0.015 292)` | Section alternation, code blocks |
| `--surface` | `oklch(0.21 0.017 292)` | Panels (console mocks, deploy cards) |
| `--surface-2` | `oklch(0.25 0.019 292)` | Hover / nested emphasis |
| `--line` | `oklch(0.32 0.02 292)` | Hairline borders, dividers (1px only) |
| `--line-soft` | `oklch(0.25 0.018 292)` | Sub-dividers |
| `--text` | `oklch(0.93 0.008 292)` | Headings, primary text |
| `--text-2` | `oklch(0.74 0.018 292)` | Body copy |
| `--text-3` | `oklch(0.58 0.024 292)` | Captions, footnotes, mono labels |
| `--accent` | `oklch(0.66 0.175 292)` | Violet — CTA, gateway core, live markers |
| `--accent-bright` | `oklch(0.78 0.11 292)` | Violet tint for small text on dark |
| `--accent-deep` | `oklch(0.5 0.19 292)` | Pressed states, diagram path stroke |
| `--ok` | `oklch(0.74 0.11 158)` | Success dots, "routed" status |
| `--warn` | `oklch(0.79 0.115 75)` | Fallback / 429 markers |
| `--ink` | `oklch(0.13 0.02 292)` | Text on violet (CTA label) |

Rules:

- 60-30-10 by visual weight: neutrals / secondary text + hairlines / violet.
- Never pure black or pure white. Never gray text on violet — use `--ink`.
- Amber (`--warn`) appears only next to fallback/429 semantics; green
  (`--ok`) only next to success semantics. Color never carries meaning alone —
  always paired with a text label.
- Contrast: body copy `--text-2` on `--bg` ≥ 7:1; `--text-3` reserved for
  ≥ 14px mono labels and passes 4.5:1 on `--bg` and `--bg-raised`.

### 3.2 Typography

| Role | Font | Details |
| --- | --- | --- |
| Display | **Archivo** (variable) | Headings; `font-stretch` 110–125%, weight 600–650, tracking −0.02em. Industrial grotesque = engraved faceplate label |
| Body | **Onest** | 17px/1.65 body (dark bg gets +0.1 leading), weight 400; max measure 62ch |
| Mono | **Spline Sans Mono** | Code, model IDs, metrics, section eyebrows, feature codes; `font-variant-ligatures: none`, tabular numerals for data |

Loaded from Google Fonts in the prototype with system fallbacks
(`font-display: swap`); production should self-host woff2.

Type scale (ratio ~1.33, fluid on display sizes only):

| Token | Size | Use |
| --- | --- | --- |
| `--t-hero` | `clamp(2.5rem, 1rem + 4vw, 3.75rem)` | H1 |
| `--t-h2` | `clamp(1.8rem, 1.1rem + 2.4vw, 2.75rem)` | Section titles |
| `--t-h3` | `1.25rem` | Feature titles, card titles |
| `--t-body` | `1.0625rem` (17px) | Body copy |
| `--t-small` | `0.9375rem` (15px) | Secondary copy, FAQ answers |
| `--t-mono` | `0.8125rem` (13px) | Code, chips, eyebrows, spec lines |

Eyebrow pattern: mono 13px, uppercase, letter-spacing 0.14em, `--text-3`,
prefixed with a two-character index (`01`, `02`…) in `--accent-bright`.
Unnumbered sections (hero, compatibility) use a `//` marker instead.

Wrapping: `h2`/`h3` use `text-wrap: balance`, body copy uses
`text-wrap: pretty` — no orphan words in headings or paragraph tails.

### 3.3 Spacing, Radius, Elevation

- 4pt scale: `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128`.
  Section vertical padding `clamp(96px, 12vw, 160px)`; rhythm varies — the
  pain strip is intentionally tighter (`64px`) than features (`128px`).
- Content column: `max-width: 1120px`, gutter `clamp(20px, 4vw, 48px)`.
- Radius: `--r-sm 8px` (chips, code tabs), `--r-md 14px` (panels, buttons),
  `--r-lg 24px` (hero diagram frame, echoes icon's rounded slots).
- Depth on dark = lighter surface, not shadow. One purposeful glow only:
  `--glow: 0 0 48px oklch(0.63 0.19 292 / 0.25)` on the gateway core node and
  (subtle, 40% strength) on the primary CTA hover.

### 3.4 Motion

- Entrance: hero children stagger in (60ms steps), `translateY(12px)` +
  opacity, 600ms `cubic-bezier(0.22, 1, 0.36, 1)` (ease-out-quint).
- Topology: 2px light dots travel agent→core→provider paths via SVG
  `animateMotion` (staggered loops). Purely narrative, not decorative.
- Hover: buttons/links 150ms; transform/opacity only, no layout animation.
- Pixel star field backdrop: a fixed full-viewport `<canvas>` behind the
  content layer (`z-index 0`; `main`/footer at 1) draws a sparse 4px pixel
  starfield in brand hues (`#efeef5 #d7c8ff #b494ff #8b6cff #93899f`,
  density 3e-5/px², 16fps, 70% of stars twinkle, occasional pixel shooting
  star every 6–14s). Adapted from `uicapsule/background-pixel-stars`,
  recolored to the palette. Stars show only where sections are transparent
  (hero, features, compatibility, deploy, final CTA); `--bg-raised` bands
  occlude them, preserving the section rhythm. `aria-hidden`,
  `pointer-events: none`.
- `prefers-reduced-motion: reduce` disables entrances, hides traveling
  dots (static diagram remains fully legible), and renders the star field
  as a static frame — no twinkle, no shooting stars.

## 4. Page Structure

Single page, 10 blocks. Anchor nav: Features `#features`, How it works
`#how`, Deploy `#deploy`, FAQ `#faq`.

```text
[0] Navbar (sticky)
[1] Hero + topology diagram
[2] Pain strip (3 error-coded pains)
[3] Features — numbered spec sheet, 6 entries
[4] How it works — 3 steps + agent config code tabs
[5] Ecosystem — agents / providers chip wall
[6] Console showcase — 3 evidence panels
[7] Deploy — 3 deployment shapes + compose command
[8] FAQ — 5 items
[9] Final CTA + Footer
```

### 4.0 Navbar

- Sticky, `--bg` at 92% opacity + `backdrop-filter: blur(12px)`, bottom
  hairline. Height 64px.
- Left: brand icon (24px, from `docs/brand/llmingress-icon.svg` geometry) +
  wordmark "LLMIngress" (Archivo 600).
- Center-right: anchor links (Onest 15px, `--text-2`, hover `--text`).
  Anchor targets carry `scroll-margin-top: 76px` so the sticky bar never
  covers a section head.
- Right: a two-segment GitHub star badge in the style of the official
  github-buttons widget, dark-adapted. Left segment: octocat mark + `Star`
  label on `--surface` (links to the repo). Right segment: joined count
  cell on `--bg-raised` with a shared hairline border, mono tabular
  numerals, full number with thousands separators (links to
  `/stargazers`). The count comes from the GitHub REST API on page load,
  cached in `localStorage` for 1 hour; on API failure the count cell stays
  hidden and the Star segment regains full corner radius (`:has()`), so
  the badge never shows a broken state. Mobile ≤768px: links collapse into
  a single `Menu` disclosure (native `<details>`), nav gaps tighten, badge
  stays visible. Progressive narrowing: ≤374px drops the count cell,
  ≤340px drops the wordmark (icon remains) — no horizontal overflow down
  to 320px.

### 4.1 Hero

Two-column grid at ≥1024px, weighted toward the diagram
(text : diagram = 1 : 1.08); stacks text-then-diagram below, where the
diagram frame may grow to 720px wide.

Left column:

- Eyebrow (mono): `SELF-HOSTED AI GATEWAY`
- H1: **One gateway for every AI agent.**
- Lede (max 58ch): "LLMIngress sits between your coding agents and your model
  providers. Point Codex, Claude Code, Cursor — any OpenAI-compatible agent —
  at a single endpoint. It picks the right model for each request, falls back
  when a provider fails, and meters every token. On your machine, with your
  keys."
- CTA row: primary `Deploy locally` (violet fill, `--ink` label, → `#deploy`);
  secondary `View on GitHub ↗` (hairline ghost).
- Trust line (mono 13px, `--text-3`, must fit one line in the text column):
  `Apache-2.0 · Single-user · Keys never leave your box`

Right column — topology diagram (inline SVG, ~660×448). On viewports wider
than the 1120px content column the frame bleeds right toward the viewport
edge (keeps a 24px inset, extension capped at 220px) so the diagram gets
extra room without squeezing the text column; the bleed resets when the
hero stacks. Inside the canvas the rails sit 128px from the core on each
side so paths curve loosely:

- Left rail: 5 agent chips — Codex, Claude Code, Cursor, OpenCode, Copilot
  (rounded rects, `--surface`, mono labels).
- Center: gateway core — rounded square echoing the brand icon (dark panel,
  violet inner slot, `--glow`), labeled `LLMIngress` in mono.
- Right rail: 5 provider chips — OpenAI, Anthropic, Google, OpenRouter,
  Ollama. All chips share one style; no per-chip badges or sub-labels
  (the local/$0 story belongs to the compatibility section, §4.5).
- Curved paths agent→core (violet-deep, 1.5px) and core→provider.
- Story beat drawn into the diagram: the `Claude Code → core → Anthropic`
  route is highlighted. The diagram carries no explanatory text beyond chip
  names and the core label — routing detail and the fallback/429 story are
  told in the Console showcase (§4.6), keeping the hero clean.
- Traveling dots per §3.4. Diagram framed in `--r-lg` panel with hairline.
- A faint brand-hue radial (`oklch(0.24 0.055 292 / 0.4)`, 70% falloff) sits
  behind the diagram side of the hero — the only background wash on the page,
  echoing the icon's radial canvas.
- Mobile: SVG scales to container width (`max-width: 100%; height: auto`),
  min legible width 340px content.

### 4.2 Pain Strip

Compressed band on `--bg-raised`, top/bottom hairlines. Intro line (H3,
Archivo): "Running three agents shouldn't feel like running three billing
departments." Then a 3-column row (stacks at ≤768px), each item:

| Code (mono, `--warn`) | Copy (15px, `--text-2`) |
| --- | --- |
| `KEY_SPRAWL` | Every agent wants its own provider keys, base URLs, and model lists. You maintain N copies of the same config. |
| `COST_BLINDSPOT` | Which agent burned $14 yesterday? Without a shared ledger, nobody knows until the invoice. |
| `PROVIDER_DOWN` | One 429 and your whole session stalls. Retrying by hand is not a fallback strategy. |

No cards, no icons — dividers + type only.

### 4.3 Features — Spec Sheet

Eyebrow `01 — CAPABILITIES`. H2: **Everything between the agent and the
model.** Layout: 2-column grid (1 column ≤768px) of six numbered entries.
Each entry: hairline top border, mono index + code name, H3 title, body copy
(≤ 40 words), and a mono `spec:` line quoting a real product guarantee. No
boxes, no icons.

| # | Code | Title | Copy | Spec line |
| --- | --- | --- | --- | --- |
| 01 | `ONE_ENDPOINT` | Unified ingress | OpenAI- and Anthropic-compatible APIs from one port. Chat, responses, messages, embeddings — every agent speaks to the same door, each with its own scoped key. | `spec: /v1/chat/completions · /v1/messages · /v1/responses · /v1/embeddings` |
| 02 | `VIRTUAL_MODELS` | Routing that reads the request | Agents ask for `code-fast`. A deterministic rule engine resolves the real model from task type, context length, and tool use. Same request, same route — no LLM judge in the loop. | `spec: p95 routing overhead < 100 ms` |
| 03 | `FALLBACK_CHAIN` | Failure is a routing event | 429s, 5xx, timeouts — the request moves to the next model in the chain, up to five deep, across providers and local models. Your agent never sees the outage. | `spec: triggers before first streamed chunk` |
| 04 | `COST_LEDGER` | Every token accounted | Tokens, cost, and latency per agent, per virtual model, per provider — plus savings measured against a fixed baseline model. | `spec: cache + reasoning tokens tracked separately` |
| 05 | `HARD_LIMITS` | Budgets with teeth | Per-agent budgets from hourly to monthly, RPM / TPM / concurrency caps. Block or notify at threshold. A runaway loop dies at the gate, not on your card. | `spec: block · notify · webhook` |
| 06 | `YOUR_METAL` | Self-hosted, single-user | Runs on your laptop or server, binds to localhost by default. Provider keys encrypted at rest; prompts recorded only if you opt in. | `spec: Node + Postgres · one compose file` |

### 4.4 How It Works

Eyebrow `02 — SETUP`. H2: **Three steps, one endpoint.** Two-column at
≥1024px: steps list left, code panel right (sticky within section).

Steps (numbered 1–3, Archivo H3 + short body; a 1px hairline connects the
number badges vertically to express sequence):

1. **Connect your providers.** Paste API keys for OpenAI, Anthropic, Google,
   OpenRouter — connect a personal subscription, or point at local Ollama.
   Keys are encrypted and never shown again.
2. **Define virtual models.** Name a policy like `code-fast` or
   `deep-reasoning`; set model scope, cost preference, and a fallback chain.
3. **Point your agents at the gateway.** Each agent gets the base URL, its own
   `llmi_` key, and a budget. Done — every request now routes, falls back, and
   gets metered.

Code panel: tab bar (mono, 3 tabs) — `Claude Code`, `Codex`, `curl`.
Realistic snippets:

```bash
# Claude Code
export ANTHROPIC_BASE_URL="http://localhost:4000"
export ANTHROPIC_AUTH_TOKEN="llmi_cc_4f8a…"
claude   # model: code-fast (virtual)
```

```toml
# Codex — ~/.codex/config.toml
model = "code-fast"
model_provider = "llmingress"

[model_providers.llmingress]
name     = "LLMIngress"
base_url = "http://localhost:4000/v1"
env_key  = "LLMINGRESS_API_KEY"   # llmi_cx_9b2e…
```

```bash
curl http://localhost:4000/v1/chat/completions \
  -H "Authorization: Bearer llmi_dev_a1c3…" \
  -d '{ "model": "code-fast",
        "messages": [{ "role": "user", "content": "…" }] }'
```

Tab switching is the page's only stateful JS (~15 lines vanilla).

### 4.5 Ecosystem / Compatibility

Eyebrow `// COMPATIBILITY`. H2: **Works with what you already run.**
Two-column grid (1 column ≤768px); each column opens with a hairline top
border, an H3, and a one-line explanation so the chip walls read as a
concrete compatibility claim, not decoration:

- **Agents that connect `→ in`** — "Any agent that lets you set an OpenAI-
  or Anthropic-compatible endpoint plugs in with a base URL and a key."
  Chips: Codex · Claude Code · Cursor · OpenCode · Hermes · OpenClaw ·
  GitHub Copilot · any OpenAI-compatible agent
- **Providers it routes to `out →`** — "API keys, personal subscriptions,
  and local runtimes — configured once, shared by every agent."
  Chips grouped under mono sub-labels matching the product's provider
  taxonomy (PRODUCT.md §8):
  - `API KEYS` — OpenAI · Anthropic · Google Gemini · OpenRouter · DeepSeek ·
    xAI · Qwen · Moonshot · MiniMax · Z.ai
  - `SUBSCRIPTIONS` — ChatGPT Plus / Pro · Claude Pro / Max · GitHub Copilot ·
    Kimi Coding Plan · GLM Coding Plan (reflects built-in allowlisted
    templates; individual templates may be disabled per ToS constraints)
  - `LOCAL` — Ollama · LM Studio · llama.cpp

Chips are mono 13px with hairline border on `--surface`; the final chip in
each group is a dashed `--text-3` "+ more" entry.

### 4.6 Console Showcase

Eyebrow `03 — OBSERVABILITY`. H2: **The Console shows its work.** Lede:
"Every request explains itself: which model, why, what it cost. No black-box
routing."

The whole exhibit is one framed Console window (`--bg` on the `--bg-raised`
section, `--r-lg`, hairline border) so it reads as a single product
screenshot, not floating cards:

- Title bar: mono `llmingress console — localhost:3000` with a green live
  dot.
- Overview stat row, 4 cells divided by hairlines (2×2 grid ≤768px):
  `requests · today 1,284` / `cost · today $3.42` / `failure rate 0.4%` /
  `saved vs baseline −62%` (`--ok`). Numbers agree with the panels below.
- Inside the window, three evidence panels (grid 5 / 4 / 3; stacks ≤1024px),
  each a `--surface` panel with a mono title bar:

1. **`activity — live`**: 5 request rows (mono): agent, virtual model → real
   model, latency, cost, status dot. One row shows fallback:
   `codex  code-fast → gpt-5-mini          412ms  $0.0021  ● ok`
   `claude-code  deep-reasoning → claude-opus-4-8   2.1s  $0.0834  ● ok`
   `cursor  code-fast → deepseek-v3         388ms  $0.0007  ● ok`
   `opencode  code-fast ⚠ 429 → qwen3-coder 903ms  $0.0004  ● rerouted`
   `claude-code  long-context → gemini-2.5-pro 1.4s $0.0179  ● ok`
2. **`usage — 7 days`**: pure-CSS bar chart, 7 bars (cost/day), under it the
   savings line: `auto-routing saved $31.40 vs claude-opus-4-8 baseline
   (−62%)` with the baseline name in `--text-3`.
3. **`route — reason`**: mono decision trace:
   `ctx_est: 9.4k · tools: yes · task: coding` → `tier 1: deepseek-v3 ✓`
   plus `fallbacks: [qwen3-coder, gpt-5-mini]`, closed by result rows
   `latency 388 ms · cost $0.0007` (matches the cursor row in panel 1).

Data is fabricated but internally consistent (prices ≈ real per-1M rates).

### 4.7 Deploy

Eyebrow `04 — DEPLOY`. H2: **Runs where you work.** Copy-able command block
(mono, copy button) centered:

```bash
export MASTER_KEY=$(openssl rand -base64 32)
export POSTGRES_PASSWORD=$(openssl rand -base64 32)
export CONSOLE_SETUP_TOKEN=$(openssl rand -base64 32)
docker compose up --build
```

Caption: `Gateway :4000 · Console :3000 · bound to 127.0.0.1 by default`.

Below, three shape cards (equal row, stacks ≤768px) — title + 2 lines:

- **Docker Compose** — recommended. Postgres included, migrations run once,
  secrets required up front. Nothing listens publicly unless you say so.
- **Local Node** — `pnpm install && ./init.sh` against your own Postgres.
  For hacking on it.
- **Server / VPS** — same compose file; expose Console deliberately, set
  `CONSOLE_PUBLIC_BASE_URL`, keep the Gateway private.

### 4.8 FAQ

Two-column grid (4/7, stacks ≤1024px): left column is a sticky head —
eyebrow `05 — FAQ`, H2 **Fair questions.**, lede "The things developers
actually check before running someone else's gateway." Right column is the
question list: native `<details>/<summary>` items, hairline dividers, `+`
marker rotating to `×` when open. The first item starts open so the band
never reads as an empty list. Five items:

1. **Is it open source?** Yes — Apache-2.0, self-hosted, built for a single
   user. No SaaS, no telemetry, no account.
2. **Which agents can connect?** Anything that lets you set an
   OpenAI-compatible base URL — Codex, Cursor, OpenCode, Copilot among them.
   Claude Code connects natively through the Anthropic-compatible
   `/v1/messages` endpoint.
3. **Are my prompts stored?** By default, no — the gateway records metadata
   only (model, tokens, cost, latency). Content recording is per-agent opt-in,
   and you can delete any record.
4. **Do my provider keys ever leave my machine?** No. Agents only ever hold
   their own `llmi_` gateway keys. Provider keys stay on your deployment,
   encrypted at rest.
5. **What does it cost to run?** The software is free. You pay providers
   directly, at their prices — and the Usage page shows what auto-routing
   saved you against a fixed baseline model.

### 4.9 Final CTA + Footer

- CTA band: a centered, hairline-framed `--r-lg` panel on `--bg-raised` with
  a faint violet radial falling from its top edge. H2 **Give your agents one
  door.** + primary `Deploy locally` + ghost `Read the docs`, buttons
  centered. Under them, the compose one-liner repeated in mono, centered.
- Footer: 3 columns — brand (icon + one-liner "A self-hosted AI gateway for
  AI agents."), Product links (Features, How it works, Deploy, FAQ), Project
  links (GitHub ↗, Docs ↗, License Apache-2.0, Changelog ↗). Bottom line:
  `© 2026 LLMIngress · not affiliated with any model provider`.

## 5. Responsive Behavior

| Breakpoint | Changes |
| --- | --- |
| ≥1280 | Reference design. Content column 1120px |
| ≤1024 | Hero stacks (text → diagram); console panels stack 1-col; how-it-works stacks (steps → code, sticky disabled); FAQ stacks (head → list, sticky disabled) |
| ≤768 | Nav links → `Menu` disclosure; pain strip, features, compatibility, deploy cards single column; console stat row 2×2; section padding tightens |
| ≤390 | H1 ≈ 40px; code blocks `overflow-x: auto`; chips wrap; **no horizontal page scroll** (hard requirement) |

## 6. Accessibility

- Semantic landmarks: `header / nav / main / section[aria-labelledby] /
  footer`. One `h1`; sections use `h2` → `h3` in order.
- Topology SVG: `role="img"` + `<title>/<desc>` describing the routing story;
  decorative dots `aria-hidden`.
- Keyboard: skip-link, visible `:focus-visible` rings (2px `--accent-bright`
  offset 2px), FAQ is native disclosure. Code tabs follow the ARIA tabs
  pattern: `button` + `aria-selected`, roving tabindex, Arrow-key switching.
- Heading order is strict (`h1` → section `h2` → `h3`); the pain-strip
  headline is an `h2` styled smaller, not an `h3`.
- Copy buttons announce state change (`Copied` text swap, `aria-live=polite`)
  and fall back to `execCommand('copy')` when the Clipboard API is
  unavailable or denied.
- The mobile `Menu` disclosure closes on link click and on outside click.
- Contrast per §3.1; status colors always paired with text labels.
- `prefers-reduced-motion` honored (§3.4).

## 7. Production Notes (Beyond Prototype)

- Self-host fonts (woff2 subsets); add `size-adjust` fallback metrics.
- Extract the topology SVG into a component if the site moves to a framework;
  the prototype keeps everything inline by design.
- OG image: reuse the hero diagram composition on `--bg` at 1200×630.
- Favicon: `docs/brand/llmingress-icon.svg`.
- GitHub, docs, license, and changelog links point at
  `github.com/IamNotShady/LLMIngress` (docs tree, LICENSE blob, releases).
  External links open in a new tab with `rel="noopener"`.
