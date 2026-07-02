# Console Ponytail Cleanup Implementation Plan

Goal: implement `feat-125` to remove confirmed Console over-engineering while
preserving current user-visible Console behavior.

Scope:

- Add `feat-125` tracker coverage and record final evidence.
- Delete the empty Console Next config if the build passes without it.
- Remove repeated Console API `runtime = "nodejs"` declarations.
- Remove the unused Console nav group compatibility export.
- Replace the custom Usage date picker with native date inputs.
- Replace the custom Agent allowed Virtual Models multi-select with a native
  multiple select.
- Delete the hidden `/pricing` route and redirect price override submissions to
  `/providers`.
- Redirect `/routing` to `/models` while keeping `/api/route-policies`.
- Remove only CSS selectors that are dead after the code deletions.

Verification:

- `pnpm exec vitest run tests/features/feat-125-console-ponytail-cleanup.unit.test.ts tests/features/feat-098-console-sidebar-navigation.unit.test.ts`
- `pnpm test:e2e tests/e2e/console-ui-usage.e2e.spec.ts tests/e2e/console-ui-agents.e2e.spec.ts tests/e2e/console-ui-models.e2e.spec.ts tests/e2e/feat-025-model-soft-delete.e2e.spec.ts --workers=1`
- `pnpm --filter @llmingress/console typecheck`
- `pnpm run lint`
- `pnpm run build`
- `pnpm run verify`
- `pnpm run verify:features`
