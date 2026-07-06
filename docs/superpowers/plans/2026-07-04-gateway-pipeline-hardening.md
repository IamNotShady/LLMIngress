# Gateway 请求链路加固实现方案

**Goal:** 修复 Gateway「接收 agent 请求 → 请求 LLM → 返回响应」链路审查发现的正确性、可用性与记账问题。

**Architecture:** 六个可独立验证的 feature 切片,按依赖排序:连接池是地基(F1),记录韧性(F2)与流式健壮性(F3)并行,结算完整性(F4)依赖 F1/F2,错误保真(F5)与请求卫生(F6)收尾。每个 feature 在 `feature_list.json` 注册,TDD(先写失败的 unit + E2E 测试),通过后跑 `pnpm run verify:features` 再进入下一个。

**Tech Stack:** Fastify 5 / pg 8(新增 Pool)/ vitest / Playwright(E2E 以真实 Gateway 子进程 + `createTestPostgresFixture` + `tests/support/fake-provider.ts` 为准)。

**Worktree:** `.claude/worktrees/gateway-pipeline-hardening`(分支 `worktree-gateway-pipeline-hardening`,已含 dev 全部提交)。

---

## 0. 审查发现 → Feature 映射

| 审查发现 | Feature |
|---|---|
| D1 无连接池、每请求 10+ 次建连 | F1 gateway-db-pool |
| D2 记账写入阻塞关键路径且失败放大为 5xx;I8 finally 抛错;I5 console.error 泄漏 body | F2 gateway-recording-resilience |
| I1 provider 无超时 / 流中无 idle 超时;I2 流式无背压 | F3 gateway-stream-robustness |
| D3 预算用估算值 finalize;D4 >5min 流成本逃逸;D12 并发计数泄漏 | F4 gateway-settlement-integrity |
| D10 字符串错误分类;D11 provider 4xx 被伪装成 502;D7 非流式凭证 eager;D6 流式单 key 漂移 | F5 gateway-error-fidelity |
| I3 bodyLimit;I6 x-request-id;I4 快照原地 sort;I15 CJK 估算;I11 /metrics;D5 参数白名单;D8 OAuth 刷新竞态 | F6 gateway-request-hygiene |

**明确的非目标**(本方案不做,已在 F6 的文档同步任务里记录为决策):
- D6 完全统一流式/非流式到 provider adapter(只修最疼的多 key 漂移,完整统一另立方案)。
- D5 多模态(image_url)支持——继续显式 400,文档化。
- TPM 用实际 token 回填对账——保持估算语义,文档化。
- D9 把 `packages/db/src/gateway-*` 迁到独立包——改为在 ARCHITECTURE.md 写明现状决策。
- Agent key 鉴权缓存(I7)。

**已核实的代码事实**(执行时不要重新怀疑;若与现状不符先停下核对):
- `PostgresClient extends pg.Client`,无池(`packages/db/src/client.ts:15`)。
- `jobs` 表有 `jobs_job_type_check` CHECK 约束枚举全部 job type(`packages/db/migrations/0001_v1_baseline.sql:283`)→ 新增 job type **必须新建迁移 0002**。
- stale-reservation sweeper 把过期 reservation 置为 `'expired'`(`worker-stale-reservations.ts:74`);`budget_reservations_status_check` 允许 `pending/finalized/released/expired`(`0001_v1_baseline.sql:132`)。
- `gateway-tracing.ts` 走 `recordOpenTelemetrySpan`,**不**直接 `new PostgresClient` → 不在池化改造清单里。
- `gateway-config-reload.ts` 用 LISTEN 长连接 → **不能**池化,保持专用 Client。
- fake-provider(`tests/support/fake-provider.ts`,449 行)已支持流式响应。
- E2E 样板:`tests/e2e/v1-gateway-routing.e2e.spec.ts` 内的 `startGatewayProcess/waitForGateway/getFreePort/stopGatewayProcess` + `createTestPostgresFixture` + `runMigrations`。
- `provider_oauth` 表列:`encrypted_token`、`token_expires_at`(`providers.ts:88,98`)。
- 单元测试放 `tests/features/<feature-id>.unit.test.ts`,E2E 放 `tests/e2e/<feature-id>.e2e.spec.ts`,verification 命令格式:`pnpm exec vitest run tests/features/<id>.unit.test.ts && pnpm test:e2e tests/e2e/<id>.e2e.spec.ts`。

## 0.5 准备

- [ ] `pnpm install`(worktree 首次)
- [ ] 基线:`pnpm run verify` 与 `pnpm run verify:features` 全绿后才开工;红则先修基线。
- [ ] 在 `feature_list.json` 追加六个 feature 条目(见附录 A),全部 `status: "failing"`,随各 feature 通过逐个翻绿。

---

## F1 gateway-db-pool — 进程级连接池

**目标行为:** Gateway 热路径上的所有短事务/单查询走进程级 `pg.Pool`;并发压测时 Postgres 连接数有界;应用关闭时池被清空。

**Files:**
- Modify `packages/db/src/client.ts` — 新增 `getPostgresPool` / `closePostgresPools` / `withPooledPostgresClient` / `withPostgresTransaction`
- Modify(单查询 → `getPostgresPool(...).query`):
  - `packages/db/src/gateway-auth.ts` `readAgentApiKeyByHash`(现 126-151)
  - `packages/db/src/gateway-virtual-model-access.ts` `listAllowedGatewayVirtualModels`(现 100-129)
  - `packages/db/src/gateway-activity-recorder.ts` `createGatewayRequestActivity`、`completeGatewayRequestActivity`
  - `packages/db/src/gateway-rate-limits.ts` `releaseGatewayConcurrency`
  - `packages/db/src/gateway-chat-completions.ts` `recordGatewayProviderApiKeyLastUsed`
  - `packages/db/src/gateway-fallback-chain.ts` `recordSucceededAttemptInDatabase`、`recordFailedAttemptInDatabase`
  - `packages/db/src/gateway-streaming.ts` `recordGatewayRuntimeError`
  - `packages/db/src/provider-health.ts` `recordProviderHealthEvent` 及同文件另一处 `new PostgresClient`(现 99、130)
- Modify(事务 → `withPostgresTransaction`):
  - `packages/db/src/gateway-rate-limits.ts` `enforceGatewayRateLimits`
  - `packages/db/src/gateway-budgets.ts` `reserveGatewayBudget`、`updateGatewayBudgetReservation`
  - `packages/db/src/gateway-usage-recorder.ts` `recordGatewayUsageCostAndSavings`
- Modify(多查询同连接,非事务 → `withPooledPostgresClient`):
  - `packages/db/src/gateway-chat-completions.ts` `readProviderCredentials`
- Modify `apps/gateway/src/main.ts` — `onClose` 里追加 `await closePostgresPools()`
- Create `tests/support/gateway-process.ts` — 从 `tests/e2e/v1-gateway-routing.e2e.spec.ts` 原样提取 `startGatewayProcess`、`waitForGateway`、`getFreePort`、`stopGatewayProcess` 并让原 spec 改为 import(纯搬移,不改行为)
- Test: `tests/features/gateway-db-pool.unit.test.ts`、`tests/e2e/gateway-db-pool.e2e.spec.ts`

**不改:** `gateway-config-reload.ts`(LISTEN)、`console-*`、`worker-*`(低频,可后续迁移)。

- [ ] **F1.1 失败的单元测试**

```ts
// tests/features/gateway-db-pool.unit.test.ts
import { afterAll, describe, expect, it } from "vitest";
import {
  closePostgresPools,
  getPostgresPool,
  withPostgresTransaction,
} from "../../packages/db/src/client";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe("gateway db pool", () => {
  afterAll(async () => {
    await getPostgresPool(databaseUrl).query("drop table if exists pool_tx_probe");
    await closePostgresPools();
  });

  it("returns the same pool instance for the same connection string", () => {
    expect(getPostgresPool(databaseUrl)).toBe(getPostgresPool(databaseUrl));
  });

  it("bounds concurrent connections at the configured max", async () => {
    const pool = getPostgresPool(databaseUrl);
    await Promise.all(
      Array.from({ length: 50 }, () => pool.query("select pg_sleep(0.01)")),
    );
    expect(pool.totalCount).toBeLessThanOrEqual(10);
  });

  it("rolls back the transaction when the operation throws", async () => {
    await getPostgresPool(databaseUrl).query("create table if not exists pool_tx_probe (id int)");
    await expect(
      withPostgresTransaction(databaseUrl, async (client) => {
        await client.query("insert into pool_tx_probe values (1)");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const result = await getPostgresPool(databaseUrl).query<{ n: number }>(
      "select count(*)::int as n from pool_tx_probe",
    );
    expect(result.rows[0]?.n).toBe(0);
  });
});
```

- [ ] **F1.2 跑测确认红**:`pnpm exec vitest run tests/features/gateway-db-pool.unit.test.ts` → FAIL(`getPostgresPool` 不存在)。

- [ ] **F1.3 client.ts 实现**

```ts
// packages/db/src/client.ts 追加(import 行加 Pool)
import { Client, type ClientConfig, Pool } from "pg";

const pools = new Map<string, Pool>();

function readPoolMax(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.LLMINGRESS_DB_POOL_MAX ?? "10");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 10;
}

export function getPostgresPool(databaseUrl?: string): Pool {
  const connectionString = databaseUrl?.trim() || readPostgresDatabaseUrl();
  const existing = pools.get(connectionString);
  if (existing) {
    return existing;
  }
  const pool = new Pool({
    connectionString,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    max: readPoolMax(),
  });
  pool.on("error", () => {
    // Idle-client errors (server restart, network blip) must not crash the
    // process; the next checkout dials a fresh connection.
  });
  pools.set(connectionString, pool);
  return pool;
}

export async function closePostgresPools(): Promise<void> {
  const closing = [...pools.values()].map((pool) => pool.end());
  pools.clear();
  await Promise.all(closing);
}

export async function withPooledPostgresClient<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  const client = await getPostgresPool(databaseUrl).connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

export async function withPostgresTransaction<T>(
  databaseUrl: string | undefined,
  operation: (client: PostgresQueryClient) => Promise<T>,
): Promise<T> {
  return withPooledPostgresClient(databaseUrl, async (client) => {
    await client.query("begin");
    try {
      const result = await operation(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  });
}
```

- [ ] **F1.4 跑测确认绿**,然后做调用点改造。单查询模式(以 auth 为例,其余同构):

```ts
// packages/db/src/gateway-auth.ts — readAgentApiKeyByHash 改造后
async function readAgentApiKeyByHash(
  databaseUrl: string | undefined,
  keyHash: string,
): Promise<AgentApiKeyAuthRow | undefined> {
  const result = await getPostgresPool(databaseUrl).query<AgentApiKeyAuthRow>(
    `
      select agents.id::text,
             agents.id::text as agent_id,
             agents.key_prefix,
             agents.default_virtual_model_id::text,
             agents.enabled,
             agents.request_logging_enabled
      from agents
      where agents.key_hash = $1
        and agents.deleted_at is null
    `,
    [keyHash],
  );
  return result.rows[0];
}
```

事务模式(以限流为例;`lockRateLimitWindow`/`incrementRateLimitWindow` 的 `client` 参数类型从 `PostgresClient` 放宽为 `PostgresQueryClient`):

```ts
// packages/db/src/gateway-rate-limits.ts — enforceGatewayRateLimits 外壳改造后
export async function enforceGatewayRateLimits(input: {
  agentApiKeyId: string;
  databaseUrl?: string;
  requestId: string;
  requestMetadata: GatewayRequestMetadata;
}): Promise<GatewayRateLimitDecision> {
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const limits = await readEnabledGatewayRateLimits(client, input.agentApiKeyId);
    if (limits.length === 0) {
      return { ok: true };
    }
    // ……原 begin/commit 之间的循环逻辑原样搬入,
    // 原 `rollback + return decision` 分支改为 `throw new GatewayRateLimitRejection(decision)`
    // 在外层 catch 还原为返回值(或:先 evaluate 全部、后 increment 的结构不变,
    // 拒绝时直接 return decision——withPostgresTransaction 会 commit,
    // 但拒绝分支没有做任何写入,commit 空事务是安全的)。
  });
}
```

> 采用注释里第二种做法(拒绝分支直接 return,空事务 commit),不引入新异常类型。`reserveGatewayBudget` 的 402 拒绝分支同理(拒绝前无写入,直接 return;`token_budget_exceeded` 分支在任何写入前发生)。**注意** `reserveGatewayBudget` 的 `cost_budget_exceeded` 分支发生在 `lockBudgetPeriod` 的 insert 之后——该 insert 是 `on conflict do nothing` 的幂等窗口行创建,commit 掉也无副作用,同样直接 return。

- [ ] **F1.5 全部调用点改完后**:`pnpm run typecheck`,再 `pnpm exec vitest run tests/features/gateway-db-pool.unit.test.ts`。

- [ ] **F1.6 失败的 E2E**(先提取 `tests/support/gateway-process.ts`,让 v1 spec 改 import 后跑一次 `pnpm test:e2e tests/e2e/v1-gateway-routing.e2e.spec.ts` 证明搬移无损):

```ts
// tests/e2e/gateway-db-pool.e2e.spec.ts
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { createTestPostgresFixture, runMigrations } from "../../packages/db/src/index";
import { createFakeProviderServer } from "../support/fake-provider";
import { getFreePort, startGatewayProcess, stopGatewayProcess, waitForGateway } from "../support/gateway-process";
import { buildV1ProviderCoverageSmokePlan } from "../support/v1-provider-coverage-smoke";

test("gateway serves a 30-request burst with bounded postgres connections", async () => {
  const fixture = await createTestPostgresFixture({
    databaseNamePrefix: `llmingress_pool_${randomUUID().replaceAll("-", "_")}`,
  });
  const fakeProvider = await createFakeProviderServer();
  try {
    await runMigrations({ databaseUrl: fixture.databaseUrl });
    // 复用 v1 spec 的 seed 辅助逻辑:一个 openai 场景即可
    // (把 v1 spec 里的 seedV1ProviderCoverageRoutes 一并提到 tests/support/gateway-process.ts
    //  或在本 spec 内联最小 seed:agent + api key + provider + model + virtual model + route policy)
    const gateway = startGatewayProcess({ databaseUrl: fixture.databaseUrl, port: await getFreePort() });
    try {
      const baseUrl = `http://127.0.0.1:${gateway.port}`;
      await waitForGateway(baseUrl, gateway);

      const responses = await Promise.all(
        Array.from({ length: 30 }, () =>
          fetch(`${baseUrl}/v1/chat/completions`, {
            body: JSON.stringify({ messages: [{ content: "ping", role: "user" }], model: "vm-pool" }),
            headers: { authorization: "Bearer <seeded-key>", "content-type": "application/json" },
            method: "POST",
          }),
        ),
      );
      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      const connections = await fixture.query<{ n: number }>(
        `select count(*)::int as n from pg_stat_activity where datname = current_database()`,
      );
      // 池上限 10 + 配置热更新 LISTEN 连接 + 本查询自身;旧实现在 30 并发下会远超此值
      expect(connections.rows[0].n).toBeLessThanOrEqual(16);
    } finally {
      await stopGatewayProcess(gateway);
    }
  } finally {
    await fakeProvider.close();
    await fixture.dispose();
  }
});
```

> 执行时按 `createTestPostgresFixture` 的真实 API 调整 `fixture.query/dispose` 与 seed 方式(以 v1 spec 为准);断言阈值 16 若因 fixture 连接数抖动,放宽到 20 并注明理由——它区分的是「有界」与「每请求建连」两个数量级。

- [ ] **F1.7 E2E 转绿 → `pnpm run verify` → `pnpm run verify:features` → 更新 feature 状态 → commit**(`feat(gateway): pool postgres connections on the request path`)。

---

## F2 gateway-recording-resilience — 记录写入失败不影响响应

**目标行为:** activity/usage/trace 任一写入失败,agent 仍收到 LLM 响应;失败以 error 级日志留痕。真实 Gateway 进程在 `request_activity` 表被删除的情况下仍能 200。

**Files:**
- Create `apps/gateway/src/request-recording.ts` — 从 `main.ts` 搬出 `executeRecordedGatewayJsonRequest`、`executeRecordedGatewayStreamingRequest`,注入 recorder
- Modify `apps/gateway/src/main.ts` — 改 import;`GatewayJsonEndpointExecutionInput.requestActivityId` 类型放宽为 `string | undefined`
- Modify `packages/db/src/gateway-chat-completions.ts` — finally 里 `releaseGatewayConcurrency(...).catch(() => undefined)`(泄漏由 F4 的 reconcile 兜底)
- Modify `packages/db/src/gateway-streaming.ts` — 非 ok 分支的 `console.error` 对象里删除 `body` 字段(明细已进 `fallback_events`)
- Test: `tests/features/gateway-recording-resilience.unit.test.ts`、`tests/e2e/gateway-recording-resilience.e2e.spec.ts`

- [ ] **F2.1 失败的单元测试**

```ts
// tests/features/gateway-recording-resilience.unit.test.ts
import { describe, expect, it, vi } from "vitest";
import {
  executeRecordedGatewayJsonRequest,
  type GatewayRequestRecorder,
} from "../../apps/gateway/src/request-recording";

function fakeLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

const baseInput = {
  agentApiKeyId: "agent-1",
  agentApiKeyPrefix: "llmi_",
  model: "vm-a",
  protocol: "chat_completions" as const,
  requestLoggingEnabled: true,
  requestId: "req-1",
  virtualModelId: "vm-id-1",
};

function recorder(overrides: Partial<GatewayRequestRecorder> = {}): GatewayRequestRecorder {
  return {
    completeActivity: vi.fn(async () => undefined),
    createActivity: vi.fn(async () => ({ id: "act-1", startedAt: new Date() })),
    recordTrace: vi.fn(async () => undefined),
    recordUsageCost: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("gateway recording resilience", () => {
  it("returns the LLM response when activity creation fails", async () => {
    const logger = fakeLogger();
    const execute = vi.fn(async () => ({ body: { ok: true }, statusCode: 200 }));
    const response = await executeRecordedGatewayJsonRequest({
      ...baseInput,
      execute,
      logger,
      recorder: recorder({ createActivity: vi.fn(async () => { throw new Error("db down"); }) }),
    });
    expect(response.statusCode).toBe(200);
    expect(execute).toHaveBeenCalledWith(undefined); // 无 activityId 也要继续执行
    expect(logger.error).toHaveBeenCalled();
  });

  it("returns the LLM response when completion/usage/trace writes fail", async () => {
    const logger = fakeLogger();
    const failing = recorder({
      completeActivity: vi.fn(async () => { throw new Error("write failed"); }),
      recordTrace: vi.fn(async () => { throw new Error("write failed"); }),
      recordUsageCost: vi.fn(async () => { throw new Error("write failed"); }),
    });
    const response = await executeRecordedGatewayJsonRequest({
      ...baseInput,
      execute: async () => ({
        body: { ok: true },
        statusCode: 200,
        usageCost: {
          actualPrice: { status: "unknown_price", priceVersion: "v0" } as never,
          baselinePrice: { status: "unknown_price", priceVersion: "v0" } as never,
          baselineProviderModelId: "pm-1",
          estimatedInputTokens: 1,
          estimatedOutputTokens: 1,
          providerModelId: "pm-1",
        },
      }),
      logger,
      recorder: failing,
    });
    expect(response.statusCode).toBe(200);
    expect(logger.error).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **F2.2 确认红**(模块不存在)。

- [ ] **F2.3 实现 `request-recording.ts`**(核心骨架;streaming 版同构迁移,`completeActivity` 回调内部的 usage 记账 catch 从 `logger.debug` 改 `logger.error`):

```ts
// apps/gateway/src/request-recording.ts
import {
  completeGatewayRequestActivity,
  createGatewayRequestActivity,
  type GatewayStartedRequestActivity,
} from "@llmingress/db/gateway-activity-recorder";
import { recordGatewayRequestTrace } from "@llmingress/db/gateway-tracing";
import { recordGatewayUsageCostAndSavings } from "@llmingress/db/gateway-usage-recorder";
// …其余类型 import 与 main.ts 现状一致

export type GatewayRequestRecorder = {
  completeActivity: typeof completeGatewayRequestActivity;
  createActivity: typeof createGatewayRequestActivity;
  recordTrace: typeof recordGatewayRequestTrace;
  recordUsageCost: typeof recordGatewayUsageCostAndSavings;
};

export const defaultGatewayRequestRecorder: GatewayRequestRecorder = {
  completeActivity: completeGatewayRequestActivity,
  createActivity: createGatewayRequestActivity,
  recordTrace: recordGatewayRequestTrace,
  recordUsageCost: recordGatewayUsageCostAndSavings,
};

export async function executeRecordedGatewayJsonRequest(input: {
  // …main.ts 现有字段不变,新增:
  logger: FastifyBaseLogger;
  recorder?: GatewayRequestRecorder;
  execute: (requestActivityId: string | undefined) => Promise<GatewayJsonEndpointResponse>;
}) {
  const recorder = input.recorder ?? defaultGatewayRequestRecorder;
  let activity: GatewayStartedRequestActivity | undefined;
  try {
    activity = await recorder.createActivity({ /* 原参数 */ });
  } catch (error) {
    input.logger.error({ err: error, requestId: input.requestId }, "gateway activity create failed");
  }
  const response = await input.execute(activity?.id);
  const startedAt = activity?.startedAt ?? new Date();

  if (activity) {
    try {
      await recorder.completeActivity({ activityId: activity.id, startedAt, /* 原参数 */ });
    } catch (error) {
      input.logger.error({ err: error, requestId: input.requestId }, "gateway activity complete failed");
    }
    if (response.statusCode < 400 && response.usageCost) {
      try {
        await recorder.recordUsageCost({ activityId: activity.id, /* 原参数 */ });
      } catch (error) {
        input.logger.error({ err: error, requestId: input.requestId }, "gateway usage recording failed");
      }
    }
  }
  try {
    await recorder.recordTrace({ startedAt, /* 原参数 */ });
  } catch (error) {
    input.logger.error({ err: error, requestId: input.requestId }, "gateway trace recording failed");
  }
  return response;
}
```

> 语义变化点:usage/trace 记录不再依赖 activity 创建成功与否分别决定——usage 需要 `activityId`(FK),activity 缺失时跳过并已有 error 日志;trace 不需要 activityId,始终尝试。streaming 版:`createActivity` 失败时仍执行流式请求,`completeActivity` 包装器整体 no-op 化(没有 activity 就只做 usage 记账 + 预算结算——预算结算职责在 F4 落位到这里)。

- [ ] **F2.4 单测转绿;失败的 E2E**:

```ts
// tests/e2e/gateway-recording-resilience.e2e.spec.ts(骨架同 F1.6)
// seed 一个可用路由后:
await fixture.query("drop table request_activity cascade");
const response = await fetch(`${baseUrl}/v1/chat/completions`, { /* 同 F1.6 单请求 */ });
expect(response.status).toBe(200); // 记录层全灭,LLM 响应照常返回
```

- [ ] **F2.5 E2E 转绿 → `pnpm run verify` → `pnpm run verify:features` → commit**(`feat(gateway): keep serving when recording writes fail`)。

---

## F3 gateway-stream-robustness — 超时与背压

**目标行为:** (a) 非流式 provider 调用在 `PROVIDER_REQUEST_TIMEOUT_MS`(默认 120s)内失败返回而非无限挂起;(b) 流式建连 30s、首字节 30s(现有)、字节间 idle `GATEWAY_STREAM_IDLE_TIMEOUT_MS`(默认 120s)三段超时;(c) 慢客户端不再导致网关内存无界缓冲;客户端断开会向上游 cancel。

**Files:**
- Modify `packages/provider/src/adapters/adapter-http.ts` — 新增 `providerRequestTimeoutMs()`
- Modify `packages/provider/src/adapters/openai.ts`、`anthropic.ts` — 三个/一个 fetch 全部加 `signal`,超时错误归一化
- Modify `packages/db/src/gateway-streaming.ts` — 建连 AbortController;`readFirstChunkWithTimeout` 泛化为 `readChunkWithTimeout`;`createReadaheadStream` 加 idle 超时参数;`wrapProviderStreamWithActivityCompletion` 改 pipe + 客户端断开回传 destroy
- Test: `tests/features/gateway-stream-robustness.unit.test.ts`、`tests/e2e/gateway-stream-robustness.e2e.spec.ts`

- [ ] **F3.1 失败的单元测试**

```ts
// tests/features/gateway-stream-robustness.unit.test.ts
import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createOpenAIProviderAdapter } from "../../packages/provider/src/adapters/openai";
import {
  createReadaheadStream,
  wrapProviderStreamWithActivityCompletion,
} from "../../packages/db/src/gateway-streaming";

describe("provider call timeouts", () => {
  it("fails a hung non-streaming provider call within the timeout", async () => {
    const hangingFetch: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const adapter = createOpenAIProviderAdapter({ fetch: hangingFetch, timeoutMs: 20 });
    const result = await adapter.chatCompletion({
      request: { messages: [{ content: "hi", role: "user" }] },
      target: { apiKey: "k", baseUrl: "http://provider.test/v1", modelId: "m" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryable).toBe(true);
      expect(result.errorMessage).toContain("timed out");
    }
  });
});

describe("streaming idle timeout", () => {
  it("errors the stream when the provider stalls between chunks", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
        // 之后永不 enqueue、永不 close
      },
    });
    const reader = stalled.getReader();
    const first = await reader.read();
    const stream = createReadaheadStream(reader, first.value as Uint8Array, { idleTimeoutMs: 20 });
    await expect(
      new Promise((_resolve, reject) => stream.on("error", reject).resume()),
    ).rejects.toThrow(/stalled/i);
  });
});

describe("streaming backpressure", () => {
  it("stops pulling from the provider when the client does not read", () => {
    const source = new PassThrough({ highWaterMark: 1024 });
    wrapProviderStreamWithActivityCompletion(source, {
      completeActivity: async () => undefined,
      statusCode: 200,
    }); // 故意不消费返回的流
    let writes = 0;
    while (source.write(Buffer.alloc(1024)) && writes < 1000) {
      writes += 1;
    }
    expect(writes).toBeLessThan(64); // 旧实现 flowing + 无界 write 会打满 1000
  });

  it("destroys the upstream source when the client side closes", async () => {
    const source = new PassThrough();
    const wrapped = wrapProviderStreamWithActivityCompletion(source, {
      completeActivity: async () => undefined,
      statusCode: 200,
    });
    wrapped.destroy();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source.destroyed).toBe(true);
  });
});
```

- [ ] **F3.2 确认红**(`timeoutMs`、`createReadaheadStream` 未导出/无参数等)。

- [ ] **F3.3 适配器超时实现**

```ts
// packages/provider/src/adapters/adapter-http.ts 追加
export function providerRequestTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const parsed = Number(env.PROVIDER_REQUEST_TIMEOUT_MS ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}
```

```ts
// openai.ts / anthropic.ts:options 增加 timeoutMs?: number;每个 fetch 调用改为
const timeoutMs = options.timeoutMs ?? providerRequestTimeoutMs();
const response = await fetchImpl(url, {
  body: JSON.stringify(payload),
  headers,
  method: "POST",
  signal: AbortSignal.timeout(timeoutMs),
});
// catch 分支归一化(三个端点方法相同处理):
catch (error) {
  const timedOut =
    error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
  return {
    body: null,
    errorCode: "provider_request_failed",
    errorMessage: timedOut
      ? `Provider request timed out after ${timeoutMs}ms.`
      : error instanceof Error ? error.message : "Provider request failed.",
    ok: false,
    retryable: true,
    statusCode: null,
  };
}
```

- [ ] **F3.4 流式三段超时实现**

```ts
// gateway-streaming.ts
function streamConnectTimeoutMs(env = process.env): number {
  const parsed = Number(env.GATEWAY_STREAM_CONNECT_TIMEOUT_MS ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}
function streamIdleTimeoutMs(env = process.env): number {
  const parsed = Number(env.GATEWAY_STREAM_IDLE_TIMEOUT_MS ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

// fetch 处:
const controller = new AbortController();
const connectTimer = setTimeout(
  () => controller.abort(new Error("Provider connection timed out before response headers.")),
  streamConnectTimeoutMs(),
);
connectTimer.unref?.();
try {
  response = await (input.fetch ?? globalThis.fetch)(providerUrl, {
    body: /* 原样 */,
    headers: /* 原样 */,
    method: "POST",
    signal: controller.signal,
  });
} catch (err) {
  networkError = err instanceof Error ? err : new Error("Provider network error.");
} finally {
  clearTimeout(connectTimer); // headers 到达后清掉,不影响后续流式 body
}

// readFirstChunkWithTimeout 改名 readChunkWithTimeout(reader, timeoutMs, message),原调用传原消息;
// createReadaheadStream 增加第三参并导出(供单测):
export function createReadaheadStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  firstValue: Uint8Array,
  options: { idleTimeoutMs?: number } = {},
): Readable {
  const idleTimeoutMs = options.idleTimeoutMs ?? streamIdleTimeoutMs();
  async function* pump(): AsyncGenerator<Buffer> {
    yield Buffer.from(firstValue);
    try {
      while (true) {
        const { done, value } = await readChunkWithTimeout(
          reader,
          idleTimeoutMs,
          "Provider stream stalled mid-response.",
        );
        if (done) return;
        if (value) yield Buffer.from(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
  return Readable.from(pump());
}
```

- [ ] **F3.5 背压实现**

```ts
// gateway-streaming.ts — wrapProviderStreamWithActivityCompletion 重写
export function wrapProviderStreamWithActivityCompletion(
  source: Readable,
  input: {
    collectChunk?: (chunk: Buffer | Uint8Array | string) => void;
    completeActivity: (completion: { statusCode: number }) => Promise<void>;
    errorStatusCode?: number;
    statusCode: number;
  },
): Readable {
  const output = new PassThrough();
  let settled = false;

  async function settleActivity(statusCode: number): Promise<void> {
    if (settled) return;
    settled = true;
    await input.completeActivity({ statusCode });
  }

  if (input.collectChunk) {
    // 观察者:pipe 负责流控,此监听只旁路收集,不写 output
    source.on("data", (chunk) => input.collectChunk?.(chunk));
  }
  source.pipe(output, { end: false });
  source.once("end", () => {
    void settleActivity(input.statusCode)
      .catch(() => undefined)
      .finally(() => output.end());
  });
  source.once("error", (error) => {
    void settleActivity(input.errorStatusCode ?? 502)
      .catch(() => undefined)
      .finally(() => {
        output.destroy(error instanceof Error ? error : new Error("Provider stream failed."));
      });
  });
  source.once("close", () => {
    if (settled || source.readableEnded) return;
    void settleActivity(input.errorStatusCode ?? 499)
      .catch(() => undefined)
      .finally(() => output.destroy());
  });
  // 客户端断开 → 反向销毁上游,触发 readahead 的 reader.cancel()
  output.once("close", () => {
    if (!source.readableEnded && !source.destroyed) {
      source.destroy();
    }
  });
  return output;
}
```

- [ ] **F3.6 单测转绿;E2E**:fake-provider 增加「返回 200 后停顿」场景(读 `tests/support/fake-provider.ts` 现有流式实现,加一个由请求头 `x-fake-stall: 1` 触发的分支:发出一个 SSE chunk 后不再发送、不关闭)。E2E 启动 gateway 进程时注入 `GATEWAY_STREAM_IDLE_TIMEOUT_MS=500`,发起 `stream:true` 请求,断言响应流在 ~1s 内以错误终止而非挂起;另一条用例:非流式 + `PROVIDER_REQUEST_TIMEOUT_MS=500` + fake provider 挂起(`x-fake-stall` 在响应 headers 前 sleep),断言 gateway 在 5s 内返回 502。

- [ ] **F3.7 `pnpm run verify` → `pnpm run verify:features` → commit**(`feat(gateway): provider timeouts and stream backpressure`)。

---

## F4 gateway-settlement-integrity — 预算按实际结算 + 并发计数自愈

**目标行为:** (a) finalize 时若有真实 usage,按真实成本入账 `cost_used_usd`/`tokens_used`;(b) reservation TTL 可配(默认 30 分钟);(c) 已被 sweeper 置 `expired` 的 reservation 在流结束时仍把实际成本补记入账(late finalize);(d) 新 worker job 定期把无活动 agent 的 `active_count` 与 `request_activity` 对账,消除 crash 泄漏。

**Files:**
- Modify `packages/db/src/gateway-budgets.ts` — `finalizeGatewayBudgetReservation` 增加 `actual`;`updateGatewayBudgetReservation` 重写;TTL 参数化
- Modify `packages/db/src/gateway-usage-recorder.ts` — 新增 `buildGatewayBudgetActualUsage`
- Modify `packages/db/src/gateway-fallback-chain.ts` — `finalizeAttempt` 回调签名加 `{ body, candidate }`
- Modify `packages/db/src/gateway-chat-completions.ts`、`gateway-embeddings.ts`、`gateway-responses.ts`、`gateway-messages.ts` — finalizeAttempt 回调传实际 usage
- Modify `packages/db/src/gateway-streaming.ts` — 删除 `wrapProviderStreamWithBudgetFinalization`,ok 结果新增 `budgetReservation` 字段(所有权转移给调用方)
- Modify `apps/gateway/src/request-recording.ts` — streaming `completeActivity` 回调内统一结算:成功 finalize(带实际 usage),失败/断开 release
- Create `packages/db/src/worker-stale-concurrency.ts`
- Create `packages/db/migrations/0002_stale_concurrency_job_type.sql` — 重建 `jobs_job_type_check`,追加 `'stale_concurrency_reconcile'`
- Modify `packages/db/src/worker-periodic-scheduler.ts`(union + task 条目,intervalMs 300_000)、`apps/worker/src/main.ts`(注册 handler)
- Test: `tests/features/gateway-settlement-integrity.unit.test.ts`、`tests/e2e/gateway-settlement-integrity.e2e.spec.ts`

- [ ] **F4.1 迁移**

```sql
-- packages/db/migrations/0002_stale_concurrency_job_type.sql
alter table jobs drop constraint jobs_job_type_check;
alter table jobs add constraint jobs_job_type_check check (
  job_type = any (array[
    'model_refresh','provider_connectivity_check','price_sync','billing_reconciliation',
    'retention_cleanup','stale_reservation_cleanup','jsonl_export','cost_report_export',
    'notification_dispatch','webhook_export','backup','budget_threshold_alerts',
    'rate_limit_alerts','provider_failure_alerts','fallback_exhaustion_alerts',
    'stale_concurrency_reconcile'
  ]::text[])
);
```

跑 `pnpm run db:migrate:check` 确认迁移链健康。

- [ ] **F4.2 失败的单元测试**(用 `createTestPostgresFixture` + `runMigrations` 直插数据;关键用例):

```ts
// tests/features/gateway-settlement-integrity.unit.test.ts — 用例清单与核心断言
// 1. finalize with actual:seed budget_periods(reserved_cost_usd=1.00)+ pending reservation(reserved 1.00);
//    finalizeGatewayBudgetReservation({ reservation, actual: { costUsd: 0.02, totalTokens: 300 } })
//    → budget_periods.cost_used_usd = 0.02(不是 1.00),reserved_cost_usd 回到 0,
//      reservation.actual_cost_usd = 0.02, status = 'finalized'
// 2. finalize without actual(usage 缺失)→ 维持旧语义:cost_used_usd += reserved
// 3. late finalize:reservation 先被置 status='expired'(模拟 sweeper),再 finalize with actual
//    → cost_used_usd += 0.02,reserved 不变(sweeper 已减),status='finalized'
// 4. release on expired → no-op
// 5. TTL:GATEWAY_BUDGET_RESERVATION_TTL_SECONDS=60 时 reserveGatewayBudget 写入的
//    expires_at ≈ now()+60s(容差 5s)
// 6. reconcileGatewayConcurrencyWindows:seed concurrency 窗口 active_count=5、updated_at=now()-10min、
//    request_activity 无 started 行 → 对账后 active_count=0;
//    另一窗口 updated_at=now()(活跃)→ 不动
```

- [ ] **F4.3 budgets 实现**

```ts
// gateway-budgets.ts
export type GatewayBudgetActualUsage = { costUsd: number; totalTokens: number };

export async function finalizeGatewayBudgetReservation(input: {
  actual?: GatewayBudgetActualUsage;
  databaseUrl?: string;
  reservation: GatewayBudgetReservation | undefined;
}): Promise<void> {
  if (!input.reservation) return;
  await updateGatewayBudgetReservation(input.databaseUrl, input.reservation, "finalized", input.actual);
}

function readBudgetReservationTtlSeconds(env = process.env): number {
  const parsed = Number(env.GATEWAY_BUDGET_RESERVATION_TTL_SECONDS ?? "");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1_800;
}
// reserveGatewayBudget 的 insert:expires_at 由
//   now() + interval '5 minutes'
// 改为
//   now() + make_interval(secs => $8)   -- 参数 readBudgetReservationTtlSeconds()

async function updateGatewayBudgetReservation(
  databaseUrl: string | undefined,
  reservation: GatewayBudgetReservation,
  status: "finalized" | "released",
  actual?: GatewayBudgetActualUsage,
): Promise<void> {
  await withPostgresTransaction(databaseUrl, async (client) => {
    const result = await client.query<{ status: string }>(
      "select status from budget_reservations where id = $1 for update",
      [reservation.id],
    );
    const currentStatus = result.rows[0]?.status;
    const chargeTokens = actual?.totalTokens ?? reservation.reservedTotalTokens;
    const chargeCostUsd = actual?.costUsd ?? reservation.reservedCostUsd;

    if (currentStatus === "pending") {
      if (status === "finalized") {
        await client.query(
          `update budget_periods
           set tokens_used = tokens_used + $1,
               cost_used_usd = cost_used_usd + $2,
               reserved_tokens = greatest(reserved_tokens - $3, 0),
               reserved_cost_usd = greatest(reserved_cost_usd - $4, 0),
               updated_at = now()
           where id = $5`,
          [chargeTokens, chargeCostUsd, reservation.reservedTotalTokens,
           reservation.reservedCostUsd, reservation.budgetPeriodId],
        );
      } else {
        await client.query(
          `update budget_periods
           set reserved_tokens = greatest(reserved_tokens - $1, 0),
               reserved_cost_usd = greatest(reserved_cost_usd - $2, 0),
               updated_at = now()
           where id = $3`,
          [reservation.reservedTotalTokens, reservation.reservedCostUsd, reservation.budgetPeriodId],
        );
      }
    } else if (
      (currentStatus === "expired" || currentStatus === "released") &&
      status === "finalized" &&
      actual
    ) {
      // sweeper 已退还 reserved;真实成本仍须入账(长流 >TTL 的场景)
      await client.query(
        `update budget_periods
         set tokens_used = tokens_used + $1,
             cost_used_usd = cost_used_usd + $2,
             updated_at = now()
         where id = $3`,
        [actual.totalTokens, actual.costUsd, reservation.budgetPeriodId],
      );
    } else {
      return; // 已终态且无补账需求
    }

    await client.query(
      `update budget_reservations
       set status = $2,
           actual_total_tokens = $3,
           actual_cost_usd = $4,
           finalized_at = case when $2 = 'finalized' then now() else finalized_at end,
           updated_at = now()
       where id = $1`,
      [reservation.id, status, chargeTokens, chargeCostUsd],
    );
  });
}
```

- [ ] **F4.4 实际用量换算 + 调用方接线**

```ts
// gateway-usage-recorder.ts 追加
export function buildGatewayBudgetActualUsage(input: {
  price: ModelTokenPrice;
  providerUsage: GatewayProviderTokenUsage | undefined;
}): GatewayBudgetActualUsage | undefined {
  if (!input.providerUsage) return undefined;
  const cost = calculateTokenCostUsd(input.price, {
    cachedInputTokens: input.providerUsage.cachedInputTokens,
    inputTokens: input.providerUsage.inputTokens,
    outputTokens: input.providerUsage.outputTokens,
  });
  if (cost.status !== "estimated") return undefined;
  return {
    costUsd: cost.totalCostUsd,
    totalTokens: input.providerUsage.inputTokens + input.providerUsage.outputTokens,
  };
}
```

```ts
// gateway-fallback-chain.ts:finalizeAttempt 签名改为
finalizeAttempt?: (
  reservation: GatewayBudgetReservation | undefined,
  success: { body: unknown; candidate: FallbackChainCandidate },
) => Promise<void>;
// executeProviderFallbackAttempts 成功分支:
await input.finalizeAttempt?.(reservation, { body: result.body, candidate });

// 四个非流式端点的调用处统一改为:
finalizeAttempt: (reservation, success) =>
  finalizeGatewayBudgetReservation({
    databaseUrl: input.databaseUrl,
    reservation,
    actual: buildGatewayBudgetActualUsage({
      price: success.candidate.price,
      providerUsage: readGatewayProviderTokenUsage(success.body),
    }),
  }),
```

流式所有权转移:`executeGatewayStreamingRequest` 成功分支不再包 `wrapProviderStreamWithBudgetFinalization`(整个函数删除),ok 结果加 `budgetReservation: GatewayBudgetReservation | undefined`;构造结果后再置 `currentReservation = undefined`(外层 catch 兜底语义不变)。`request-recording.ts` 的 streaming `completeActivity` 回调:

```ts
completeActivity: async ({ statusCode }) => {
  const providerUsage = usageCollector.readUsage();
  try {
    if (statusCode < 400) {
      await finalizeGatewayBudgetReservation({
        reservation: response.budgetReservation,
        actual: response.usageCost
          ? buildGatewayBudgetActualUsage({ price: response.usageCost.actualPrice, providerUsage })
          : undefined,
      });
    } else {
      await releaseGatewayBudgetReservation({ reservation: response.budgetReservation });
    }
    if (response.usageCost) { /* 原 recordGatewayUsageCostAndSavings 逻辑不变 */ }
  } catch (error) {
    input.logger.error({ err: error, requestId: input.requestId }, "gateway stream settlement failed");
  } finally {
    /* 原 completeGatewayRequestActivity,按 F2 已是 try/catch */
  }
},
```

- [ ] **F4.5 并发对账 worker**

```ts
// packages/db/src/worker-stale-concurrency.ts
import { getPostgresPool } from "@llmingress/db/client";

export type StaleConcurrencyReconcileResult = { reconciledWindowCount: number };

export async function reconcileGatewayConcurrencyWindows(input: {
  databaseUrl?: string;
  inFlightMaxAgeMinutes?: number;
  quietMinutes?: number;
} = {}): Promise<StaleConcurrencyReconcileResult> {
  const inFlightMaxAge = input.inFlightMaxAgeMinutes ?? 15;
  const quiet = input.quietMinutes ?? 5;
  const result = await getPostgresPool(input.databaseUrl).query(
    `
      update rate_limit_windows w
      set active_count = live.n,
          updated_at = now()
      from (
        select w2.id,
               (
                 select count(*)::int
                 from request_activity ra
                 where ra.agent_id = w2.agent_id
                   and ra.status = 'started'
                   and ra.started_at > now() - make_interval(mins => $1)
               ) as n
        from rate_limit_windows w2
        where w2.limit_type = 'concurrency'
          and w2.updated_at < now() - make_interval(mins => $2)
      ) live
      where w.id = live.id
        and w.active_count <> live.n
    `,
    [inFlightMaxAge, quiet],
  );
  return { reconciledWindowCount: result.rowCount ?? 0 };
}

export function createStaleConcurrencyReconcileJobHandler(
  options: { databaseUrl?: string } = {},
): () => Promise<StaleConcurrencyReconcileResult> {
  return () => reconcileGatewayConcurrencyWindows(options);
}
```

注册:`worker-periodic-scheduler.ts` 的 jobType union 加 `"stale_concurrency_reconcile"`,tasks 数组加 `{ id: "stale-concurrency-reconcile", intervalMs: 300_000, jobType: "stale_concurrency_reconcile", maxAttempts: 1, payload: {}, priority: 0, startAt: new Date(0) }`;`apps/worker/src/main.ts` handlers 加一行。`quiet` 窗口保证活跃 agent(5 分钟内有 increment/release 更新)不会被对账误伤;正在飞行且超过 15 分钟的请求会被暂时低估,由下一次真实 release 的 `greatest(active_count-1,0)` 兜底——在 ARCHITECTURE.md 记录该取舍。

- [ ] **F4.6 单测转绿;E2E**:流式场景——fake provider 返回带 `usage` 的 SSE 流,gateway 环境注入小额 budget limit + `GATEWAY_BUDGET_RESERVATION_TTL_SECONDS=1`;请求完成后断言 `budget_periods.cost_used_usd` 等于**实际** usage 计算的成本(而非 reserved),且 sweeper 先行过期的情况下(测试里手动把 reservation 置 `expired` 再等流结束)成本仍入账。

- [ ] **F4.7 `pnpm run db:migrate:check` → `pnpm run verify` → `pnpm run verify:features` → commit**(`feat(gateway): settle budgets with actual usage and reconcile concurrency`)。

---

## F5 gateway-error-fidelity — 类型化错误与上游状态透传

**目标行为:** (a) 网关内部错误分类不再依赖字符串匹配;(b) provider 非重试 4xx(除 429)把净化后的错误消息与原状态码透传给 agent(错误码 `provider_rejected_request`);(c) 任一 fallback 候选缺凭证只跳过该候选;(d) 流式路径按 provider 多 key 依次尝试,与非流式一致。

**Files:**
- Create `packages/db/src/gateway-errors.ts`
- Modify `packages/db/src/gateway-error-mapping.ts` — 映射表加 `provider_rejected_request: 502`(仅作 upstreamStatus 缺失时的后备)
- Modify `packages/db/src/gateway-runtime-helpers.ts` — `requireGatewayRoutePolicy` 抛类型化错误
- Modify `packages/db/src/gateway-fallback-chain.ts` — 链耗尽时抛类型化错误(区分 4xx/429/其他)
- Modify `packages/db/src/gateway-chat-completions.ts` — 新增 `attachGatewayProviderCredentialsLeniently`;catch 分支改用 `toGatewayErrorResponseParts`;`createGatewayChatCompletionErrorBody` 支持 message 覆盖
- Modify `packages/db/src/gateway-embeddings.ts`、`gateway-responses.ts`、`gateway-messages.ts` — 换用 lenient 凭证 + 类型化 catch(与 chat 同构)
- Modify `packages/db/src/gateway-streaming.ts` — 删除 `classifyStreamingError` 字符串匹配;非重试 4xx 分支返回 `response.status` + 截断的 provider 消息;候选内加 key 循环
- Test: `tests/features/gateway-error-fidelity.unit.test.ts`、`tests/e2e/gateway-error-fidelity.e2e.spec.ts`

- [ ] **F5.1 失败的单元测试**(核心用例):

```ts
// tests/features/gateway-error-fidelity.unit.test.ts — 用例清单
// 1. executeFallbackChain:单候选 adapter 返回 {ok:false,statusCode:400,errorMessage:"context length exceeded",retryable:false}
//    → 抛 GatewayPipelineError{ code:"provider_rejected_request", upstreamStatus:400, message 含 "context length" }
// 2. 同上 statusCode:429 → code:"provider_rate_limited", upstreamStatus:429
// 3. 网络错误(statusCode:null)两候选全败 → code:"provider_request_failed", upstreamStatus:null
// 4. toGatewayErrorResponseParts(new Error("x"), "provider_request_failed") → {code:"provider_request_failed", statusCode:502}
// 5. attachGatewayProviderCredentialsLeniently(DB fixture):两 provider,一个无 key 行
//    → 返回 1 个候选 + skipped:1,不抛错;两个都缺 → 抛 provider_credentials_missing
// 6. truncateProviderMessage:2KB 输入 → ≤500 字符且无控制字符
// 7. 流式多 key:readFallbackProviderApiKeys 已覆盖(现有),新增:streaming 循环对
//    providerApiKeys=[k1,k2] 的候选,k1 fetch 返回 500 时用 k2 重试(fetch spy 断言两次调用、
//    authorization 头不同)
```

- [ ] **F5.2 gateway-errors.ts 实现**

```ts
// packages/db/src/gateway-errors.ts
import { mapGatewayErrorStatus } from "./gateway-error-mapping.ts";

export class GatewayPipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly upstreamStatus: number | null = null,
  ) {
    super(message);
    this.name = "GatewayPipelineError";
  }
}

export function toGatewayErrorResponseParts(
  error: unknown,
  fallbackCode: string,
): { code: string; message: string | undefined; statusCode: number } {
  if (error instanceof GatewayPipelineError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.upstreamStatus ?? mapGatewayErrorStatus(error.code),
    };
  }
  return { code: fallbackCode, message: undefined, statusCode: mapGatewayErrorStatus(fallbackCode) };
}

export function truncateProviderMessage(message: string, maxLength = 500): string {
  return message.replaceAll(/[\u0000-\u001f\u007f]/g, " ").slice(0, maxLength).trim();
}
```

- [ ] **F5.3 链耗尽 + throw 站点改造**

```ts
// gateway-fallback-chain.ts — executeFallbackChain 末尾替换 throw new Error(...):
const status = lastError?.statusCode ?? null;
if (status !== null && status >= 400 && status < 500 && status !== 429) {
  throw new GatewayPipelineError(
    "provider_rejected_request",
    truncateProviderMessage(lastError?.errorMessage ?? "Provider rejected the request."),
    status,
  );
}
if (status === 429) {
  throw new GatewayPipelineError("provider_rate_limited", "Provider rate limit exceeded.", 429);
}
throw new GatewayPipelineError(
  "provider_request_failed",
  lastError?.errorMessage ?? "All fallback candidates failed.",
);
```

其余 throw 站点:`requireGatewayRoutePolicy` → `new GatewayPipelineError("route_not_found", ...)`;`attachGatewayProviderCredentials` 内两处 → `new GatewayPipelineError("provider_credentials_missing", ...)`;chat-completions 里 `"Provider credentials are missing for chat completions route."` → 同上。四个端点 + streaming 的 `classify*Error(message)` 删除,catch 改:

```ts
} catch (error) {
  if (error instanceof GatewayBudgetRejectedError) { /* 原样 */ }
  const parts = toGatewayErrorResponseParts(error, "provider_request_failed");
  return {
    activity,
    body: createGatewayChatCompletionErrorBody(
      parts.code as GatewayChatCompletionErrorCode,
      input.requestId,
      parts.message,
    ),
    requestMetadata,
    statusCode: parts.statusCode,
  };
}
// createGatewayChatCompletionErrorBody(code, requestId, message = chatCompletionErrorMessage(code))
// 错误码 union 各端点补 "provider_rejected_request" | "provider_rate_limited"
```

- [ ] **F5.4 lenient 凭证**

```ts
// gateway-chat-completions.ts 追加
export async function attachGatewayProviderCredentialsLeniently(input: {
  candidates: readonly GatewayRouteCandidateSnapshot[];
  databaseUrl?: string;
  masterKeySource: MasterKeySource;
}): Promise<FallbackChainCandidate[]> {
  const attached: FallbackChainCandidate[] = [];
  for (const candidate of input.candidates) {
    try {
      attached.push(
        ...(await attachGatewayProviderCredentials({ ...input, candidates: [candidate] })),
      );
    } catch {
      // 该候选缺凭证/缺 base URL:跳过,让链条继续(与流式路径 FIX C5 语义一致)
    }
  }
  if (attached.length === 0) {
    throw new GatewayPipelineError(
      "provider_credentials_missing",
      "Provider credentials are not configured for any candidate on the selected route.",
    );
  }
  return attached;
}
```

四个非流式端点把 `attachGatewayProviderCredentials(...)` 调用替换为 lenient 版。流式路径已是逐候选,不动。

- [ ] **F5.5 流式多 key 循环**:`executeGatewayStreamingRequest` 内把「reserve → fetch → 判定」块包进 `for (const providerApiKey of readFallbackProviderApiKeys(candidate))`,块内 `candidate.apiKey` 全部替换为 `providerApiKey.apiKey`、`candidate.providerApiKeyId/Prefix` 替换为 `providerApiKey.providerApiKeyId/keyPrefix`(构造 headers、failedAttempt、`recordSucceededAttemptInDatabase`、`recordGatewayProviderApiKeyLastUsed`、activity route 同步替换);key 尝试失败且 retryable → `continue`(下一个 key),非重试 → 保持现有「终止整链」语义;每次 key 尝试独立 reserve/release 预算(与非流式 `executeProviderFallbackAttempts` 的 key 循环对齐)。

- [ ] **F5.6 流式非重试 4xx 透传**:`!response.ok` 分支的非重试 return 改为

```ts
return {
  body: createGatewayStreamingErrorBody(
    errorCode,
    input.requestId,
    truncateProviderMessage(providerErrorBody ?? "Provider rejected the request."),
  ),
  ok: false,
  requestMetadata: normalized.requestMetadata,
  statusCode: response.status,
};
```

- [ ] **F5.7 单测转绿;E2E**:fake provider 增加「400 + JSON error message」场景(如 `x-fake-status: 400`),断言 agent 侧收到 status 400、`error.code === "provider_rejected_request"`、message 含 provider 原文;另一条:两 provider 候选、主候选无 `provider_api_keys` 行,请求仍 200(lenient 凭证走通 fallback)。

- [ ] **F5.8 `pnpm run verify` → `pnpm run verify:features` → commit**(`feat(gateway): typed errors and provider status passthrough`)。

---

## F6 gateway-request-hygiene — 输入面与杂项加固

**目标行为清单(每条一个可断言测试):**
1. `bodyLimit` 可配(`GATEWAY_BODY_LIMIT_BYTES`,默认 10 MiB),2 MB 请求不再 413。
2. 客户端 `x-request-id` 仅接受 `^[A-Za-z0-9._:-]{1,128}$`,否则改用服务端生成。
3. `selectGatewayBaselineCandidate` 不再原地 sort 共享快照。
4. CJK 文本 token 估算按「CJK 字符=1 token,其余 4 字符=1 token」。
5. `GATEWAY_METRICS_TOKEN` 设置时 `/metrics` 需 `Bearer` 匹配,否则 401。
6. chat completions 白名单透传 `frequency_penalty/logprobs/top_logprobs/parallel_tool_calls/presence_penalty/response_format/seed/stop/top_p/user`,并接受 `max_completion_tokens` 作为 `max_tokens` 同义词(两者同传时取 `max_completion_tokens`)。
7. OAuth token 刷新在 `provider_oauth` 行锁内单飞,双并发只刷一次。

**Files:**
- Modify `apps/gateway/src/main.ts` — Fastify `bodyLimit`;`/metrics` token 校验
- Modify `packages/db/src/gateway-auth.ts` — `readGatewayRequestId` 校验
- Modify `packages/db/src/gateway-usage-recorder.ts` — `[...routePolicy.candidates].sort(...)`
- Modify `packages/db/src/gateway-request-metadata.ts` — `estimateTextTokens`
- Modify `packages/db/src/gateway-chat-completions.ts` — normalize 透传 + `max_completion_tokens`;OAuth 刷新单飞(`refreshProviderOAuthTokenWithLock`)
- Modify `packages/provider/src/adapters/openai.ts` — `buildChatCompletionsPayload` 展开 passthrough
- Modify `packages/db/src/gateway-streaming.ts` — `buildStreamingPayload` chat 分支展开 passthrough
- Modify `docs/ARCHITECTURE.md` — 决策同步(见 F6.6)
- Test: `tests/features/gateway-request-hygiene.unit.test.ts`、`tests/e2e/gateway-request-hygiene.e2e.spec.ts`

- [ ] **F6.1 失败的单元测试**(逐条对应上面 1–7;关键代码):

```ts
// 4. CJK 估算
expect(estimateTextTokens(["你好世界"])).toBe(4);        // 旧实现 = 1
expect(estimateTextTokens(["abcdefgh"])).toBe(2);
expect(estimateTextTokens(["你好ab"])).toBe(3);          // 2 CJK + ceil(2/4)

// 6. 参数透传
const normalized = normalizeOpenAIChatCompletionRequest(
  { max_completion_tokens: 2048, messages: [{ content: "hi", role: "user" }],
    seed: 7, stop: ["END"], top_p: 0.9 },
  "req-1",
);
expect(normalized.ok).toBe(true);
if (normalized.ok) {
  expect(normalized.request.maxOutputTokens).toBe(2048);
  expect(normalized.request.passthrough).toEqual({ seed: 7, stop: ["END"], top_p: 0.9 });
}

// 2. request id 校验
expect(readGatewayRequestId({ "x-request-id": "abc-123" })).toBe("abc-123");
expect(readGatewayRequestId({ "x-request-id": "bad id\n" })).toMatch(/^gw_/);
expect(readGatewayRequestId({ "x-request-id": "x".repeat(200) })).toMatch(/^gw_/);

// 7. OAuth 单飞(DB fixture):seed 过期 token;refresh 注入 spy;
//    Promise.all 两次 refreshProviderOAuthTokenWithLock → spy 恰好 1 次,两个调用都拿到新 token
```

- [ ] **F6.2 实现(1–5)**

```ts
// main.ts
const app = Fastify({
  bodyLimit: readNonNegativeIntegerEnv("GATEWAY_BODY_LIMIT_BYTES", 10_485_760),
  logger: true,
});

app.get("/metrics", async (request, reply) => {
  const requiredToken = process.env.GATEWAY_METRICS_TOKEN?.trim();
  if (requiredToken) {
    const header = firstRequestHeaderValue(request.headers.authorization);
    if (header !== `Bearer ${requiredToken}`) {
      return reply.code(401).send({ error: { code: "unauthorized_metrics_access" } });
    }
  }
  const document = await getPrometheusMetricsDocument({});
  return reply.header("content-type", document.contentType).send(document.body);
});
```

```ts
// gateway-auth.ts
const gatewayRequestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;
function readGatewayRequestId(headers: GatewayAuthHeaders): string {
  const value = firstHeaderValue(headers["x-request-id"])?.trim();
  return value && gatewayRequestIdPattern.test(value) ? value : `gw_${randomUUID()}`;
}
```

```ts
// gateway-usage-recorder.ts — selectGatewayBaselineCandidate
const candidate = [...routePolicy.candidates].sort(
  (left, right) => left.candidateOrder - right.candidateOrder,
)[0];
```

```ts
// gateway-request-metadata.ts
const cjkPattern = /[ᄀ-ᇿ⺀-꓏가-힣豈-﫿︰-﹏＀-￯]/;
function estimateTextTokens(parts: readonly string[]): number {
  const text = parts.filter((part) => part.trim()).join("\n");
  let cjkCount = 0;
  for (const character of text) {
    if (cjkPattern.test(character)) cjkCount += 1;
  }
  return Math.max(1, cjkCount + Math.ceil((text.length - cjkCount) / 4));
}
```

- [ ] **F6.3 参数透传(6)**

```ts
// gateway-chat-completions.ts
const chatPassthroughParameterKeys = [
  "frequency_penalty", "logprobs", "parallel_tool_calls", "presence_penalty",
  "response_format", "seed", "stop", "top_logprobs", "top_p", "user",
] as const;

// normalizeOpenAIChatCompletionRequest 内:
const maxOutputTokens = readOptionalPositiveInteger(
  body.max_completion_tokens ?? body.max_tokens,
);
// …
const passthrough: Record<string, unknown> = {};
for (const key of chatPassthroughParameterKeys) {
  if (body[key] !== undefined) passthrough[key] = body[key];
}
return {
  ok: true,
  request: omitUndefined({
    /* 原字段 */,
    passthrough: Object.keys(passthrough).length > 0 ? passthrough : undefined,
  }),
};
// NormalizedOpenAIChatRequest(packages/provider/src/adapters/openai.ts)加
//   passthrough?: Record<string, unknown>;
// buildChatCompletionsPayload / buildStreamingPayload 的 chat 分支:
return omitUndefined({ ...request.passthrough, max_tokens: ..., /* 已知字段照旧,后铺保证已知字段优先 */ });
```

- [ ] **F6.4 OAuth 单飞(7)**

```ts
// gateway-chat-completions.ts — readProviderCredentials 的过期分支替换为:
if (isProviderOAuthTokenExpired(token)) {
  if (!token.refreshToken) continue;
  token = await refreshProviderOAuthTokenWithLock({
    databaseUrl: input.databaseUrl,
    encryption,
    providerKey: provider.provider_key,
    providerOAuthId: connection.id,
    refresh: refreshProviderOAuthToken,
  });
}

export async function refreshProviderOAuthTokenWithLock(input: {
  databaseUrl?: string;
  encryption: ReturnType<typeof createSecretEncryption>;
  providerKey: string;
  providerOAuthId: string;
  refresh: typeof refreshProviderOAuthToken; // 注入点,便于单测
}): Promise<ProviderOAuthTokenBlob> {
  return withPostgresTransaction(input.databaseUrl, async (client) => {
    const row = await client.query<{ encrypted_token: unknown }>(
      "select encrypted_token from provider_oauth where id = $1 for update",
      [input.providerOAuthId],
    );
    const current = readProviderOAuthTokenBlob(
      input.encryption.decrypt(readEncryptedSecret(row.rows[0]?.encrypted_token)),
    );
    if (!isProviderOAuthTokenExpired(current)) {
      return current; // 并发对手已刷新:行锁保证单飞
    }
    if (!current.refreshToken) {
      throw new GatewayPipelineError(
        "provider_credentials_missing",
        "Provider OAuth token expired without a refresh token.",
      );
    }
    const refreshed = await input.refresh({
      providerKey: input.providerKey,
      refreshToken: current.refreshToken,
    });
    await client.query(
      `update provider_oauth
       set encrypted_token = $2,
           token_expires_at = $3,
           updated_at = now()
       where id = $1`,
      [
        input.providerOAuthId,
        JSON.stringify(input.encryption.encrypt(JSON.stringify(refreshed))),
        refreshed.expiresAt === null ? null : new Date(refreshed.expiresAt),
      ],
    );
    return refreshed;
  });
}
```

> 注意:锁内做外部 HTTP 刷新,行锁 + 一个池连接会被占用至刷新完成——这正是单飞语义,但要在 refresh 调用上依赖 F3 的超时(`refreshProviderOAuthToken` 若无超时,执行时给它加 `AbortSignal.timeout(30_000)`)。`encrypted_token` 的存储编码(直接 jsonb 还是 `JSON.stringify`)以 `completeProviderOAuthConnection`(providers.ts:199)现有写法为准,保持一致。

- [ ] **F6.5 E2E**:2 MB messages 请求 → 200(bodyLimit);`stop`/`seed` 透传 → fake provider 捕获的请求体里存在;`GATEWAY_METRICS_TOKEN` 注入后无 token 访问 `/metrics` → 401。

- [ ] **F6.6 文档同步(docs/ARCHITECTURE.md)**:追加/修订决策条目——预算按实际 usage 结算与 late-finalize 语义;reservation TTL 默认 30 分钟;`stale_concurrency_reconcile` job 与其低估取舍;chat completions 参数白名单透传集与「多模态显式 400、TPM 保持估算语义」两个非目标;修订 1017 行附近的包边界描述,写明「Gateway 运行时领域模块现阶段以 `gateway-*` 前缀集中于 `packages/db`,`packages/routing` 尚不存在;拆包另立方案」。

- [ ] **F6.7 `pnpm run verify` → `pnpm run verify:features` → commit**(`feat(gateway): request hygiene and oauth refresh single-flight`)。

---

## 收尾

- [ ] `feature_list.json` 六条全部 `passing`,`evidence` 记录日期与验证输出要点。
- [ ] `progress.md` 追加本次会话小节:完成的 feature、遗留风险(至少记:流式/非流式 provider 调用仍是双实现,完整统一未做;`console-*`/`worker-*` 未池化)。
- [ ] 全量 `pnpm run db:migrate:check && pnpm run verify && pnpm run verify:features`。
- [ ] 分支处于可 PR 状态(六个 feature commit + 文档 commit)。

## 附录 A — feature_list.json 新条目

```json
[
  {
    "id": "gateway-db-pool",
    "name": "Gateway Postgres Connection Pool",
    "description": "Gateway request-path database access goes through a process-level pg.Pool: a 30-request burst against a running gateway keeps total postgres connections bounded by the pool max instead of opening connections per query, and pools close on app shutdown.",
    "verification": "pnpm exec vitest run tests/features/gateway-db-pool.unit.test.ts && pnpm test:e2e tests/e2e/gateway-db-pool.e2e.spec.ts",
    "dependencies": ["v1-gateway-routing"],
    "status": "failing",
    "evidence": ""
  },
  {
    "id": "gateway-recording-resilience",
    "name": "Gateway Recording Resilience",
    "description": "A running gateway still returns the LLM response with HTTP 200 when activity/usage/trace recording writes fail (up to the request_activity table being dropped), logging failures at error level instead of failing the agent request.",
    "verification": "pnpm exec vitest run tests/features/gateway-recording-resilience.unit.test.ts && pnpm test:e2e tests/e2e/gateway-recording-resilience.e2e.spec.ts",
    "dependencies": ["gateway-db-pool"],
    "status": "failing",
    "evidence": ""
  },
  {
    "id": "gateway-stream-robustness",
    "name": "Gateway Stream Robustness",
    "description": "Provider calls time out (non-streaming request timeout; streaming connect, first-chunk, and mid-stream idle timeouts) against a running gateway with a stalling fake provider, slow clients cause bounded buffering via pipe backpressure, and client disconnects cancel the upstream provider stream.",
    "verification": "pnpm exec vitest run tests/features/gateway-stream-robustness.unit.test.ts && pnpm test:e2e tests/e2e/gateway-stream-robustness.e2e.spec.ts",
    "dependencies": ["gateway-db-pool"],
    "status": "failing",
    "evidence": ""
  },
  {
    "id": "gateway-settlement-integrity",
    "name": "Gateway Settlement Integrity",
    "description": "Budget finalization charges actual provider usage when available (falling back to reserved estimates), reservations carry a configurable TTL, streams outliving the TTL still settle their actual cost after sweeper expiry, and a periodic worker job reconciles leaked concurrency counters from request_activity.",
    "verification": "pnpm exec vitest run tests/features/gateway-settlement-integrity.unit.test.ts && pnpm test:e2e tests/e2e/gateway-settlement-integrity.e2e.spec.ts",
    "dependencies": ["gateway-db-pool", "gateway-recording-resilience"],
    "status": "failing",
    "evidence": ""
  },
  {
    "id": "gateway-error-fidelity",
    "name": "Gateway Error Fidelity",
    "description": "Gateway error handling is typed instead of string-matched, non-retryable provider 4xx responses pass through sanitized provider messages with the upstream status code to the agent, a fallback candidate with missing credentials is skipped instead of failing the request, and streaming attempts iterate provider API keys like the non-streaming chain.",
    "verification": "pnpm exec vitest run tests/features/gateway-error-fidelity.unit.test.ts && pnpm test:e2e tests/e2e/gateway-error-fidelity.e2e.spec.ts",
    "dependencies": ["gateway-stream-robustness"],
    "status": "failing",
    "evidence": ""
  },
  {
    "id": "gateway-request-hygiene",
    "name": "Gateway Request Hygiene",
    "description": "A running gateway accepts 2MB chat bodies under a configurable body limit, rejects malformed client x-request-id values, estimates CJK tokens realistically, protects /metrics behind an optional bearer token, passes whitelisted OpenAI chat parameters (including max_completion_tokens) through to providers, and refreshes provider OAuth tokens under a row lock so concurrent requests refresh exactly once.",
    "verification": "pnpm exec vitest run tests/features/gateway-request-hygiene.unit.test.ts && pnpm test:e2e tests/e2e/gateway-request-hygiene.e2e.spec.ts",
    "dependencies": ["gateway-db-pool", "gateway-error-fidelity"],
    "status": "failing",
    "evidence": ""
  }
]
```
