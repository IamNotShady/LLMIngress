# LLMIngress Architecture Design

> 本文基于 `docs/PRODUCT.md` 输出 Gateway Service 与 Console 控制台的目标架构设计。本文只聚焦架构边界、模块职责、技术选型、数据存储与项目目录结构，不展开具体代码实现细节。

## 1. 架构目标

LLMIngress 是单用户、自托管的 AI Agent Gateway。产品上分为两个核心平面：

- Gateway Service：数据面，接收 AI Agent 请求，执行鉴权、预算检查、路由决策、Provider 转发、Fallback 和用量记录。
- Console：控制面，负责配置管理、运行状态查看、Activity / Usage 展示、预算与限流配置，以及接入引导。

运行时还需要一个后台任务平面：

- Background Worker / Scheduler：异步任务面，负责告警评估、通知投递、模型发现、价格同步、账单对账、日志保留、JSONL / webhook export、周期性备份和维护任务。

核心设计约束：

- AI Agent 只直接访问 Gateway Service，不直接访问 Console。
- Console 修改的是 Gateway 运行所需配置，不处理 Agent 的模型请求流量。
- Console 不直接调用真实 Provider；Provider 出网调用由 Gateway 的请求路径或 Background Worker 的异步任务负责。
- Gateway 对新请求使用最新配置；已进入处理流程的请求继续使用进入时捕获的配置快照。
- Gateway 在 Console 不可用时仍可继续处理请求，前提是已有可用配置快照、数据库连接和可用的 secret master key。
- Background Worker 不在 AI Agent 的同步请求路径上；Worker 暂停只影响异步能力，不应阻断 Gateway 处理新请求。
- 默认面向本地或单机自托管部署，不以多租户 SaaS 为 V1 架构目标。
- V1 假定每个部署只有一个 active Gateway 进程处理请求；多 Gateway 是后续扩展路径，需要先把 RPM / TPM / concurrency 等运行时计数迁移到共享状态组件。

## 2. TypeScript 技术栈选择

LLMIngress 使用 TypeScript 统一 Gateway、Console 和共享领域模型，降低协议、配置和数据结构在前后端之间漂移的风险。

| 层级 | 选型 | 作用 |
| --- | --- | --- |
| Monorepo | pnpm workspace + Turborepo | 管理 Gateway、Console、Worker 和共享 packages，支持分包构建与复用 |
| Runtime | Node.js | 统一运行 Gateway、Console API、后台任务与 CLI |
| Gateway Service | Fastify | 承载高吞吐 Public API、流式响应和插件化 request pipeline |
| Console Web | Next.js App Router + React, Node runtime | 构建管理控制台、服务端渲染页面、Console API routes；需要常驻 Node 进程支撑 Postgres listener 或长轮询 |
| Background Worker | Node.js worker process + database-backed scheduler | 承载周期任务、异步任务、通知投递、模型刷新、价格同步和日志清理 |
| Database / coordination | PostgreSQL | 作为 canonical database，并通过 `LISTEN/NOTIFY` 承载配置热加载、job 唤醒和运行状态变更通知 |
| UI | Tailwind CSS + shadcn/ui + lucide-react | 控制台 UI、表格、表单、图标、弹窗、导航等基础组件 |
| Client state | TanStack Query | Console 页面读取配置、状态、Activity 与 Usage 数据 |
| Chart | Recharts | Usage、Cost、Latency、Fallback 等图表 |
| Schema / validation | Zod | 共享请求、配置、路由策略、Provider 配置与 Console 表单校验 |
| Database access | SQL migrations now, Drizzle schema later | 当前迁移以 `packages/db/migrations/*.sql` 为 source of truth；后续可补 Drizzle schema 和查询类型约束 |
| Logging | Pino | Gateway 请求日志、运行日志、错误日志 |
| Observability | OpenTelemetry + Prometheus exporter | traces、metrics、Provider latency、Gateway runtime 指标 |

选择 Fastify 作为 Gateway 默认框架的原因是：Gateway 是运行时请求路径，重点是 HTTP 性能、streaming、插件边界和低额外延迟。Console 采用 Next.js，是因为控制台需要页面路由、表单、数据展示、鉴权引导和部署形态兼容。

## 3. 总体拓扑

```text
AI Agents
  │
  │ OpenAI-compatible / Anthropic-compatible API
  ▼
Gateway Service
  ├── Agent-owned API key 鉴权
  ├── Budget / Rate Limit 检查
  ├── Virtual Model / Route Policy 解析
  ├── Provider / Model 选择
  ├── Fallback Chain 执行
  ├── Streaming 响应转发
  └── Usage / Activity 写入
  │
  ▼
Providers
  ├── OpenAI
  ├── Anthropic
  ├── Google Gemini
  ├── OpenRouter
  ├── Local Provider / Ollama
  └── 后续 Provider

Browser
  ├── Console
  │   ├── Agents / Providers / Models / Routes / Limits 管理
  │   ├── Activity / Usage / Cost 展示
  │   ├── Gateway Runtime 状态查看
  │   └── 配置变更发布
  │
  └── Playground live request
      └── Gateway Public API

Background Worker / Scheduler
  ├── Model discovery / refresh
  ├── Price sync / billing reconciliation
  ├── Alerts / notifications
  ├── Retention / cleanup
  ├── JSONL / webhook export
  └── Scheduled backup / maintenance tasks

Gateway Service ───────┐
        │              │
        ▼              ▼
PostgreSQL canonical database + LISTEN/NOTIFY channels
        ▲              ▲
        │              │
Console ┴──────── Background Worker
```

Gateway、Console 与 Background Worker 共享同一个 PostgreSQL 数据库，并把 PostgreSQL 作为进程间通信媒介：

- Console 写入用户配置数据，并通过共享 config publisher 发布配置版本变更。
- Gateway 读取配置数据，构建内存中的只读配置快照。
- Gateway 写入请求 metadata、usage、cost、fallback、error 等运行数据。
- Console 读取 Gateway 运行数据，用于 Activity、Usage 和 Runtime 页面展示。
- Background Worker 读取配置、运行数据和待处理任务，写回模型库、价格、告警、通知、对账结果、健康摘要和清理状态。
- `LISTEN/NOTIFY` 只负责唤醒和低延迟通知；持久化表仍是配置版本、job、运行状态和事件记录的 source of truth。

## 4. Gateway Service 架构

Gateway Service 是数据面，重点是请求路径稳定、低延迟、可观测和可热加载。

```text
Gateway Service
├── Public API Layer
│   ├── OpenAI-compatible endpoints
│   ├── Anthropic-compatible endpoints
│   └── Models endpoint
│
├── Request Pipeline
│   ├── Request ID / logging context
│   ├── Agent-owned API key authentication
│   ├── Agent permission check
│   ├── Cheap RPM / concurrency check
│   ├── Protocol normalization
│   ├── Request metadata extraction
│   ├── Token estimate
│   └── TPM / budget reservation
│
├── Routing Runtime
│   ├── Config snapshot reader
│   ├── Virtual Model resolver
│   ├── Deterministic route policy engine
│   ├── Provider / model selector
│   ├── Fallback orchestrator
│   └── Route reason builder
│
├── Provider Runtime
│   ├── Provider adapter registry
│   ├── Provider key selector
│   ├── Streaming proxy
│   ├── Timeout / cancellation handling
│   └── Provider health tracking
│
├── Observability Runtime
│   ├── Activity recorder
│   ├── Usage / cost recorder
│   ├── Baseline / savings recorder
│   ├── Error / fallback recorder
│   ├── Metrics exporter
│   └── Trace exporter
│
└── Postgres Coordination Subscriber
    ├── Config change listener
    ├── Health summary listener
    ├── Runtime heartbeat writer
    └── Periodic reconcile loop
```

### 4.1 Public API Layer

Gateway 对 AI Agent 暴露统一 endpoint，优先覆盖：

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/embeddings`
- `GET /v1/models`

其中 `GET /v1/models` 返回当前 Agent 被授权使用的 Virtual Model Name，不直接暴露真实 Provider 模型列表。

Public API 的默认调用方是 AI Agent。Playground 需要从浏览器直接调用 Gateway Public API 时，Gateway 只允许配置过的 Console origin 通过 CORS 访问；默认本机部署可允许 Console localhost origin，server 部署必须显式配置 allowed origins。Playground 使用的 Gateway Base URL 来自 Console 中展示给 Agent 的 Gateway URL / runtime setting；如果 Console 与 Gateway 不同端口或域名，用户必须配置浏览器可访问的 Gateway Base URL。

`/v1/responses` 的 V1 支持范围：

- V1 支持无状态 Responses API 子集，用于兼容使用 OpenAI-compatible `/v1/responses` 的 Agent。
- V1 不默认实现跨 Provider 的 `previous_response_id`、server-side `store`、response state replay 或 provider state migration。
- 如果请求包含 `previous_response_id` 或要求 `store = true`，V1 默认返回明确的 unsupported error；未来可以在单 Provider passthrough 模式下扩展。
- Gateway 内部仍把无状态 responses 请求归一化为 normalized request，再路由到支持对应输入 / 输出能力的 Provider adapter。

### 4.2 Routing Runtime

Routing Runtime 使用确定性规则引擎，不在 V1 默认额外调用 LLM 分类器。它根据以下输入选择真实 Provider 与 Model：

- Agent-owned API key。
- Agent 类型。
- Virtual Model Name。
- Route Policy。
- 请求协议。
- 输入 token 估算。
- tools / function calling 需求。
- context window 需求。
- coding、reasoning、terminal、repo、long context 等任务特征。
- Gateway in-memory Provider / Model health view。
- Route Policy 配置的成本偏好和 Fallback Chain。

路由结果必须产出用户可理解的 route reason，供响应 metadata 与 Activity 页面展示。

### 4.3 Config Snapshot

Gateway 不在每个请求中直接拼装完整配置，而是在内存中维护一个 immutable config snapshot：

- snapshot 来源于数据库中的 Agents、Agent Virtual Model grants、Providers、Models、Virtual Models、Route Policies、Limits 等配置。
- 每次配置热加载生成新的 snapshot。
- 新请求读取当前最新 snapshot。
- 已开始处理的请求继续使用它进入 pipeline 时捕获的 snapshot。
- 如果新配置加载或校验失败，Gateway 保留上一份可用 snapshot。

该设计保证配置更新不会影响进行中的 streaming 请求，也能避免运行时配置读到半更新状态。

### 4.4 Runtime Counter and Health State

Gateway 负责同步请求路径中的可变运行时状态，包括限流计数、预算预留、并发计数和路由健康视图。它们不能放进 immutable config snapshot，也不能在每个请求上实时聚合全量历史表。

运行时状态归属：

- RPM / TPM window：Gateway 在内存中维护当前窗口的快速计数，并把窗口累计值周期性或按请求写入数据库，用于重启恢复和 Console 展示。
- Concurrency：Gateway 在内存中维护当前进程内的并发计数，请求结束或取消时释放；Gateway 重启后并发计数自然归零。
- Budget period：数据库保存每个 Agent 当前预算周期的累计 token、cost 和 reservation；Gateway 在请求开始时做预算预留，在请求结束后用实际或估算 usage 结算。
- Budget reservation：请求开始时按输入 token 估算值和可用的输出上限做预留；streaming 输出 token 在请求开始时未知，请求结束后用实际输出 token 和实际或估算成本结算差额。
- Usage record：`request_usage` 是审计与分析记录，不是同步限流检查的唯一来源。
- Provider / Model health view：Gateway 维护进程内健康视图，综合请求路径内的失败、超时、429、首包延迟和 Worker 周期探测摘要；路由决策读取这份 in-memory health view，不在每个请求上查询 `provider_health_events`。

推荐的检查顺序：

```text
auth
  -> cheap RPM / concurrency check
  -> protocol normalization
  -> request metadata extraction
  -> token estimate
  -> TPM / budget reservation
  -> route decision
```

RPM 和并发检查不依赖 token 估算，应尽早执行。TPM 和预算检查依赖 token 估算，因此必须在协议归一化和 metadata extraction 之后执行。

Budget reservation 的泄漏回收：

- Gateway 启动时清理本进程上次异常退出遗留的 stale reservation。
- Gateway 在请求取消、超时或 provider fallback 全部失败时结算或释放 reservation。
- Worker 的 Data Maintenance 周期性扫描并释放超过 TTL 的 stale reservation，作为兜底。

Provider health 的合并规则：

- Gateway 请求路径信号优先影响即时路由，例如连续失败、429、timeout 或首包延迟异常。
- Worker 周期探测写入 `provider_health_events`，并更新 `provider_health_summary`。
- Gateway 通过 Postgres `health_summary_changed` 通知或轻量定时 refresh 读取最新 `provider_health_summary`，合并到 in-memory health view。
- Console 展示完整 `provider_health_events` 和当前 `provider_health_summary`；这些表不是每次路由的同步查询来源。

Postgres 是运行时状态的持久化 owner，Gateway 是请求路径上低延迟 in-memory view 的 owner。Gateway 可以用内存计数支撑单实例低延迟检查，并把可恢复状态写入 Postgres；如果未来运行多个 Gateway 实例，RPM / TPM / concurrency 需要迁移到 Postgres 原子更新、advisory lock 或 Redis 等共享状态组件，不能继续只依赖单进程内存。

### 4.5 Savings 计算归属

成本节省是请求级可观测数据，owner 是 Gateway 的 Observability Runtime，而不是 Console 查询时临时反推。

Gateway 在完成路由决策并拿到实际 usage 后，同步写入：

- actual provider / model cost：本次真实命中的 Provider / Model 成本。
- baseline provider / model：该 Virtual Model 的基线模型，来自用户显式配置；如果用户未配置，则使用该 Virtual Model 的质量优先默认模型。
- baseline hypothetical cost：按同一输入 / 输出 token 和 baseline 模型价格计算的假想成本。
- savings amount / percent：`baseline hypothetical cost - actual cost` 及百分比。
- price source / price version：记录本次计算使用的价格来源，避免后续价格同步后历史 savings 被重算漂移。

这样 Overview 和 Usage 页面可以直接聚合 `request_costs` 中的 baseline / savings 字段，不需要在查询时重新跑一遍历史路由逻辑。Worker 的 billing reconciliation 可以更新 actual cost，但不改变原始 route decision；如果 actual cost 被对账修正，Worker 可以按同一 baseline 重新计算 savings 并标记 reconciled。

### 4.6 Provider Adapter Strategy

Provider adapter 不按每个长尾 Provider 都实现一套独立 adapter。V1 采用两层策略：

- Native adapter：用于 OpenAI、Anthropic、Google Gemini、OpenRouter、Ollama 等协议或行为差异明显的 Provider。
- Generic OpenAI-compatible adapter：用于 DeepSeek、xAI、Qwen、Moonshot / Kimi、MiniMax、Z.ai、LM Studio、llama.cpp 等兼容 OpenAI API 形态的 Provider。

通用 OpenAI-compatible adapter 不能变成任意自定义 endpoint。它只能通过内置白名单 Provider template 启用，template 分为两类：

- Provider id、display name 和类别。
- 远程 Provider template 固定 base URL 和 endpoint path，例如 DeepSeek、xAI、Qwen。
- Local Provider template 固定 endpoint path、协议形态和能力声明，但 base URL 由用户在 Provider 配置中填写，例如 LM Studio、llama.cpp；这仍然受该 local provider template 约束，不等同于任意自定义 endpoint。
- auth header / key placement。
- 支持的 endpoint 子集，例如 chat completions、responses stateless subset、embeddings。
- streaming、tools、JSON mode、max context 等能力声明。
- 模型发现方式：provider model list API、静态 registry，或 local provider probe。

这样可以覆盖产品清单里的长尾 Provider，同时保持“V1 不支持任意自定义 endpoint”的产品边界。

## 5. Console 架构

Console 是控制面，面向用户提供配置、观测和接入引导。

```text
Console
├── Web App
│   ├── Overview
│   ├── Agents
│   ├── Providers
│   ├── Models
│   ├── Virtual Models / Routes
│   ├── Activity
│   ├── Usage & Cost
│   ├── Limits
│   ├── Gateway Runtime
│   ├── Playground
│   └── Settings
│
├── Console API
│   ├── Agent management
│   ├── Provider management
│   ├── Model library management
│   ├── Route policy management
│   ├── Limit management
│   ├── Usage query
│   ├── Activity query
│   ├── Runtime query
│   └── Import / export
│
├── Domain Services
│   ├── Dependency check service
│   ├── Config validation service
│   ├── Shared config publisher client
│   ├── Secret encryption client
│   └── Import / export service
│
├── Runtime Queries
│   ├── Gateway status query from Postgres
│   ├── Worker job status query from Postgres
│   └── Provider health query from Postgres
│
└── Job Client
    ├── Model refresh job trigger
    ├── Price sync job trigger
    ├── Provider connectivity check trigger
    └── Export / cleanup job trigger
```

Console 的关键职责：

- 写入并校验配置。
- 在禁用或删除 Provider、Model、Route Policy 前做依赖检查。
- 对 Provider Key 做加密写入，对 Agent-owned API key 做 hash 存储。
- 生成 Agent 接入说明和可复制配置。
- 展示 Gateway 写入的 Activity、Usage、Cost、Fallback 和错误数据。
- 管理 Gateway Runtime 设置，例如监听地址、端口、日志保留和数据导入导出。
- 为模型刷新、Provider 连通性检查、价格同步、备份、日志清理等异步动作创建后台任务，而不是直接在 Console 请求中执行长耗时 Provider 调用。
- Console 不拥有 config publisher 的事务实现；它只调用 `packages/config` 中的共享 publisher。

Console 不承担 Provider 请求转发，也不参与 AI Agent 的实时请求路径。Console 不直接调用 Gateway 内部接口；控制动作通过 Postgres 配置表、job 表和 notification channel 传递，真实 Provider 出网调用由 Gateway 或 Background Worker 执行。

## 6. Background Worker / Scheduler 架构

Background Worker 是异步任务面，负责所有不属于 Agent 同步请求路径、也不应该阻塞 Console 页面请求的能力。

```text
Background Worker / Scheduler
├── Job Runner
│   ├── Scheduled jobs
│   ├── Manual jobs from Console
│   ├── Retry / backoff
│   └── Job lease / deduplication
│
├── Provider Maintenance
│   ├── Model discovery / refresh
│   ├── Provider connectivity probes
│   ├── Price registry sync
│   └── Billing reconciliation
│
├── Alerting / Notification
│   ├── Budget threshold evaluator
│   ├── Provider failure evaluator
│   ├── Fallback exhaustion evaluator
│   └── Webhook dispatcher
│
├── Data Maintenance
│   ├── Request log retention
│   ├── Optional content cleanup
│   ├── Stale budget reservation cleanup
│   ├── JSONL request log export
│   └── Cost report export
│
└── Lifecycle Maintenance
    ├── Backup job
    ├── Database maintenance
    └── Migration status check
```

配置写入 owner 规则：

- Console 是用户配置的 owner，写入 Agents、Agent Virtual Model grants、Providers、Virtual Models、Route Policies、Limits、Settings 等用户显式配置。
- Worker 是 Provider 派生数据和异步运行数据的 owner：provider model list、price registry snapshot 等会进入配置版本；provider health summary、billing reconciliation 对 `request_costs` 的修正等是运行数据，不进入 config snapshot。
- Console 和 Worker 都必须通过同一个 config publisher 发布 routing-visible config version；任何一方发布 config version 后，都通过 Postgres `config_changed` channel 唤醒 Gateway reload。Worker 的健康探测结果不发布 config version，而是通过 health summary 表和 `health_summary_changed` channel 进入 Gateway health view 的刷新链路。

Worker 的运行边界：

- Worker 不是请求代理；Agent 的模型请求仍只经过 Gateway。
- Worker 可以解密 Provider Key，因为它需要执行模型发现、价格同步、账单对账和 Provider 健康探测。
- Worker 运行失败不应阻断 Gateway 请求，但会让模型刷新、通知、清理、对账等异步能力延迟。
- Worker 可以和 Gateway / Console 在同一个进程 supervisor 下运行，也可以是独立进程。

### 6.1 模型发现与刷新链路

Provider 模型发现由 Background Worker 执行，避免 Console 直接出网调用 Provider，也避免 Gateway 的同步请求路径被模型刷新任务占用。

```text
User
  ▼
Console Providers / Models page
  ▼
Console API
  ▼
create model_refresh_job
  ▼
Background Worker
  ├── load provider config
  ├── decrypt provider key
  ├── call provider model list API
  ├── normalize model metadata
  ├── upsert provider_models
  ├── publish config version if routing-visible data changed
  └── emit Postgres config_changed notification
```

触发方式：

- 自动刷新：新增或启用 Provider 后，Console 创建一次模型刷新任务。
- 手动刷新：用户在 Console 点击 refresh，Console 创建一次模型刷新任务。
- 周期刷新：Worker 按配置周期刷新模型列表；Provider 健康探测走 health summary 链路，不发布 config version。

Gateway 的 `GET /v1/models` 不走 Provider discovery，它只基于当前 config snapshot 返回 Agent 被授权使用的 Virtual Model Name。

Provider 派生模型数据的引用完整性规则：

- Worker 刷新模型列表时只做 upsert 和状态标记，不直接硬删除 `provider_models` 记录。
- Provider 侧消失的模型标记为 `unavailable`、`not_listed` 或 `deprecated`，并记录 last seen 时间。
- 如果消失的模型被 Route Policy candidate、Fallback Chain 或固定模型路由引用，Worker 写入告警事件，Console 在 Models / Routes 页面提示受影响配置。
- 硬删除 Provider 派生模型只能由用户在 Console 显式执行，并且必须经过依赖检查。
- Gateway 路由不会选择已标记 unavailable 的模型，除非用户显式覆盖并承担失败风险。

### 6.2 Provider 连通性检查与健康探测

Provider 连通性检查和周期健康探测共用同一套 Worker health probe 管道，避免出现两套健康 owner。

- `provider-health.job.ts` 是执行 owner，负责解密 Provider Key、发起轻量 probe、写入 `provider_health_events`，并更新 `provider_health_summary`。
- 周期探测由 Worker scheduler 触发，用于持续刷新 Provider / Model 健康状态。
- Console 的手动“连接测试”创建 `provider_connectivity_check` job，本质是一次 trigger 为 manual 的 health probe。
- 手动检查结果同时写入 job result 和 `provider_health_events`；如果结果比当前 summary 更新，则更新 `provider_health_summary` 并发送 `health_summary_changed`。
- Gateway 只消费合并后的 in-memory health view，不直接执行 Console 发起的 Provider 连接测试。

### 6.3 价格同步与账单对账

Gateway 在请求结束时先写入 usage 和估算成本，保证 Activity 与 Usage 页面能及时展示。Background Worker 再负责异步对账：

- Provider 支持返回实际 usage / billing 数据时，Worker 周期性拉取并写入 actual cost。
- Provider 不支持实际计费数据时，继续使用 token 估算成本，并标记 cost source 为 estimated。
- 对账结果不改变原始 request activity，只补充 cost source、actual cost、reconciled at 等字段。
- 如果价格同步改变了会影响路由选择的价格表或模型可用性，Worker 通过 config publisher 发布新 config version，并通过 Postgres `config_changed` channel 触发 Gateway reload fast path。

这样满足“优先采用 Provider 实际计费数据，无法获得时才使用估算值”的产品口径，同时不把账单 API 调用放进 Gateway 请求路径。

## 7. Gateway、Console 与 Worker 的交互

Gateway、Console 与 Worker 的交互分为五类：配置写入、Postgres 通知热加载、运行数据读取、异步任务调度、Playground Public API 测试。

### 7.1 配置写入链路

```text
User-authored config
  └── Console API
        └── Config validation / dependency check

Provider-derived config
  └── Background Worker
        └── Provider / registry normalization

Both paths
  ▼
Shared config publisher in `packages/config`
  ▼
Database transaction
  ├── write config or derived config tables
  ├── increment config version
  ├── append config change event
  └── pg_notify('config_changed', version payload)
```

配置有两个受控写入方：

- Console 写用户显式配置，例如 Agent、Provider、Virtual Model、Route Policy、Limit、Settings。
- Worker 写 Provider 派生配置，例如 provider model list、price registry snapshot；Provider health summary 属于运行时健康状态，不进入 config snapshot。

两类配置写入都必须通过 `packages/config` 提供的同一个 config publisher。只要变更影响 Gateway 路由、权限、模型能力、静态启用状态或价格，就递增全局 config version，并通过 Postgres `NOTIFY` 唤醒 Gateway。Provider 健康变化不递增 config version，而是刷新 Gateway 的 in-memory health view。

### 7.2 热加载通知链路

推荐采用“Postgres `LISTEN/NOTIFY` + 周期 reconcile”的组合，而不是让 Console / Worker 直接调用 Gateway 私有接口。

```text
Shared config publisher in `packages/config`
  │
  │ 1. Console or Worker publishes config version
  │ 2. PostgreSQL commits config transaction
  │ 3. PostgreSQL emits NOTIFY config_changed
  ▼
Gateway Postgres listener
  │
  │ 4. read latest config version from Postgres
  ▼
Config Loader
  │
  │ 5. build and validate new immutable snapshot
  ▼
Atomic Snapshot Swap
  │
  │ 6. new requests use latest snapshot
  ▼
Gateway writes applied config version to runtime status table
```

热加载策略：

- Fast path：Console 或 Worker 通过 config publisher 写入 routing-visible config version 后，在同一事务中执行 Postgres `NOTIFY config_changed`；Gateway 的 dedicated listener connection 收到通知后加载指定 config version。
- Safety path：Gateway 启动时加载最新配置，并周期性检查 Postgres 中的 latest config version；如果 Gateway 重连期间错过 `NOTIFY`，也能通过 reconcile 发现配置变化。
- Multi-gateway future：多个 Gateway 实例可以同时 `LISTEN config_changed`；Postgres 会把通知广播给所有活跃 listener。`config_versions`（含 `changes` JSON）仍是持久化 source of truth。
- 通知语义：Postgres `NOTIFY` 是 wake-up signal，不是 durable queue；payload 只放 config version、change id 和 change type，完整配置始终从数据库读取。
- 控制反馈语义：Console 对 Gateway 的控制是异步、最终一致的。用户保存配置后，Console 只能先展示目标 config version 为 pending；是否已应用、是否失败，以 Gateway 写入 `gateway_runtime_status.applied_config_version` 和 reload failure event 为准，而不是以某个同步 HTTP 调用成功为准。

热加载失败处理：

- Gateway 对新 snapshot 做完整校验。
- 校验失败时不切换 snapshot。
- Gateway 记录 reload failure event。
- Console 的 Gateway Runtime 页面展示目标版本、已应用版本和失败原因。
- 如果 Gateway 在线但错过通知，周期 reconcile 会重新加载；如果配置本身校验失败，用户修复配置后再次发布新版本。

### 7.3 运行数据读取链路

Gateway 处理请求后写入运行数据：

```text
Gateway Request Pipeline
  ├── Activity records
  ├── Usage records
  ├── Cost records
  ├── Fallback events
  ├── Error events
  ├── Provider health snapshots
  └── Gateway runtime heartbeat / applied config version
        ▼
      Postgres
        ▼
      Console Activity / Usage / Runtime pages
```

Console 从 Postgres 读取 Activity、Usage、Cost、Runtime 状态、Provider health summary 和 Worker job 状态。Gateway 周期性写入 `gateway_runtime_status.heartbeat_at`，Runtime 页面默认把超过 30 秒未更新的 Gateway 标记为 stale / down；Provider health summary 的用户可见展示集中在 Providers 页面，避免 Gateway Runtime 重复展示 provider 维度状态。

对于实时刷新页面，可以由 Console Web 使用 polling、SSE 或 WebSocket 拉取 Console API。Console API 如果要订阅 Postgres notification channel，必须运行在常驻 Node.js 进程中；不假设 edge runtime 或 serverless 短生命周期函数可以长期 `LISTEN`。如果部署环境不适合长连接 listener，Console 使用 polling 读取 Postgres 状态即可。

### 7.4 异步任务调度链路

Console 对耗时动作只创建任务，不直接执行 Provider 出网调用或长耗时维护动作。周期性维护任务可以由 Worker scheduler 自行创建，也可以由 Console 手动触发。

```text
Worker scheduler
  ├── retention_cleanup
  ├── stale_reservation_cleanup
  └── backup (trigger=scheduled)

Console API manual trigger
  ├── model_refresh
  ├── provider_connectivity_check
  ├── price_sync
  ├── billing_reconciliation
  ├── webhook_export
  └── backup (trigger=manual)

Both paths
  ▼
create job record
  ├── model_refresh
  ├── provider_connectivity_check
  ├── price_sync
  ├── billing_reconciliation
  ├── retention_cleanup
  ├── stale_reservation_cleanup
  ├── webhook_export
  └── backup
      │
      ├── pg_notify('job_created', job payload)
      ▼
Background Worker
  ├── LISTEN job_created or poll due jobs
  ├── acquire job lease
  ├── execute job
  ├── write job result
  └── publish config version and emit config_changed if routing-visible data changed
```

Worker job 使用 Postgres 行锁、advisory lock 或 job lease 做去重，避免同一个任务被多个 worker 同时执行。`job_created` notification 只用于唤醒，`jobs` 表才是任务 source of truth。`backup` job 通过 trigger 字段区分 scheduled 和 manual。V1 可以只运行一个 Worker；未来多实例 Worker 也可以基于 Postgres `FOR UPDATE SKIP LOCKED` 或 advisory lock 做并发消费。

### 7.5 Playground Public API 测试链路

Playground 使用 Gateway Public API 做真实请求测试。Console 后端不代理 Playground 请求，也不保存、读取或恢复 Agent API key 明文；用户需要在 Playground 页面手动输入 Agent API key，然后选择一个 Virtual Model Name 作为请求中的 `model`。

```text
User
  ▼
Console Playground in browser
  ├── input Agent API key, held in page memory only
  ├── GET /v1/models through Gateway Public API
  └── select Virtual Model Name
  ▼
Gateway Public API
  ├── normal Agent-owned API key authentication
  ├── normal Virtual Model authorization
  ├── normal rate limit / budget / concurrency check
  ├── normal route policy / fallback execution
  ├── live Provider call
  └── normal activity / usage / cost record
```

因为 Playground 走的是真实 Public API 请求，它默认计入该 Agent 的 Rate Limit、Budget、Usage 和 Cost。Console 可以在页面内展示本次测试的 request id、route reason 和响应结果，但这些数据来自 Public API 响应和后续 Activity 查询，不需要内部测试 endpoint。

Playground 安全边界：

- Agent API key 只保存在当前页面内存中，不写入 localStorage、sessionStorage、cookie 或 Console 后端日志。
- Console 与 Gateway 不同端口或域名时，Playground 使用用户配置的 Gateway Base URL，并要求 Gateway CORS allowlist 包含当前 Console origin。
- 这是自托管单用户场景下可接受的显式操作；如果用户关闭页面或刷新页面，需要重新粘贴 Agent API key。

### 7.6 Postgres 通信与权限边界

Gateway 只暴露面向 Agent 和 Playground 的 Public API；Gateway、Console、Worker 之间的控制通信统一通过 Postgres 表和 notification channel 完成。Postgres 连接凭据是部署 secret，不能与 Provider secret master key 混用。

- Gateway：读取配置表，订阅 `config_changed` / `health_summary_changed`，写入 request runtime records、gateway heartbeat、applied config version 和 reload failure event。
- Console：写用户配置、创建 job、读取 runtime / activity / usage / health 数据；不调用 Gateway 私有 HTTP endpoint。
- Worker：claim job、写 Provider 派生配置、写 health summary、写通知 / 对账 / 清理结果，并在 routing-visible 变更时通过 config publisher 发出 `config_changed`。
- 推荐在部署上使用独立 Postgres role 或最小权限 schema grant，避免 Console / Worker / Gateway 拿到超出职责的数据库权限。

### 7.7 Runtime Settings 变更语义

Console 可以管理 Gateway Runtime 设置，但不是所有 runtime settings 都能通过 config snapshot 热加载。

| 设置类型 | 生效方式 | 生效执行方 |
| --- | --- | --- |
| Route Policy、Virtual Model、Agent 权限、Provider 启用状态、模型元数据、价格、Limits | config version + snapshot 热加载 | Console / Worker 通过 shared config publisher |
| 日志保留周期、导出计划、告警阈值、通知目标 | Worker scheduler 下次 tick 或 job reload 生效 | Worker |
| Console UI 偏好、报表筛选默认值 | Console API / Web App 即时生效 | Console |
| Gateway listen host、port、TLS 配置、Postgres connection string、数据目录、master key 来源 | 需要 supervisor 重启相关进程 | local / deployment supervisor |

监听地址、端口和数据目录这类进程启动参数不能通过 immutable config snapshot 原子替换。Console 修改这些设置时应标记为 restart required，并交给 local / deployment supervisor 执行重启。

Gateway listen host、port、Postgres connection string、数据目录、master key 来源等 bootstrap 参数在数据库连接建立前就需要，不能只保存在业务数据库中。它们应持久化在 supervisor 拥有的 bootstrap 配置文件或环境变量里；Console 修改这类设置时，通过 local / deployment supervisor 写回 bootstrap 配置，而不是直接写入业务数据库后等待热加载。

## 8. 数据存储选型

### 8.1 默认选择：PostgreSQL

V1 直接使用 PostgreSQL 作为 canonical database，并把它作为 Gateway、Console、Worker 之间的通信媒介。

选择原因：

- Gateway、Console、Worker 是多个独立进程，Postgres 比本地文件数据库更适合并发写入、长期运行和 Docker / server 部署。
- 配置数据、请求 metadata、usage、cost、fallback event、job、notification 都是强结构化数据，适合关系模型。
- `LISTEN/NOTIFY` 可以承担配置热加载、job 唤醒、health summary 刷新的低延迟通知，不需要 Gateway 暴露私有控制接口。
- `SELECT ... FOR UPDATE SKIP LOCKED`、transaction、advisory lock 可以支撑 Worker job lease、预算预留、周期任务去重等协调需求。
- 后续如果扩展到多 Gateway / 多 Worker，Postgres 仍能作为默认共享状态层；Redis 只作为高频限流或缓存优化选项，而不是 V1 必需组件。

### 8.2 数据分组

```text
PostgreSQL database
├── Identity / access
│   ├── agents
│   ├── agent_virtual_models
│   └── console_users
│
├── Provider / model config
│   ├── providers
│   ├── provider_keys
│   └── provider_models (including manual price fields)
│
├── Routing config
│   ├── virtual_models
│   ├── route_policies
│   ├── route_policy_rules
│   └── route_policy_candidates
│
├── Limits
│   ├── agent_limits
│   ├── rate_limit_windows
│   ├── budget_periods
│   └── budget_reservations
│
├── Runtime records
│   ├── request_activity (including request-level config label snapshots)
│   ├── request_usage
│   ├── request_costs (including baseline and savings fields)
│   ├── fallback_events
│   ├── provider_health_events
│   ├── provider_health_summary
│   ├── gateway_runtime_status
│   └── runtime_errors
│
├── Background jobs
│   ├── jobs
│   ├── job_attempts
│   ├── notification_events
│   └── webhook_deliveries
│
├── Billing / pricing
│   └── provider_models manual and synced current price fields
│
├── Config lifecycle
│   ├── config_versions
│   └── migration_history
│
└── Optional content records
    ├── request_prompts
    └── response_outputs
```

Config tables use `deleted_at` for Console delete semantics: Agents, Providers,
Provider Models, Virtual Models, and Route Policies are hidden and disabled when
deleted instead of being physically removed from the database. Runtime history
tables keep restrictive foreign keys to those config rows, so request audit data
remains referentially intact. Request activity also stores minimal label
snapshots for Agent, Virtual Model, Route Policy strategy, Provider, and Provider
Model labels; historical reports prefer those snapshots and fall back to the
joined config rows for older records.

Postgres notification channels：

- `config_changed`：config publisher 在 routing-visible 配置版本提交后发出，Gateway 订阅后加载新 snapshot。
- `job_created`：Console 或 Worker scheduler 创建 job 后发出，Worker 订阅后尽快 claim job。
- `health_summary_changed`：Worker 更新 provider / model health summary 后发出，Gateway 订阅后刷新 in-memory health view。
- `runtime_status_changed`：Gateway 或 Worker 写入关键运行状态变化后可选发出，Console API 可订阅后刷新 Runtime 页面。

所有 channel 都只是 wake-up signal，不承载完整业务状态。完整状态必须从持久化表读取。

### 8.3 凭据与隐私数据

- Provider API Key：加密后存储，只展示 prefix 或 label。
- Subscription Token：如未来支持，必须加密存储，并明确标注 Provider ToS 风险。
- Agent API key：hash/prefix/default Virtual Model 存在 `agents` 上，Allowed Virtual Models 存在 `agent_virtual_models`；明文只在创建 Agent 时展示一次。Playground 无法从 Console 服务端取回既有 key，用户需要自行粘贴明文 key。V1 不支持 rotate/disable/history，key 丢失或泄露时删除并重建 Agent。
- prompt / response 内容：默认不记录；用户显式开启后才进入 optional content records。
- 数据导出：支持导出配置、成本报表和请求 metadata；导出 prompt / response 内容需要用户显式确认。

### 8.4 Secret Master Key 管理

Provider Key 加密不是 Console 的私有能力。Gateway、Console 和 Worker 都需要使用同一套 secret encryption 能力：

- Console：写入或轮换 Provider Key 时加密。
- Gateway：调用真实 Provider 前解密。
- Worker：执行模型发现、价格同步、账单对账和 Provider 健康探测时解密。

master key 归属规则：

- master key 不能存放在 PostgreSQL 业务数据库中。
- Local / single-node 模式：首次初始化时生成 master key，保存到 bootstrap secret file、环境变量或系统 secret store 中。
- Docker / Server 模式：通过环境变量或 mounted secret 注入，例如 `LLMINGRESS_MASTER_KEY`。
- Single binary 模式：supervisor 负责在启动 Gateway、Console、Worker 前加载 master key。
- 数据库中只保存 encrypted secret、key id、算法版本和 key prefix / label。
- master key 丢失后，已加密的 Provider Key 无法恢复，只能由用户重新录入。

Gateway 在 Console 不可用时能继续处理请求的前提包括：Gateway 进程已加载 master key，并且数据库中存在可用配置与 encrypted Provider Key。

### 8.5 Schema Migration 与备份

Migration 是部署期 / 启动期的共享关注点，不属于 Console 独有领域服务。

- `packages/db` 持有 schema 与 migration 定义。
- `scripts/migrate.ts` 是显式 migration 入口。
- Local / single binary supervisor 在升级前调用 `scripts/backup.ts` 做 preflight backup，再运行 migration，再启动 Gateway / Console / Worker。
- Docker / server 模式应在启动应用进程前运行 migration job。
- Gateway、Console、Worker 启动时都检查 schema version；发现版本不兼容时 fail fast，而不是各自尝试隐式修改 schema。
- Worker 可以负责周期性例行备份，但不负责升级前备份；升级前备份属于 supervisor / deployment pipeline 的时序职责。

### 8.6 Postgres 通信约束

Postgres 同时承担持久化和进程间协调，但需要明确语义边界：

- `NOTIFY` 不是 durable queue；如果进程断线，可能错过通知。因此每个消费者都必须在启动和重连后从表中 reconcile 最新状态。
- `config_versions`、`jobs`、`provider_health_summary`、`gateway_runtime_status` 等表是 source of truth。
- Gateway、Console、Worker 应为 `LISTEN/NOTIFY` 使用独立连接，避免长事务阻塞通知接收。
- Worker 多实例消费 job 时使用 Postgres 行锁、advisory lock 或 lease 字段去重；不能只依赖 `job_created` 通知。
- Gateway 的高频请求路径不能每次都同步查询配置；仍必须使用 immutable config snapshot 和 in-memory runtime view。
- 如果未来多 Gateway 实例共享 RPM / TPM / concurrency，需要把这些计数迁移到 Postgres 原子写入、advisory lock、Redis 或其他共享状态组件。

### 8.7 后续扩展路径

当部署形态从单机自托管扩展到更高并发 server / multi-instance，可以增加：

- Redis：用于高频分布式 rate limit、并发计数、短 TTL cache；不用于替代 canonical database。
- Object storage：用于长期归档大量 request content 或导出文件。
- Postgres partition / retention policy：用于长期保存 request_activity、usage、cost 和 audit 数据。
- Read replica：用于较重的报表查询，避免影响 Gateway 写入路径。

这些是扩展选项，不改变 V1 以 Postgres 作为 canonical database 和协调媒介的核心选择。

## 9. 推荐项目目录结构

以下是目标代码目录结构，当前仓库不需要一次性创建全部文件；后续实现时可以按模块逐步落地。

```text
LLMIngress/ # 仓库根目录，承载所有应用、共享包、文档和脚本
├── apps/ # 可独立运行的应用进程
│   ├── gateway/ # Gateway Service 数据面应用
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/ # Gateway 源码目录
│   │       ├── main.ts
│   │       ├── server.ts
│   │       ├── public-api/ # 面向 AI Agent 的公开 API 路由
│   │       │   ├── openai.routes.ts
│   │       │   ├── anthropic.routes.ts
│   │       │   ├── models.routes.ts
│   │       │   └── errors.ts
│   │       ├── pipeline/ # 请求进入 Provider 前的同步处理链路
│   │       │   ├── request-context.ts
│   │       │   ├── authentication.ts
│   │       │   ├── authorization.ts
│   │       │   ├── protocol-normalizer.ts
│   │       │   ├── token-estimator.ts
│   │       │   ├── budget-reservation.ts
│   │       │   └── limits.ts
│   │       ├── runtime/ # Gateway 请求运行时核心逻辑
│   │       │   ├── config-snapshot.ts
│   │       │   ├── config-loader.ts
│   │       │   ├── router-runtime.ts
│   │       │   ├── fallback-runtime.ts
│   │       │   ├── provider-runtime.ts
│   │       │   ├── runtime-counters.ts
│   │       │   ├── health-view.ts
│   │       │   ├── usage-recorder.ts
│   │       │   ├── cost-recorder.ts
│   │       │   └── savings-recorder.ts
│   │       ├── coordination/ # Gateway 与 Postgres 协调通道
│   │       │   ├── postgres-listener.ts
│   │       │   ├── config-reload.ts
│   │       │   ├── runtime-heartbeat.ts
│   │       │   └── reconcile-loop.ts
│   │       └── observability/ # Gateway 观测能力
│   │           ├── logger.ts
│   │           ├── metrics.ts
│   │           └── tracing.ts
│   │
│   ├── worker/ # Background Worker 异步任务应用
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/ # Worker 源码目录
│   │       ├── main.ts
│   │       ├── scheduler.ts
│   │       ├── jobs/ # 具体后台任务实现
│   │       │   ├── model-refresh.job.ts
│   │       │   ├── provider-health.job.ts
│   │       │   ├── price-sync.job.ts
│   │       │   ├── billing-reconciliation.job.ts
│   │       │   ├── alert-evaluation.job.ts
│   │       │   ├── retention-cleanup.job.ts
│   │       │   ├── stale-reservation-cleanup.job.ts
│   │       │   ├── jsonl-export.job.ts
│   │       │   └── backup.job.ts
│   │       └── dispatchers/ # 异步通知和外部投递实现
│   │           ├── notification-event-writer.ts
│   │           └── webhook.ts
│   │
│   └── console/ # Console 控制面 Web 应用
│       ├── package.json
│       ├── tsconfig.json
│       └── src/ # Console 源码目录
│           ├── app/ # Next.js App Router 页面路由
│           │   ├── layout.tsx
│           │   ├── page.tsx
│           │   ├── agents/ # Agents 页面路由
│           │   ├── providers/ # Providers 页面路由
│           │   ├── models/ # Models 页面路由
│           │   ├── routes/ # Virtual Models / Routes 页面路由
│           │   ├── activity/ # Activity 请求记录页面路由
│           │   ├── usage/ # Usage & Cost 页面路由
│           │   ├── limits/ # Limits 页面路由
│           │   ├── runtime/ # Gateway Runtime 页面路由
│           │   ├── playground/ # Playground 页面路由
│           │   └── settings/ # Settings 页面路由
│           ├── features/ # 按业务功能组织的页面逻辑和组件
│           │   ├── agents/ # Agent 管理功能模块
│           │   ├── providers/ # Provider 配置功能模块
│           │   ├── models/ # 模型库展示功能模块
│           │   ├── route-policies/ # Virtual Model 和路由策略功能模块
│           │   ├── activity/ # 请求记录功能模块
│           │   ├── usage/ # Usage 与 Cost 图表功能模块
│           │   ├── limits/ # Budget、RPM、TPM、并发限制功能模块
│           │   ├── runtime/ # Gateway 运行状态功能模块
│           │   └── jobs/ # Worker job 管理功能模块
│           ├── server/ # Console server-side 入口和后端适配
│           │   ├── console-api.ts
│           │   ├── auth.ts
│           │   ├── runtime-query.ts
│           │   ├── job-client.ts
│           │   └── import-export.ts
│           └── components/ # Console 通用 UI 组件
│               ├── navigation/ # 导航组件
│               ├── tables/ # 表格组件
│               ├── forms/ # 表单组件
│               ├── charts/ # 图表组件
│               └── runtime-status/ # 运行状态组件
│
├── packages/ # Gateway、Console、Worker 共享的内部包
│   ├── domain/ # 领域模型和核心业务类型
│   │   └── src/ # domain package 源码目录
│   │       ├── agents/ # Agent 领域类型
│   │       ├── providers/ # Provider 领域类型
│   │       ├── models/ # 模型元数据领域类型
│   │       ├── route-policies/ # 路由策略领域类型
│   │       ├── limits/ # 限流和预算领域类型
│   │       └── usage/ # Usage 和 Cost 领域类型
│   │
│   ├── db/ # 数据库 schema、migration 和 repository
│   │   └── src/ # db package 源码目录
│   │       ├── schema/ # 后续 Drizzle schema 定义
│   │       ├── migrations/ # SQL 数据库迁移文件
│   │       ├── repositories/ # 数据访问封装
│   │       ├── connection.ts
│   │       └── schema-version.ts
│   │
│   ├── protocol/ # 外部协议和归一化协议定义
│   │   └── src/ # protocol package 源码目录
│   │       ├── openai/ # OpenAI-compatible 协议类型
│   │       ├── anthropic/ # Anthropic-compatible 协议类型
│   │       ├── provider/ # Provider adapter 协议类型
│   │       └── normalized/ # Gateway 内部归一化协议类型
│   │
│   ├── routing/ # 确定性路由规则引擎
│   │   └── src/ # routing package 源码目录
│   │       ├── policy-types.ts
│   │       ├── policy-compiler.ts
│   │       ├── rule-engine.ts
│   │       ├── model-selector.ts
│   │       └── route-reason.ts
│   │
│   ├── providers/ # 真实 Provider adapter 实现
│   │   └── src/ # providers package 源码目录
│   │       ├── provider-adapter.ts
│   │       ├── provider-templates/ # 白名单 Provider 模板
│   │       ├── openai-compatible/ # 通用 OpenAI-compatible adapter
│   │       ├── openai/ # OpenAI Provider adapter
│   │       ├── anthropic/ # Anthropic Provider adapter
│   │       ├── google/ # Google Gemini Provider adapter
│   │       ├── openrouter/ # OpenRouter Provider adapter
│   │       └── ollama/ # Ollama / local provider adapter
│   │
│   ├── security/ # 凭据、认证和权限安全工具
│   │   └── src/ # security package 源码目录
│   │       ├── api-key.ts
│   │       ├── secret-encryption.ts
│   │       ├── master-key.ts
│   │       ├── console-auth.ts
│   │       └── permissions.ts
│   │
│   ├── observability/ # 观测事件、指标和导出格式
│   │   └── src/ # observability package 源码目录
│   │       ├── activity-events.ts
│   │       ├── usage-events.ts
│   │       ├── metrics.ts
│   │       ├── traces.ts
│   │       ├── webhook-events.ts
│   │       └── jsonl-logs.ts
│   │
│   ├── jobs/ # 后台任务通用模型和执行抽象
│   │   └── src/ # jobs package 源码目录
│   │       ├── job-types.ts
│   │       ├── job-lease.ts
│   │       ├── job-runner.ts
│   │       └── job-results.ts
│   │
│   ├── billing/ # 成本估算、价格表和账单对账
│   │   └── src/ # billing package 源码目录
│   │       ├── cost-estimator.ts
│   │       ├── price-registry.ts
│   │       ├── savings.ts
│   │       └── reconciliation.ts
│   │
│   ├── notifications/ # 告警规则和通知目标模型
│   │   └── src/ # notifications package 源码目录
│   │       ├── alert-rules.ts
│   │       ├── notification-events.ts
│   │       └── delivery-targets.ts
│   │
│   ├── config/ # 配置发布、校验和 runtime settings
│   │   └── src/ # config package 源码目录
│   │       ├── config-version.ts
│   │       ├── config-publisher.ts
│   │       ├── config-validation.ts
│   │       ├── dependency-check.ts
│   │       └── runtime-settings.ts
│   │
│   ├── coordination/ # Postgres 进程间协调契约
│   │   └── src/ # coordination package 源码目录
│   │       ├── channels.ts
│   │       ├── notification-payloads.ts
│   │       ├── listener.ts
│   │       └── locks.ts
│   │
│   └── ui/ # Console 共享 UI 基础包
│       └── src/ # ui package 源码目录
│           ├── components/ # 可复用基础组件
│           ├── hooks/ # Console 共享 React hooks
│           └── styles/ # Tailwind / 全局样式入口
│
├── docs/ # 产品、架构和设计文档
│   ├── PRODUCT.md
│   ├── ARCHITECTURE.md
│   └── PLAN.md
│
├── scripts/ # 本地开发、迁移和维护脚本
│   ├── dev.ts
│   ├── migrate.ts
│   ├── check-schema.ts
│   └── backup.ts
│
├── package.json
├── pnpm-workspace.yaml
├── turbo.json
└── tsconfig.base.json
```

## 10. 模块边界建议

### 10.1 Gateway app 只做运行时编排

`apps/gateway` 负责 HTTP 服务、请求 pipeline、streaming、Provider 调用、Postgres notification 驱动的热加载和运行数据写入。领域规则尽量放在 `packages/routing`、`packages/domain`、`packages/providers` 中，避免 Gateway app 变成大而全的业务仓库。

### 10.2 Console app 只做控制面体验

`apps/console` 负责页面、表单、配置操作、Activity / Usage 展示、Worker job 状态和 Runtime 状态查看。依赖检查、调用共享 config publisher、导入导出等控制面入口可以放在 Console server 层，但共享类型和领域规则仍应放在 packages 中。

### 10.3 Worker app 承载异步任务

`apps/worker` 负责周期任务和异步任务执行，包括模型刷新、Provider 健康探测、价格同步、账单对账、告警评估、通知投递、日志保留和周期性备份任务。Worker 可以使用 `packages/providers` 和 `packages/security` 解密并调用 Provider，但不能承接 Agent 的同步模型请求。

### 10.4 Shared packages 保持协议稳定

Agent 协议、Provider 协议、Route Policy、配置发布、配置校验、Postgres notification channel、数据库 schema 和安全工具都应作为共享 package 管理。这样 Gateway、Console 和 Worker 对同一个配置对象使用同一套类型定义、校验规则和协调契约。

## 11. 部署形态

### 11.1 Local / Single-Node

- Gateway 默认监听 `127.0.0.1`。
- Console 默认只允许本机访问。
- Gateway、Console 和 Worker 可以由同一个 local supervisor 或 process manager 启动和监控。
- V1 只支持一个 active Gateway 进程处理请求；可以有多个 Worker，但需要通过 Postgres job lease 去重。
- 需要配置 PostgreSQL connection string；本地模式可以使用本机 Postgres、Docker Compose Postgres 或托管 Postgres。
- Provider Key 加密存储。
- 适合个人电脑、本地服务器或轻量自托管运行形态。

### 11.2 Docker / Server

- Gateway、Console 和 Worker 可以作为多个进程运行，也可以由同一个 supervisor 管理。
- 非 localhost 监听必须启用 Console 登录。
- PostgreSQL 是必需依赖，负责持久化、配置热加载通知、job 唤醒和 runtime status 共享。
- 应通过 network policy、防火墙和最小权限数据库 role 限制 Postgres 访问。
- 数据目录只保存导出文件、备份文件或可选本地缓存，不保存 canonical database。

### 11.3 Single Binary

- 后续可以把 Gateway、Console 静态资源、Worker、migration 和 runtime supervisor 打包成单个分发物。
- Single Binary 默认形态是应用单二进制 + 外部 PostgreSQL，或由 compose / supervisor 管理的本机 PostgreSQL sidecar；它不是零依赖单文件数据库形态。
- 架构上仍保留 Gateway 数据面和 Console 控制面的边界。

## 12. 关键架构决策

- TypeScript 贯穿 Gateway、Console、Worker 和共享 packages，减少协议与配置类型漂移。
- Gateway 使用 Fastify，优先满足 streaming、低延迟、Public API 和插件化请求 pipeline。
- Console 使用 Next.js，优先满足本地管理控制台、表单配置、数据展示和鉴权引导。
- Background Worker 承载模型发现、价格同步、账单对账、告警通知、日志保留、JSONL / webhook export 和周期性备份任务。
- PostgreSQL 作为 V1 默认 canonical database，并作为 Gateway、Console、Worker 之间的通信媒介。
- `packages/config` 提供共享 config publisher；Console 和 Worker 都通过它发布 routing-visible config version。
- Config publisher 通过 Postgres `LISTEN/NOTIFY` 唤醒 Gateway 是 fast path，Gateway 周期 reconcile 是 safety path。
- Gateway 只暴露 Public API；Console 和 Worker 不调用 Gateway 私有控制接口。
- Console 对 Gateway 的控制反馈是异步最终一致的，以 Postgres 中的 applied config version、heartbeat 和 failure event 为准。
- V1 只支持单 active Gateway 进程；多 Gateway 需要先引入共享限流、预算和并发计数状态。
- Gateway 使用 immutable config snapshot，新请求即时使用新配置，进行中的请求不受影响。
- `/v1/responses` V1 支持无状态子集，不默认实现跨 Provider response state。
- Console 不进入 Agent 请求路径，Gateway 在 Console 暂时不可用时仍应能继续处理请求。
- Console 删除配置默认写入 `deleted_at` 软删除；Agents、Providers、Provider Models、Virtual Models 和 Route Policies 的 active 查询都过滤 deleted rows。
- Runtime history 表继续使用 restrictive foreign keys，不 cascade、不 set null；硬删除只作为维护操作，并且必须确认没有 active 配置依赖和没有 runtime history 引用。
- Provider 派生模型数据仍使用 availability marker 表达 refresh 结果；Provider Model 被软删除后不会参与 active routing、price sync 或 health checks。
- Route Policy 的候选模型统一存放在 `route_policy_candidates`，构成单一有序候选池，仅用 `candidate_order` 表达顺序；不再使用 `is_fallback` 区分主/备候选，完整的 fallback 链在请求时由 route policy 的 `strategy`（`fixed` 按 `candidate_order`、`cost_first`/`quality_first` 按估算成本、`random` 随机）推导，并按 provider/model 健康状态排除不可用候选；不单独维护 `fallback_chain_items` 表。
- OpenAI-compatible 长尾 Provider 通过内置白名单 template 复用通用 adapter，不开放任意自定义 endpoint。
- Playground 使用 Gateway Public API 测试；用户手动输入 Agent API key 并选择 Virtual Model Name，Console 后端不代理请求也不保存该 key。
- Gateway 拥有同步限流、预算预留、并发计数和 in-memory health view；数据库保存可恢复的窗口、预算周期累计、健康事件和 health summary。
- Gateway 在请求路径记录 baseline cost 和 request savings；Console 聚合展示，Worker 只在成本对账后修正 actual cost / savings。
- Runtime settings 区分 hot-reloadable 与 restart-required；监听地址、端口、数据目录等由 supervisor 重启生效。
- master key 存储在数据库之外，由 Gateway、Console、Worker 共享加载；Postgres 连接凭据与 master key 分离。
- Migration 和升级前备份是部署期 / supervisor 关注点，不属于 Console 私有服务。
- Provider Key 加密存储，Agent API key hash 存储，prompt / response 默认不落库。
