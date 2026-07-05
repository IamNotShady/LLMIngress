# 表结构过度设计改造实现方案

版本：v2（详细实现规格）。状态：**0004-0006 与文档对齐已实施；0007 待产品决策**。迁移编号按执行顺序分配。

## 1. 背景与结论

对 `packages/db/migrations/0001_v1_baseline.sql`（30 表 / 45 索引）逐表对照 `packages/db/src/` 全部读写代码审核，结论：

- 无死表；`budget_reservations` 已由 0003 迁移删除（两阶段预算预留被证实为超前设计）。
- 确认 4 处过度设计/冗余（本方案改造 1–4）+ 1 处文档漂移（改造 5）。
- 豁免项（审核后明确不改）：`request_usage`/`request_costs` 1:1 拆表（单点写入 `gateway-usage-recorder.ts:60,91`，文档明确审计定位）、`request_activity` 7 个快照列 + 5 张配置表软删 + restrictive FK 的三重历史保护（有意设计）、`provider_health_events`+`provider_health_summary`（事件+汇总双表均有读者）、`job_attempts`（`gateway-metrics.ts:209` 聚合读取）、`provider_models` 12 个价格扁平列（比独立价格表更简单）、索引规模。

## 2. 通用实施协议

每项改造 = 一个独立 feature，按 AGENTS.md 流程：

1. `feature_list.json` 登记条目（草案见各节），初始 `status: "failing"`
2. 先创建失败测试（各节附完整用例规格），运行确认按预期失败（RED）
3. 实现迁移 + 代码变更（GREEN）
4. `pnpm run verify` → `pnpm run verify:features`（`TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/postgres`）
5. 更新 `progress.md`、本文档进度表、feature 置 `passing` 并记录 evidence，提交后再开下一项

新迁移登记步骤（每个迁移都要做）：

1. 新建 `packages/db/migrations/000N_<name>.sql`（文件名须匹配 `/^\d{4,}_[a-z0-9][a-z0-9_]*\.sql$/`）
2. `shasum -a 256 packages/db/migrations/000N_<name>.sql` 取 checksum
3. `packages/db/src/migration-status.ts` 的 `shippedSqlMigrations` 追加 `{ id, name, checksum }`
4. 更新 `tests/features/v1-platform.unit.test.ts` 的清单断言（"keeps the migration manifest aligned with loaded SQL"，当前硬编码 0001–0003 列表）——否则 verify:features 必红

## 3. 实施顺序与进度

| 顺序 | 改造项 | 迁移 | 进度 |
| --- | --- | --- | --- |
| 1 | 改造3：放宽产品词表 CHECK | 0004_relax_vocab_checks | ✅ |
| 2 | 改造2：删除只写表 notification_deliveries | 0005_drop_notification_deliveries | ✅ |
| 3 | 改造1：fallback 收敛到 fallback_events | 0006_fallback_single_source | ✅ |
| 4 | 改造4：并发计数出库（**待决策**） | 0007_drop_concurrency_windows | ⬜ |
| 5 | 改造5：ARCHITECTURE.md 对齐（当前 schema） | — | ✅ |

顺序理由：0004/0005 只删约束/删无读表，风险最低；0006 删列不可逆、涉及 5 个文件的读者迁移，放后；0007 依赖用户决策。

---

## 4. 改造 3：放宽产品词表 CHECK 约束（0004）

### 问题

三个 CHECK 把易变的产品词表焊进 DB，每次扩充词表都需要一次迁移：

- `jobs_job_type_check`（15 个任务类型）——已在 0002、0003 两次被整体 drop/重建
- `agents_agent_type_check` 不动（机器状态类）；`agents_integration_platform_check`（8 个平台名）
- `providers_template_id_whitelisted`（13 个模板名，`NOT VALID`）

### 迁移 0004_relax_vocab_checks.sql（完整内容）

```sql
alter table jobs drop constraint if exists jobs_job_type_check;

alter table agents drop constraint if exists agents_integration_platform_check;

alter table providers drop constraint if exists providers_template_id_whitelisted;
```

**保留**全部机器状态类约束：`jobs_status_check`、`jobs_trigger_check`、`agents_agent_type_check`、`agent_limits_*`、各表 `status`/`enforcement_policy`/数值范围 CHECK 一律不动。

### 应用层防线（均已存在，实现时逐一确认，缺哪补哪）

| 词表 | 防线位置 | 行为 |
| --- | --- | --- |
| integration_platform | `packages/db/src/console-agents.ts:162`（`normalizeAgentFormInput` → `isAgentIntegrationPlatform`，词表常量 `agentIntegrationPlatforms` 同文件 :17） | 非法值 throw "Agent integration platform must be ..." |
| provider_template_id | `packages/db/src/console-provider-templates.ts:284-338`（`getOpenAICompatibleProviderTemplate` 等 6 个 getter） | 未知模板 key throw "Provider must use a whitelisted provider template." |
| job_type | 创建侧只用常量（`provider-jobs.ts`、`worker-periodic-scheduler.ts`）；执行侧 `worker-job-runner.ts:171-176` 未注册类型记 `job_handler_missing` 失败 | 未知类型不会被执行 |

### 代码变更清单

| 文件 | 变更 |
| --- | --- |
| `packages/db/migrations/0004_relax_vocab_checks.sql` | 新建（上述 SQL） |
| `packages/db/src/migration-status.ts` | `shippedSqlMigrations` 追加 0004 条目 |
| `tests/features/v1-platform.unit.test.ts` | 清单断言追加 `{ id: "0004", name: "relax_vocab_checks" }` |
| `tests/features/schema-vocab-checks.unit.test.ts` | 新建（用例见下） |

### 测试用例规格（`tests/features/schema-vocab-checks.unit.test.ts`）

复用既有 fixture 惯例（参照 `tests/features/gateway-settlement-integrity.unit.test.ts:175` 的 `withMigratedFixture`：`createTestPostgresFixture` + `runMigrations`）：

1. `accepts a job_type outside the current vocabulary` —— `insert into jobs (id, job_type, status, trigger) values ($1, 'future_job_type', 'pending', 'manual')` 应成功。**RED 时因 CHECK 违例失败**
2. `accepts an agent integration_platform outside the current vocabulary` —— `insert into agents (id, name, agent_type, integration_platform) values ($1, 'Vocab Agent', 'coding', 'future-platform')` 应成功。**RED 失败**
3. `accepts a provider_template_id outside the current whitelist` —— `insert into providers (id, provider_type, provider_key, display_name, provider_template_id) values ($1, 'api_key', 'future-provider', 'Future Provider', 'future_template')` 应成功。**RED 失败**
4. `still rejects invalid machine states at the database level` —— `status='bogus_status'` 插入 jobs 应被 `jobs_status_check` 拒绝（防过删守护，改造前后都绿）
5. `keeps application-layer vocabulary validation as the write-path defense` —— `normalizeAgentFormInput` 对非法平台 throw；`getOpenAICompatibleProviderTemplate('future_template')` throw（守护用例）

### feature_list.json 条目草案

```json
{
  "id": "schema-vocab-checks-relaxed",
  "name": "Schema Vocab Checks Relaxed",
  "description": "Product vocabulary values (job_type, agent integration_platform, provider_template_id) are validated only at the application layer; the database accepts values outside today's vocabulary while machine-state CHECK constraints (status, trigger, agent_type, numeric ranges) remain enforced.",
  "verification": "pnpm exec vitest run tests/features/schema-vocab-checks.unit.test.ts",
  "dependencies": ["v1-platform"],
  "status": "failing",
  "evidence": ""
}
```

### 风险与回滚

- 无数据变更，可逆：回滚 = 重新 `add constraint ... check (...) not valid` 后 `validate constraint`。
- 词表校验少了 DB 兜底层；直连 DB 的手工写入不再被拦截（接受：Console/Worker 是唯一写入方）。

---

## 5. 改造 2：删除只写表 `notification_deliveries`（0005）

### 问题

- 唯一写入点：`packages/db/src/worker-notification-dispatcher.ts:407`（`recordNotificationDelivery`，在事务里 insert 每次投递尝试的完整审计：payload/response/error/时长）
- 全库零读路径（唯一引用是 `worker-backup.ts:92` 的全量备份表清单）
- 展示所需的重试信息 `notification_events` 已有：`attempt_count`、`last_error_code`、`last_error_message`、`sent_at`、`status`
- **保留** `webhook_deliveries`：`worker-webhook-export.ts:562`（`hasSuccessfulWebhookDelivery`）有真实的幂等去重读路径，两者虽结构相似但职责不同

### 迁移 0005_drop_notification_deliveries.sql（完整内容）

```sql
drop table if exists notification_deliveries;
```

### 代码变更清单

| 文件 | 变更 |
| --- | --- |
| `packages/db/src/worker-notification-dispatcher.ts` | `recordNotificationDelivery`（:407 起）：删除 `insert into notification_deliveries (...)` 语句及其参数；同事务内对 `notification_events` 的状态更新保留。若函数删后只剩 events 更新，就地简化（合并进调用方或去掉多余事务包装），调用点同步调整 |
| `packages/db/src/worker-backup.ts` | :92 表清单移除 `"notification_deliveries"` |
| `packages/db/migrations/0005_drop_notification_deliveries.sql` | 新建 |
| `packages/db/src/migration-status.ts` + `tests/features/v1-platform.unit.test.ts` | 登记 0005 |

现有测试无一引用 `notification_deliveries`（已 grep 确认），预计无需修改既有断言；若 backup 相关测试枚举了表清单，同步移除该项。

### 测试用例规格（`tests/features/schema-notification-deliveries-removed.unit.test.ts`）

1. `notification retry failure updates notification_events without a deliveries table` —— 迁移后的 fixture 上跑 dispatcher 的失败/重试路径，断言 `notification_events.attempt_count`/`last_error_code`/`status` 正确推进（RED：当前代码 insert 不存在的表会报错——即迁移后旧代码必炸，证明测试咬合）
2. `migrated schema has no notification_deliveries table` —— `select from information_schema.tables` 断言不存在
3. `backup artifact no longer lists notification_deliveries` —— `worker-backup` 产物表清单断言

### feature_list.json 条目草案

```json
{
  "id": "schema-notification-deliveries-removed",
  "name": "Schema Notification Deliveries Removed",
  "description": "The write-only notification_deliveries audit table is removed; notification retry state lives solely on notification_events (attempt_count, last_error_*, status), the dispatcher no longer records per-attempt audit rows, and backups no longer include the table. webhook_deliveries stays as the webhook export dedup ledger.",
  "verification": "pnpm exec vitest run tests/features/schema-notification-deliveries-removed.unit.test.ts",
  "dependencies": ["v1-worker-ops"],
  "status": "failing",
  "evidence": ""
}
```

### 风险与回滚

- **数据丢失不可逆**（历史投递审计行）。实施前对生产库先跑一次 `backup` job 留档；测试/开发库无此顾虑。
- 回滚 = 从备份 artifact 重建表（建表 SQL 取自 0001 基线 :310-329）。

---

## 6. 改造 1：fallback 重试链收敛到 `fallback_events` 表（0006）

### 问题

同一份重试链数据双写双读：

- **jsonb**：`request_activity.fallback_attempts`，由 `gateway-activity-recorder.ts:188`（`JSON.stringify(route.fallbackAttempts ?? [])`）随请求完成写入；只含**失败**尝试（`FallbackFailedAttempt[]`）
- **表**：`fallback_events`，由 `gateway-fallback-chain.ts:221,265` 逐次插入（0003dab 后为后台尽力写）；含 failed / succeeded / skipped 全部状态

任何一边漏写即两处 UI/导出不一致。收敛为表单源。

### 字段 diff（已完成，此为实现依据）

`FallbackFailedAttempt`（`gateway-fallback-chain.ts:28-38`）↔ `fallback_events` 列：

| jsonb 字段 | fallback_events 列 | 状态 |
| --- | --- | --- |
| attemptOrder | attempt_order | ✅ |
| errorCode | error_code | ✅ |
| errorMessage | error_message | ✅ |
| failedBeforeFirstByte | failed_before_first_byte | ✅ |
| providerApiKeyId? | provider_api_key_id | ✅ |
| providerApiKeyPrefix? | provider_api_key_prefix | ✅ |
| providerModelId | provider_model_id | ✅ |
| retryable | **无对应列** | ➕ 0006 补列 `retryable boolean` |
| statusCode | **无对应列** | ➕ 0006 补列 `status_code integer` |

重建 legacy 形状规则：`select ... from fallback_events where status = 'failed' order by attempt_order`，列→camelCase 按上表映射；旧行 `retryable`/`status_code` 为 null，读者需容忍。

### 迁移 0006_fallback_single_source.sql（完整内容）

```sql
alter table fallback_events
  add column if not exists retryable boolean,
  add column if not exists status_code integer;

alter table request_activity
  drop column if exists fallback_attempts;
```

### 语义变化（须写进 progress.md 的决策记录）

jsonb 随请求完成同步落库；`fallback_events` 插入自 `3dab4dda` 起是**后台尽力写**。收敛后列表页/导出与今天的 Console 详情页（本就读表）durability 一致：极端情况下（进程在后台写完成前崩溃）个别尝试行可能缺失。接受此语义，不回退 3dab4dda 的非阻塞设计。

### 代码变更清单（按写者→读者顺序）

| 文件 | 变更 |
| --- | --- |
| `packages/db/src/gateway-fallback-chain.ts` | :221 失败尝试 insert 增加 `retryable, status_code` 两列（值取 `attempt.retryable`、`attempt.statusCode`）；:265 成功尝试 insert 两列留 null，不动 |
| `packages/db/src/gateway-activity-recorder.ts` | 完成 update（:154 区域）删除 `fallback_attempts = $n::jsonb` 及 :188 的参数，后续参数重新编号；`route.fallbackAttempts` 内存结构保留（fallback 执行逻辑仍用） |
| `packages/db/src/console-activity.ts` | 列表查询 :192、:299 的 `request_activity.fallback_attempts` 替换为 lateral 计数：`coalesce((select count(*) from fallback_events fe where fe.request_activity_id = request_activity.id and fe.status = 'failed'), 0) as fallback_failed_count`；`ConsoleActivity.fallbackAttempts: unknown` 改为 `fallbackFailedAttemptCount: number`（:533 映射同步）；详情 :362 已读表，不动；`formatConsoleActivityFallbackAttempts`（:340 区域）改为接收 `ConsoleFallbackEvent[]`（所需 attemptOrder/errorCode/failedBeforeFirstByte/providerModelId 表行齐备） |
| `apps/console/src/app/_modules/sections.tsx` | :1110 fallback 文本行改用 `detail.fallbackEvents` 生成；:4187-4188 计数改用 `fallbackFailedAttemptCount` |
| `packages/db/src/worker-jsonl-export.ts` | :302 查询移除 `request_activity.fallback_attempts`；导出记录 :161 的 `fallbackAttempts` 键**保留**（外部契约），改由已加载的 fallbackEvents（:395 `readFallbackEventsByActivityId` 就近复用）过滤 `status==='failed'` 按上表映射合成 legacy 形状（含新列 retryable/statusCode，旧行为 null）；`fallbackEvents` 键不变 |
| `packages/db/src/worker-fallback-exhaustion-alerts.ts` | 查询 :248-280 已 join `fallback_events` 且 where 限定 `status='failed'`：将 `request_activity.fallback_attempts` 替换为 `jsonb_agg(jsonb_build_object(...legacy 键..., 'retryable', fallback_events.retryable, 'statusCode', fallback_events.status_code) order by fallback_events.attempt_order) as fallback_attempts`，group by 不变；:298 映射不动（形状不变） |
| `tests/features/gateway-recording-resilience.unit.test.ts` | 唯一引用 jsonb 的既有测试，按新行为调整（断言不再写该列） |
| 迁移登记三件套 | 0006 登记 + v1-platform 清单断言 |

### 测试用例规格（`tests/features/schema-fallback-single-source.unit.test.ts`）

1. `request completion does not persist a fallback_attempts column` —— 迁移后 fixture：`information_schema.columns` 断言列不存在；recorder 完成路径跑通（RED：当前 update 语句写该列，迁移后旧代码必炸）
2. `console activity list derives failed-attempt counts from fallback_events` —— 造 1 activity + 3 failed / 1 succeeded 事件行，列表返回 `fallbackFailedAttemptCount === 3`
3. `console activity detail fallback lines come from fallback_events rows`
4. `jsonl export synthesizes legacy fallbackAttempts from fallback_events` —— 断言键序/字段名与 legacy 形状一致，含 retryable/statusCode
5. `fallback exhaustion alerts aggregate attempts from fallback_events`
6. E2E（追加到既有 fallback E2E 或新 spec）：真实 Gateway 触发一次 fallback，Console activity API 返回完整重试链，jsonl 导出含合成 fallbackAttempts

### feature_list.json 条目草案

```json
{
  "id": "schema-fallback-single-source",
  "name": "Schema Fallback Single Source",
  "description": "fallback_events is the single source of truth for retry chains: fallback_events gains retryable/status_code, the request_activity.fallback_attempts jsonb column is dropped, Console activity list/detail, jsonl export (legacy fallbackAttempts shape preserved), and fallback exhaustion alerts all derive attempts from fallback_events rows.",
  "verification": "pnpm exec vitest run tests/features/schema-fallback-single-source.unit.test.ts",
  "dependencies": ["v1-gateway-routing", "gateway-recording-resilience"],
  "status": "failing",
  "evidence": ""
}
```

### 风险与回滚

- **删列不可逆**（历史 jsonb 数据）。生产实施前跑 `backup` job；此项排在三项之末也是为此。
- jsonl 外部消费者：`fallbackAttempts` 键与元素字段名保持不变；差异仅在旧历史行合成值的 `retryable`/`statusCode` 为 null——写入导出变更说明。
- 后台尽力写的 durability 语义变化见上节，属决策记录而非缺陷。

---

## 7. 改造 4（待决策）：并发计数出库（0007）

**前置决策（未定，实施前必须确认）**：多实例 Gateway 是否在路线图上？在 → 本项整体不做，保留现状。

### 问题

`rate_limit_windows` 把 concurrency 活跃计数存为 DB 行（`limit_type='concurrency'`，`active_count` 列），进程崩溃即漂移，0002 为此新增 `stale_concurrency_reconcile` 修数任务——与已删除的 `budget_reservations` 同类（DB 维护易漂移瞬时状态）。架构文档定位 self-hosted 单实例。

### 变更（决策通过后细化为与 0004-0006 同粒度的规格再实施）

- `packages/db/src/gateway-agent-limits.ts`：concurrency 分支（:279,302,320-325,595,633）改进程内计数（`Map<agentId, number>`，模块级，启动即零）；`releaseGatewayConcurrency`（:172-186）改内存释放；rpm/tpm 窗口落库逻辑不动
- 删除 `packages/db/src/worker-stale-concurrency.ts` 与 `worker-periodic-scheduler.ts` 中的注册、`apps/worker/src/main.ts` 的 handler 装配
- 迁移 `0007_drop_concurrency_windows.sql`：`delete from rate_limit_windows where limit_type = 'concurrency';`（表保留给 rpm/tpm）
- 测试：并发压顶拒绝 / 完成释放 / 重启归零 E2E

---

## 8. 改造 5：ARCHITECTURE.md 表清单对齐（随最后一项）

`docs/ARCHITECTURE.md` 数据表清单（约 :940-990）与实际 schema 的漂移：

| 文档写的 | 实际 | 处理 |
| --- | --- | --- |
| `request_prompts` / `response_outputs` | 不存在 | 删除或标注"规划中未实现" |
| `route_policy_rules` | `route_policies.rules` jsonb 列 | 改写 |
| `provider_keys` | `provider_api_keys` | 改名 |
| `migration_history` | 存在（runMigrations 自建），核对描述 | 核对 |
| `fallback_attempts` 快照描述 | 改造 1 后不存在 | 同步删除 |
| `notification_deliveries`（若有提及） | 改造 2 后不存在 | 同步删除 |

## 9. 全局验证

- 每项：`pnpm run verify`（lint→typecheck→test→build）
- 回归：`pnpm run verify:features`（全部 passing feature 全部重跑 + 新增 feature）
- 改造 1/2 额外：Console Activity/Analytics 页面 E2E、jsonl/webhook 导出输出对比
- 收尾：`./init.sh` 可直接启动（AGENTS.md 干净状态要求）
