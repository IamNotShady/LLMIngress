# Session Handoff

## Current Objective

- Goal: implement `feat-117 Strategy-Ordered Fallback Chains` end to end (schema, domain routing, gateway non-streaming + streaming, console, regression) and verify.
- Status: done. `feat-117` is `status: passing` in `feature_list.json`.
- Branch: `feat-117-strategy-fallback-chains` (18 commits), based off `dev` at `e863300c`.
- Workspace: isolated git worktree `.claude/worktrees/feat-117` (the main checkout is on a clean `dev`).
- Working tree before this handoff file: clean.

## Completed This Session

- **Schema** — Migration `0048_remove_route_policy_candidate_fallback`: swap-safe two-phase renumber collapses the primary/fallback split into one contiguous `candidate_order` pool, then drops `route_policy_candidates.is_fallback`. Checksum registered in `packages/db/src/migration-status.ts` (feat-087).
- **Domain routing** (`packages/domain/src/index.ts`) — removed `isFallback` from `RouteCandidate`, added local-union `healthStatus`. New `buildRouteAttemptCandidates` builds the full strategy-ordered, health-aware chain (`fixed`=candidate_order, `cost_first`=cost asc, `quality_first`=cost desc, `random`=Fisher–Yates with injectable RNG; unknown-price excluded for cost/quality; health-ineligible excluded). New `selectRouteAttempts` returns `{decision, chain}` from a SINGLE chain build so the `random` head matches the tried head.
- **Gateway config runtime** (`config-reload.ts`) — snapshot SELECT drops `is_fallback`, left-joins `provider_health_summary` for per-candidate `healthStatus`; added `createHealthSummaryChangedListener` + version-agnostic `forceReload` so provider-health changes refresh the in-memory snapshot even when `config_versions.version` is unchanged.
- **Fallback chain** (`fallback-chain.ts`) — deleted `buildFallbackAttemptCandidates`; `FallbackFailedAttempt` gained `statusCode`/`retryable`; one unifying predicate advances on retryable failures (null/429/5xx) and persists provider health only on non-retryable hard failures; added per-attempt budget hooks (`reserveAttempt`/`releaseAttempt`/`finalizeAttempt`) with exactly-once settlement (try/catch prevents reservation leaks); health recorder is injectable.
- **Non-streaming protocols** (`chat-completions.ts`, `responses.ts`, `messages.ts`, `embeddings.ts`) — drive attempts from the shared chain via `selectRouteAttempts`; per-attempt budget; empty chain → `provider_unavailable` 503; budget reject → 402 via `GatewayBudgetRejectedError`; baseline = lowest `candidate_order` (`selectGatewayBaselineCandidate`). The three custom executors switched their stop rule from `failedBeforeFirstByte` to `retryable`.
- **Streaming** (`streaming.ts`) — before-first-byte fallback loop over the chain: per-candidate budget (leak-free via outer-scope reservation released in the catch), lazy per-candidate credentials (a misconfigured fallback no longer aborts the whole request), retryable-gated continue, correct exhaustion error code, and persistent provider/model health on mid-stream errors (`bytesSent`-tracked). `requestActivityId` threaded from `main.ts`.
- **Console** — single ordered `providerModelIds` pool across `server/route-policies.ts`, `server/import-export.ts` (legacy primary+fallback import stays backward-compatible), `server/route-preview.ts`, `server/agent-limits.ts`, the two form-submit API routes (`app/api/route-policies/route.ts`, `app/api/virtual-models/route.ts`), the draggable `virtual-model-route-dialog.tsx`, and `sections.tsx`.
- **Docs** — `docs/ARCHITECTURE.md` candidate-storage decision updated to the single ordered pool.
- **Regression** — updated 6 feature unit fixtures + ~53 e2e fixtures to the single-pool/retryable model; rewrote `feat-033` to `buildRouteAttemptCandidates`; re-baselined `feat-075` for health-aware routing; added dedicated `tests/e2e/feat-117-strategy-fallback-chain.e2e.spec.ts`. `feat-070` multi-key failover preserved; `feat-090` alerts unaffected (seed `provider_health_summary` directly).
- Updated `feature_list.json` (`feat-117` → passing) and `progress.md`.

## Verification Evidence

| Check | Command | Result | Notes |
|---|---|---|---|
| Feature unit | `pnpm exec vitest run tests/features/feat-117-strategy-fallback-chain.unit.test.ts` | passed | `32 passed` |
| All feature unit | `pnpm exec vitest run tests/features/` (with `TEST_DATABASE_URL`) | passed | `433 passed (117 files)` |
| Migration check | `pnpm run db:migrate:check` | passed | `applied 48` |
| Full verify | `pnpm run verify` | passed | lint + typecheck `10/10` + 433 unit + build |
| Full E2E | `pnpm test:e2e` | passed | `133 passed (~5.3m)` |
| Feature verification command | `… feat-117 unit && pnpm test:e2e tests/e2e/feat-117-strategy-fallback-chain.e2e.spec.ts --grep 'strategy ordered fallback supports streaming and non streaming requests'` | passed | `1 passed` |

## Notes / Risks

- **Branch isolation:** a subagent ran `git checkout dev` mid-session, moving the main checkout off the feature branch; this was detected and recovered (no committed work lost), after which all work moved into the `.claude/worktrees/feat-117` worktree and every later subagent was given a hard "no git commands" rule. The worktree lacked `.env.local` (gitignored) — it was copied from the main checkout so `run-with-env.ts` could load `TEST_DATABASE_URL` for e2e.
- **DoD command nuance:** validation used `pnpm run verify` + the FULL `pnpm test:e2e` suite (133/133), which is a strict superset of what `pnpm run verify:features` re-runs; the literal `verify:features` script was not separately invoked.
- **Behavior change to be aware of:** request-path retryable failures (network/429/5xx) no longer persist provider health (only non-retryable hard failures + Worker probes do); routing now excludes MODEL-level-unhealthy candidates (provider-level-only health does not exclude). `feat-075` was re-baselined to reflect this.
- `.env.local` and a transient `apps/worker/.llmingress/backups/*.json` test artifact are untracked/gitignored and were not committed.

## Next Session Startup

1. Read `AGENTS.md`.
2. `git status --short --branch` (expect branch `feat-117-strategy-fallback-chains`).
3. Read `progress.md` and this file.
4. If reviewing the PR: the branch targets `dev`; run `pnpm run verify` and `pnpm test:e2e` from the worktree (ensure `.env.local` is present).
