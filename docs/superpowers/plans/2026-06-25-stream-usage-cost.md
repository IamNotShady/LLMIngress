# feat-118 Stream Usage/Cost Accounting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task-by-task.

**Goal:** Let stream requests for `/v1/chat/completions`, `/v1/responses`, and `/v1/messages` write `request_usage` and `request_costs`.

**Architecture:** Add a lightweight SSE usage collector on the existing stream passthrough path. Use provider-emitted token usage when present; otherwise use the existing estimated-token fallback. Always compute cost through LLMIngress model pricing and `recordGatewayUsageCostAndSavings`; never trust provider raw cost as authoritative USD.

**Tech Stack:** TypeScript, Node streams, Fastify, Postgres, Vitest, Playwright E2E.

---

## Summary

- Worktree: `.worktrees/feat-118-stream-usage-cost` on branch `codex/feat-118-stream-usage-cost`.
- Scope: current stream-capable endpoints only: `/v1/chat/completions`, `/v1/responses`, `/v1/messages`. `/v1/embeddings` remains non-streaming.
- Provider policy: OpenAI Chat needs `stream_options.include_usage`; Responses usage comes from completed response events; Anthropic Messages usage is cumulative; OpenRouter usage may include credits cost but LLMIngress still computes USD; Gemini and LM Studio support `include_usage`; Ollama/llama.cpp are parsed only if they emit compatible usage.

## Key Changes

- Reuse `GatewayUsageCostDetails`, `readGatewayProviderTokenUsage`, and `recordGatewayUsageCostAndSavings` in `apps/gateway/src/usage-recorder.ts`.
- Add a small stream usage collector that parses SSE `data:` frames with `TextDecoder`, recognizes OpenAI-compatible chat usage, Responses `response.completed`, and Anthropic `message_start` / `message_delta` usage.
- Add `usageCost?: GatewayUsageCostDetails` to successful `GatewayStreamingResult` in `apps/gateway/src/streaming.ts`.
- Populate `usageCost` from selected candidate price, baseline candidate price, estimated tokens, and selected provider model.
- Add `stream_options: { include_usage: true }` only for known chat providers that support it: `openai`, `google`, `lmstudio`.
- In `apps/gateway/src/main.ts`, wrap the successful stream so completion records usage/cost and completes activity with synthetic `{ usage }` metadata when provider usage exists.
- Extend `tests/support/fake-provider.ts` with query-controlled stream usage variants for chat, responses, messages, openrouter, and no-usage fallback.

## Interface / Schema Impact

- No database migration.
- No external API response shape change.
- Internal type change only: successful `GatewayStreamingResult` gains optional `usageCost?: GatewayUsageCostDetails`.
- New helper stays in `usage-recorder.ts`; no new package or dependency.

## Test Plan

- Unit: `pnpm exec vitest run tests/features/feat-118-stream-usage-cost.unit.test.ts`
- E2E: `pnpm test:e2e tests/e2e/feat-118-stream-usage-cost.e2e.spec.ts`
- Full: `pnpm run verify`
- Regression: `pnpm run verify:features`

## Assumptions / Defaults

- Exact stream token counts are best-effort because providers differ.
- Provider-emitted tokens win; no usage frame means `token_source = 'estimated'`.
- Cost is always LLMIngress-calculated USD from configured model pricing.
- Budget reservation settlement remains estimate-based in this feature.
