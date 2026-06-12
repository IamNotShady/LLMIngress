# AGENTS.md

Project harness for reliable agent-assisted development in a typescript codebase.

## Startup Workflow

Before writing code:

1. **Confirm working directory** with `pwd`
2. **Read this file** completely
3. **Read project docs if present** (`docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, README, or equivalent)
4. **Run `pnpm run verify`** to confirm the workspace is healthy (lint → typecheck → test → build; exits when done). Use `./init.sh` only when you also want the dev servers running — it verifies first, then launches and blocks.
5. **Read `feature_list.json`** to see current feature state
6. **Review recent commits** with `git log --oneline -5`

If baseline verification is failing, repair that first before adding new scope.

## Working Rules

- **One feature at a time**: Pick exactly one unfinished feature from `feature_list.json`
- **TDD first**: Before implementing any feature, write the expected unit test and E2E test cases first; only start implementation after the tests exist, and finish the feature only after those tests pass
- **Verification required**: Don't claim done without running verification commands
- **Coding Rule**: Before writing code for any feature, read `docs/CODING_GUIDE.md`.
- **Update artifacts**: Before ending session, update `progress.md` and `feature_list.json`
- **Stay in scope**: Don't modify files unrelated to the current feature
- **Leave clean state**: Next session must be able to run `./init.sh` immediately

## Required Artifacts

- `feature_list.json` — Feature state tracker (source of truth)
- `progress.md` — Session continuity log
- `pnpm run verify` — Verification path (lint → typecheck → test → build; exits)
- `init.sh` — Verifies, then launches the dev servers (blocks)
- `session-handoff.md` — Optional, for larger sessions

## Definition of Done

A feature is done only when ALL of the following are true:

- [ ] Target behavior is implemented
- [ ] Unit tests and E2E tests for the feature pass
- [ ] Required verification actually ran (tests / lint / type-check)
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
```

Lint is Biome (`biome.json`); use `pnpm run lint:fix` to auto-fix before committing.

## Escalation

If you encounter:
- **Architecture decisions**: Consult project architecture docs if present, otherwise ask user
- **Unclear requirements**: Check product/requirements docs if present, otherwise ask user
- **Repeated test failures**: Update progress, flag for human review
- **Scope ambiguity**: Re-read `feature_list.json` for definition of done
