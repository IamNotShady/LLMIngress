# AGENTS.md

Project harness for reliable agent-assisted development in a typescript codebase.

## Startup Workflow

Before writing code:

1. **Confirm working directory** with `pwd`
2. **Read this file** completely
3. **Read project docs if present** (`docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, README, or equivalent)
4. **Read `feature_list.json`** to see current feature status
5. **Review recent commits** with `git log --oneline -5`

If baseline verification is failing, repair that first before adding new scope.

## Working Rules

- **One feature at a time**: Pick exactly one unfinished feature from `feature_list.json`
- **TDD first**: Before implementing any feature, write the expected unit test and E2E test cases first; only start implementation after the tests exist, and finish the feature only after those tests pass
- **Verification altitude**: Tests must assert each behavior at the level the `description` states it ("stops at startup" means launching the real process, not calling a library function); if `verification` is weaker than `description`, fix it before writing tests
- **Regression after every pass**: Run `pnpm run verify:features` before marking a feature `passing`; a regressed feature gets `status: failing` plus the failure in its `evidence`, and is repaired before new scope
- **Feature review**: A passing feature's diff is reviewed before any feature that depends on it starts
- **Verification required**: Don't claim done without running verification commands
- **Coding Rule**: Before writing code for any feature, read `docs/CODING_GUIDE.md`.
- **Shared module boundary**: Any code module that may be used by Console, Gateway,
  and Worker must live under `packages/`, not inside a single app directory.
- **Update artifacts**: Before ending session, update `progress.md` and `feature_list.json`
- **Stay in scope**: Don't modify files unrelated to the current feature
- **Leave clean state**: Next session must be able to run `./init.sh` immediately

## Required Artifacts

- `feature_list.json` — Feature status tracker (source of truth)
- `progress.md` — Session continuity log
- `pnpm run verify` — Verification path (lint → typecheck → test → build; exits)
- `pnpm run verify:features` — Full feature regression (re-runs the `verification` command of every `passing` feature in `feature_list.json`; exits non-zero on any regression)
- `init.sh` — Verifies, then launches the dev servers (blocks)
- `session-handoff.md` — Optional, for larger sessions

`feature_list.json` entries use this schema: `id`, `name`, `description`,
`verification`, `dependencies`, `status`, and `evidence`.

## Definition of Done

A feature is done only when ALL of the following are true:

- [ ] Target behavior is implemented
- [ ] Unit tests and E2E tests for the feature pass at the `description`'s altitude
- [ ] Required verification actually ran (tests / lint / type-check)
- [ ] Full feature regression passed (`pnpm run verify:features`)
- [ ] Evidence recorded in `feature_list.json` or `progress.md`
- [ ] Repository remains restartable from standard startup path

## End of Session

Before ending a session:

1. Update `progress.md` with current state
2. Update `feature_list.json` with new feature status
3. Record any unresolved risks or blockers
4. Commit with descriptive message once work is in safe state
5. Leave repo clean enough for next session to run `./init.sh` immediately

## Verification Commands

`pnpm run verify` runs `lint → typecheck → test → build` and exits — use it as
the health check. (`./init.sh` runs the same gate, then launches the dev servers
and blocks.)

```bash
pnpm run verify
pnpm run verify:features
```

For full feature/E2E regression, prefer `pnpm run verify:features`: it uses the
optimized runner, batches E2E specs with `--workers=50%`, and falls back to
per-feature verification when a batch flakes. Use `pnpm test:e2e --workers=1`
only for stable pure-E2E troubleshooting or a slow serial fallback.

Database-backed verifications require `TEST_DATABASE_URL` (local Compose default:
`postgresql://postgres:llmi-local-db@127.0.0.1:55432/postgres`); they fail loudly when it is missing.

Lint is Biome (`biome.json`); use `pnpm run lint:fix` to auto-fix before committing.

For Console UI work, `pnpm run preview:console` renders every page, dialog and
drawer to `preview/` in both themes against seeded data, and reports invalid DOM
nesting and horizontal overflow naming the element that causes it. Dev only: it
asserts nothing and is in no gate.

## Escalation

If you encounter:
- **Architecture decisions**: Consult project architecture docs if present, otherwise ask user
- **Unclear requirements**: Check product/requirements docs if present, otherwise ask user
- **Repeated test failures**: Update progress, flag for human review
- **Scope ambiguity**: Re-read `feature_list.json` for definition of done
