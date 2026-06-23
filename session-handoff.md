# Session Handoff

## Current Objective

- Goal: finish full E2E regression repair for the current agent/protocol work and commit it.
- Status: done.
- Branch: `dev`
- Commit: `60f85af fix: harden agent protocol routing`
- Working tree before this handoff file: clean.

## Completed This Session

- Added Playground request protocol selection for `Responses`, `Anthropic Messages`, and `Chat Completions`.
- Added Gateway agent request logging when the agent has request logging enabled.
- Hardened agent protocol normalization:
  - Responses accepts OpenAI-style message content parts and `instructions`.
  - Anthropic Messages accepts array system prompts and caps oversized `max_tokens` at `16384`.
  - Provider 429s map to `provider_rate_limited`.
- Hardened subscription routing:
  - OpenAI Codex Responses requests use Codex URL/header/body shaping and clean unsupported parameters.
  - Codex SSE text is normalized into Responses output text for non-stream callers.
  - Claude Code OAuth JSON and streaming Messages inject the required Claude Agent SDK system identifier.
  - OpenAI OAuth delete revokes remotely before local deletion; Claude Code revoke remains local-only.
- Fixed full E2E regressions:
  - `feat-048` now seeds runtime heartbeat data inside the Console process lock.
  - `feat-061` waits for the Provider create dialog, switches to `API Keys`, then checks base URL layout.
- Removed disposable local artifacts before commit:
  - `apps/worker/.llmingress/backups/llmingress-backup-scheduled-2026-06-22T00-00-00-000Z.json`
  - `scripts/probe-claude-oauth.mjs`
- Updated `progress.md`.

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| Focused E2E | `pnpm exec tsx scripts/run-with-env.ts playwright test tests/e2e/feat-048-runtime-page.e2e.spec.ts tests/e2e/feat-061-console-interaction-layout.e2e.spec.ts --workers=1` | passed | `2 passed` |
| Focused Gateway E2E | `pnpm exec tsx scripts/run-with-env.ts playwright test tests/e2e/feat-038-anthropic-messages.e2e.spec.ts tests/e2e/feat-039-streaming.e2e.spec.ts --workers=1` | passed | `2 passed` |
| Gateway subset E2E | `pnpm exec tsx scripts/run-with-env.ts playwright test tests/e2e/feat-034-auth.e2e.spec.ts tests/e2e/feat-035-virtual-model-access.e2e.spec.ts tests/e2e/feat-036-chat-completions.e2e.spec.ts tests/e2e/feat-037-responses-stateless.e2e.spec.ts tests/e2e/feat-038-anthropic-messages.e2e.spec.ts tests/e2e/feat-039-streaming.e2e.spec.ts tests/e2e/feat-040-request-metadata.e2e.spec.ts tests/e2e/feat-041-rate-limits.e2e.spec.ts tests/e2e/feat-042-budget-enforcement.e2e.spec.ts --workers=5` | passed | `9 passed` |
| Full E2E | `pnpm test:e2e` | passed | final run: `131 passed (4.9m)` |
| Lint | `pnpm lint` | passed | `Checked 396 files` |
| Typecheck | `pnpm typecheck` | passed | `10 successful` |

## Notes / Risks

- The first full E2E attempt was invalid because an existing local Console dev server held the Next dev lock on port `3000`; it was stopped and the suite was rerun.
- One later full E2E run had transient Gateway startup exits for `feat-038` and `feat-039` with empty stdout/stderr. Both focused reruns passed, a 5-worker neighboring Gateway subset passed, and the final full E2E passed.
- This handoff file itself is generated after commit `60f85af`; commit it separately only if you want handoffs tracked.

## Next Session Startup

1. Read `AGENTS.md`.
2. Check `git status --short --branch`.
3. Read `progress.md` and this file.
4. If continuing live testing, run `./init.sh`; if changing code, run the smallest focused check first.
