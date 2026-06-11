# LLMIngress Architecture Design

> 本文基于 `docs/PRODUCT.md` 输出 Gateway Service 与 Console 控制台的目标架构设计。本文只聚焦架构边界、模块职责、技术选型、数据存储与项目目录结构，不展开具体代码实现细节。

## 1. 架构目标

LLMIngress 是单用户、自托管的 AI Agent Gateway。产品上分为两个核心平面：

- Gateway Service：数据面，接收 AI Agent 请求，执行鉴权、预算检查、路由决策、Provider 转发、Fallback 和用量记录。
- Console：控制面，负责配置管理、运行状态查看、Activity / Usage 展示、预算与限流配置，以及接入引导。

运行时还需要一个后台任务平面：

- Background Worker / Scheduler：异步任务面，负责告警评估、通知投递、模型发现、价格同步、账单对账、日志保留、JSONL / webhook export、升级前备份和周期性维护任务。

核心设计约束：

- AI Agent 只直接访问 Gateway Service，不直接访问 Console。
- Console 修改的是 Gateway 运行所需配置，不处理 Agent 的模型请求流量。
- Console 不直接调用真实 Provider；Provider 出网调用由 Gateway 的请求路径或 Background Worker 的异步任务负责。
- Gateway 对新请求使用最新配置；已进入处理流程的请求继续使用进入时捕获的配置快照。
- Gateway 在 Console 不可用时仍可继续处理请求，前提是已有可用配置快照、数据库连接和可用的 secret master key。
- Background Worker 不在 AI Agent 的同步请求路径上；Worker 暂停只影响异步能力，不应阻断 Gateway 处理新请求。
- 默认面向本地或单机自托管部署，不以多租户 SaaS 为 V1 架构目标。

## 2. TypeScript 技术栈选择

LLMIngress 使用 TypeScript 统一 Gateway、Console 和共享领域模型，降低协议、配置和数据结构在前后端之间漂移的风险。

| 层级 | 选型 | 作用 |
| --- | --- | --- |
| Monorepo | pnpm workspace + Turborepo | 管理 Gateway、Console 和共享 packages，支持分包构建与复用 |
| Runtime | Node.js | 统一运行 Gateway、Console API、后台任务与 CLI |
| Gateway Service | Fastify | 承载高吞吐 HTTP API、流式响应、插件化 middleware、内部控制 API |
| Console Web | Next.js App Router + React | 构建管理控制台、服务端渲染页面、Console API routes |
| Background Worker | Node.js worker process + database-backed scheduler | 承载周期任务、异步任务、通知投递、模型刷新、价格同步和日志清理 |
| UI | Tailwind CSS + shadcn/ui + lucide-react | 控制台 UI、表格、表单、图标、弹窗、导航等基础组件 |
| Client state | TanStack Query | Console 页面读取配置、状态、Activity 与 Usage 数据 |
| Chart | Recharts | Usage、Cost、Latency、Fallback 等图表 |
| Schema / validation | Zod | 共享请求、配置、路由策略、Provider 配置与 Console 表单校验 |
| Database access | Drizzle ORM | TypeScript-first schema、migration、查询类型约束 |
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
  ├── Agent API Key 鉴权
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
  │
  ▼
Console
  ├── Agents / Providers / Models / Routes / Limits 管理
  ├── Activity / Usage / Cost 展示
  ├── Gateway Runtime 状态查看
  └── 配置变更发布

Background Worker / Scheduler
  ├── Model discovery / refresh
  ├── Price sync / billing reconciliation
  ├── Alerts / notifications
  ├── Retention / cleanup
  ├── JSONL / webhook export
  └── Backup / migration preflight tasks

Gateway Service ◄── internal control API / local event ── Console
        │                                      │
        ├────────────── Shared Database ──────┤
        │                                      │
        └──────── Background Worker ──────────┘
```

Gateway、Console 与 Background Worker 共享同一个持久化数据库：

- Console 写入配置数据，并发布配置版本变更。
- Gateway 读取配置数据，构建内存中的只读配置快照。
- Gateway 写入请求 metadata、usage、cost、fallback、error 等运行数据。
- Console 读取 Gateway 运行数据，用于 Activity、Usage 和 Runtime 页面展示。
- Background Worker 读取配置、运行数据和待处理任务，写回模型库、价格、告警、通知、对账结果和清理状态。

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
│   ├── Agent API Key authentication
│   ├── Agent permission check
│   ├── Protocol normalization
│   ├── Request metadata extraction
│   ├── Token estimate / budget reservation
│   └── Rate limit / concurrency check
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
│   ├── Error / fallback recorder
│   ├── Metrics exporter
│   └── Trace exporter
│
└── Internal Control Plane
    ├── Config reload endpoint
    ├── Runtime status endpoint
    ├── Provider connectivity check endpoint
    ├── Playground simulation endpoint
    └── Applied config version endpoint
```

### 4.1 Public API Layer

Gateway 对 AI Agent 暴露统一 endpoint，优先覆盖：

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/messages`
- `POST /v1/embeddings`
- `GET /v1/models`

其中 `GET /v1/models` 返回当前 Agent API Key 被授权使用的 Virtual Model Name，不直接暴露真实 Provider 模型列表。

### 4.2 Routing Runtime

Routing Runtime 使用确定性规则引擎，不在 V1 默认额外调用 LLM 分类器。它根据以下输入选择真实 Provider 与 Model：

- Agent API Key。
- Agent 类型。
- Virtual Model Name。
- Route Policy。
- 请求协议。
- 输入 token 估算。
- tools / function calling 需求。
- context window 需求。
- coding、reasoning、terminal、repo、long context 等任务特征。
- Provider / Model 健康状态。
- Route Policy 配置的成本偏好和 Fallback Chain。

路由结果必须产出用户可理解的 route reason，供响应 metadata 与 Activity 页面展示。

### 4.3 Config Snapshot

Gateway 不在每个请求中直接拼装完整配置，而是在内存中维护一个 immutable config snapshot：

- snapshot 来源于数据库中的 Agents、Agent API Keys、Providers、Models、Virtual Models、Route Policies、Limits 等配置。
- 每次配置热加载生成新的 snapshot。
- 新请求读取当前最新 snapshot。
- 已开始处理的请求继续使用它进入 pipeline 时捕获的 snapshot。
- 如果新配置加载或校验失败，Gateway 保留上一份可用 snapshot。

该设计保证配置更新不会影响进行中的 streaming 请求，也能避免运行时配置读到半更新状态。

### 4.4 Runtime Counter State

Gateway 负责同步请求路径中的可变计数状态，不能把这些状态放进 immutable config snapshot，也不能在每个请求上实时聚合全量 `request_usage`。

运行时状态归属：

- RPM / TPM window：Gateway 在内存中维护当前窗口的快速计数，并把窗口累计值周期性或按请求写入数据库，用于重启恢复和 Console 展示。
- Concurrency：Gateway 在内存中维护当前进程内的并发计数，请求结束或取消时释放；Gateway 重启后并发计数自然归零。
- Budget period：数据库保存每个 Agent API Key 当前预算周期的累计 token、cost 和 reservation；Gateway 在请求开始时做预算预留，在请求结束后用实际或估算 usage 结算。
- Usage record：`request_usage` 是审计与分析记录，不是同步限流检查的唯一来源。

TPM 和预算检查依赖 token 估算，因此 Gateway pipeline 必须先完成协议归一化、metadata extraction 和 token estimate，再执行 token / budget / TPM 检查。

SQLite 单机模式下，Gateway 是运行时计数写入的主要 owner。未来多 Gateway 实例模式需要把 RPM / TPM / concurrency 状态迁移到 Redis 或 Postgres advisory lock 等共享状态组件，不能继续只依赖单进程内存。

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
│   ├── Config publisher
│   ├── Secret encryption client
│   └── Import / export service
│
└── Gateway Connector
    ├── Internal reload notification
    ├── Gateway status query
    ├── Provider connectivity query
    ├── Model refresh job trigger
    └── Playground simulation request
```

Console 的关键职责：

- 写入并校验配置。
- 在禁用或删除 Provider、Model、Route Policy 前做依赖检查。
- 对 Provider Key 做加密写入，对 Agent API Key 做 hash 存储。
- 生成 Agent 接入说明和可复制配置。
- 展示 Gateway 写入的 Activity、Usage、Cost、Fallback 和错误数据。
- 管理 Gateway Runtime 设置，例如监听地址、端口、日志保留和数据导入导出。
- 为模型刷新、价格同步、备份、日志清理等异步动作创建后台任务，而不是直接在 Console 请求中执行长耗时 Provider 调用。

Console 不承担 Provider 请求转发，也不参与 AI Agent 的实时请求路径。Console 可以发起控制动作，但真实 Provider 出网调用由 Gateway 或 Background Worker 执行。

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
│   ├── Desktop notification dispatcher
│   ├── Email dispatcher
│   └── Webhook dispatcher
│
├── Data Maintenance
│   ├── Request log retention
│   ├── Optional content cleanup
│   ├── JSONL request log export
│   └── Cost report export
│
└── Lifecycle Maintenance
    ├── Upgrade preflight backup
    ├── Database maintenance
    └── Migration status check
```

Worker 的 owner 规则：

- Worker 不是配置源头；配置仍由 Console 写入数据库。
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
  ├── update provider_models
  └── publish config version if routing-visible data changed
```

触发方式：

- 自动刷新：新增或启用 Provider 后，Console 创建一次模型刷新任务。
- 手动刷新：用户在 Console 点击 refresh，Console 创建一次模型刷新任务。
- 周期刷新：Worker 按配置周期刷新模型列表和健康状态。

Gateway 的 `GET /v1/models` 不走 Provider discovery，它只基于当前 config snapshot 返回 Agent API Key 被授权使用的 Virtual Model Name。

### 6.2 价格同步与账单对账

Gateway 在请求结束时先写入 usage 和估算成本，保证 Activity 与 Usage 页面能及时展示。Background Worker 再负责异步对账：

- Provider 支持返回实际 usage / billing 数据时，Worker 周期性拉取并写入 actual cost。
- Provider 不支持实际计费数据时，继续使用 token 估算成本，并标记 cost source 为 estimated。
- 对账结果不改变原始 request activity，只补充 cost source、actual cost、reconciled at 等字段。

这样满足“优先采用 Provider 实际计费数据，无法获得时才使用估算值”的产品口径，同时不把账单 API 调用放进 Gateway 请求路径。

## 7. Gateway、Console 与 Worker 的交互

Gateway、Console 与 Worker 的交互分为五类：配置写入、配置热加载、运行数据读取、异步任务调度、内部模拟请求。

### 7.1 配置写入链路

```text
User
  ▼
Console Web
  ▼
Console API
  ▼
Config validation / dependency check
  ▼
Database transaction
  ├── write config tables
  ├── increment config version
  └── append config change event
```

Console 修改配置时先进行结构校验和依赖检查，再在同一个事务中写入配置表并递增全局配置版本。配置版本是 Gateway 判断是否需要热加载的核心依据。

### 7.2 热加载通知链路

推荐采用“主动通知 + 周期 reconcile”的组合，而不是只依赖单一通知机制。

```text
Console API
  │
  │ 1. POST internal reload notification
  ▼
Gateway Internal Control Plane
  │
  │ 2. read latest config version from database
  ▼
Config Loader
  │
  │ 3. build and validate new immutable snapshot
  ▼
Atomic Snapshot Swap
  │
  │ 4. new requests use latest snapshot
  ▼
Runtime status records applied config version
```

热加载策略：

- Fast path：Console 写入配置后，调用 Gateway internal control API，通知 Gateway 加载指定 config version。
- Safety path：Gateway 启动时加载最新配置，并周期性检查数据库中的 config version；即使主动通知失败，也能最终发现配置变化。
- Same-process deployment：如果 Gateway 和 Console 被同一个进程 supervisor 管理，可以用本地事件总线替代 HTTP 通知，但抽象上仍视为 control message。
- Separate-process deployment：Console 通过只绑定 loopback 或内网地址的 internal control API 通知 Gateway，并使用 internal control token 做请求认证。
- Multi-gateway future：如果未来支持多个 Gateway 实例，可把通知层替换为 Postgres `LISTEN/NOTIFY`、Redis Pub/Sub 或 NATS；V1 不需要引入这些基础设施。

热加载失败处理：

- Gateway 对新 snapshot 做完整校验。
- 校验失败时不切换 snapshot。
- Gateway 记录 reload failure event。
- Console 的 Gateway Runtime 页面展示目标版本、已应用版本和失败原因。
- 用户修复配置后再次发布新版本。

### 7.3 运行数据读取链路

Gateway 处理请求后写入运行数据：

```text
Gateway Request Pipeline
  ├── Activity records
  ├── Usage records
  ├── Cost records
  ├── Fallback events
  ├── Error events
  └── Provider health snapshots
        ▼
      Database
        ▼
      Console Activity / Usage / Runtime pages
```

Console 从数据库读取 Activity、Usage、Cost、Runtime 状态和 Worker job 状态。对于实时刷新页面，可以由 Console Web 使用 polling、SSE 或 WebSocket 拉取 Console API；这属于 UI 实时性选择，不改变 Gateway、Console 与 Worker 的核心边界。

### 7.4 异步任务调度链路

Console 对耗时或周期性动作只创建任务，不直接执行 Provider 出网调用或长耗时维护动作。

```text
Console API
  ▼
create job record
  ├── model_refresh
  ├── price_sync
  ├── billing_reconciliation
  ├── retention_cleanup
  ├── webhook_export
  └── backup_before_upgrade
      ▼
Background Worker
  ├── acquire job lease
  ├── execute job
  ├── write job result
  └── publish config version if needed
```

Worker job 使用数据库中的 job lease 做去重，避免同一个任务被多个 worker 同时执行。V1 单机模式可以只运行一个 Worker；未来多实例模式需要更严格的分布式锁或队列组件。

### 7.5 Playground 模拟请求链路

Playground 不能依赖 Agent API Key 明文，因为 Agent API Key 只 hash 存储，Console 也只在创建或轮换时展示一次。因此 Playground 使用 Gateway 的内部受信模拟通道，而不是伪造公开 API 请求。

```text
User
  ▼
Console Playground
  ▼
Console API
  ▼
Gateway internal simulation endpoint
  ├── internal control token authentication
  ├── console user authorization check
  ├── simulate selected agent_api_key_id
  ├── apply same permissions / limits / route policy
  ├── dry-run route decision or live provider call
  └── record playground activity
```

Playground 模式：

- Dry run：只执行鉴权模拟、权限检查、路由决策和 route reason，不调用真实 Provider，不产生 Provider 成本，不计入 Budget。
- Live test：调用真实 Provider，记录 `source = playground` 的 Activity / Usage / Cost；由于会产生真实 Provider 成本，默认计入该 Agent API Key 的 Budget / Token Limit，但在 Usage 页面可单独筛选。

这条链路让 Console 可以“选择 Agent API Key”做测试，同时不需要保存或重新获取 Agent API Key 明文。

### 7.6 Internal Control API 鉴权

Gateway internal control API 不能只依赖 loopback 或容器网络边界。

- 本地 / desktop 模式：supervisor 生成 internal control token，并注入 Gateway、Console、Worker 进程。
- Docker / server 模式：internal control token 通过环境变量或 mounted secret 注入。
- Console 调用 Gateway internal endpoint 时必须携带 internal control token。
- Worker 如需调用 Gateway runtime status 或 simulation 类内部 endpoint，也使用同一类内部凭据。
- internal control token 与 secret master key 是不同用途的凭据，不能混用。

## 8. 数据存储选型

### 8.1 默认选择：SQLite + WAL

V1 默认使用 SQLite 作为本地 canonical database，并开启 WAL 模式。

选择原因：

- 产品定位是单用户、自托管，SQLite 的部署复杂度最低。
- 支持个人电脑、本地服务器和轻量 Docker 部署。
- 数据文件易备份、导入、导出和迁移。
- 配置数据、请求 metadata、usage、cost、fallback event 都是强结构化数据，适合关系模型。
- WAL 模式适合 Console 读写配置、Gateway 持续写入 usage/activity 的单机并发场景。

不建议 V1 默认依赖 Postgres 或 Redis：

- Postgres 增加本地部署门槛，更适合作为后续 server / multi-instance 模式选项。
- Redis 适合分布式限流、pub/sub 或共享缓存，但 V1 单机默认架构不需要额外缓存服务。

### 8.2 数据分组

```text
SQLite database
├── Identity / access
│   ├── agents
│   ├── agent_api_keys
│   └── console_users
│
├── Provider / model config
│   ├── providers
│   ├── provider_keys
│   ├── provider_models
│   └── model_price_overrides
│
├── Routing config
│   ├── virtual_models
│   ├── route_policies
│   ├── route_policy_rules
│   ├── route_policy_candidates
│   └── fallback_chain_items
│
├── Limits
│   ├── agent_limits
│   ├── rate_limit_windows
│   ├── budget_periods
│   └── budget_reservations
│
├── Runtime records
│   ├── request_activity
│   ├── request_usage
│   ├── request_costs
│   ├── fallback_events
│   ├── provider_health_events
│   └── runtime_errors
│
├── Background jobs
│   ├── jobs
│   ├── job_attempts
│   ├── notification_events
│   ├── webhook_deliveries
│   └── export_tasks
│
├── Billing / pricing
│   ├── price_registry_snapshots
│   ├── billing_reconciliation_runs
│   └── billing_reconciliation_items
│
├── Config lifecycle
│   ├── config_versions
│   ├── config_change_events
│   └── migration_history
│
└── Optional content records
    ├── request_prompts
    └── response_outputs
```

### 8.3 凭据与隐私数据

- Provider API Key：加密后存储，只展示 prefix 或 label。
- Subscription Token：如未来支持，必须加密存储，并明确标注 Provider ToS 风险。
- Agent API Key：只保存 hash，不保存明文；Console 只在创建或轮换时展示一次。
- prompt / response 内容：默认不记录；用户显式开启后才进入 optional content records。
- 数据导出：支持导出配置、成本报表和请求 metadata；导出 prompt / response 内容需要用户显式确认。

### 8.4 Secret Master Key 管理

Provider Key 加密不是 Console 的私有能力。Gateway、Console 和 Worker 都需要使用同一套 secret encryption 能力：

- Console：写入或轮换 Provider Key 时加密。
- Gateway：调用真实 Provider 前解密。
- Worker：执行模型发现、价格同步、账单对账和 Provider 健康探测时解密。

master key 归属规则：

- master key 不能存放在 SQLite 数据库中。
- Local / Desktop 模式：首次初始化时生成 master key，优先保存到系统 Keychain；不支持 Keychain 的环境可退化为用户数据目录中的权限受限 secret file。
- Docker / Server 模式：通过环境变量或 mounted secret 注入，例如 `LLMINGRESS_MASTER_KEY`。
- Single binary 模式：supervisor 负责在启动 Gateway、Console、Worker 前加载 master key。
- 数据库中只保存 encrypted secret、key id、算法版本和 key prefix / label。
- master key 丢失后，已加密的 Provider Key 无法恢复，只能由用户重新录入。

Gateway 在 Console 不可用时能继续处理请求的前提包括：Gateway 进程已加载 master key，并且数据库中存在可用配置与 encrypted Provider Key。

### 8.5 Schema Migration 与备份

Migration 是部署期 / 启动期的共享关注点，不属于 Console 独有领域服务。

- `packages/db` 持有 schema 与 migration 定义。
- `scripts/migrate.ts` 是显式 migration 入口。
- Desktop / single binary supervisor 在升级前先触发备份，再运行 migration，再启动 Gateway / Console / Worker。
- Docker / server 模式应在启动应用进程前运行 migration job。
- Gateway、Console、Worker 启动时都检查 schema version；发现版本不兼容时 fail fast，而不是各自尝试隐式修改 schema。

### 8.6 SQLite 部署约束

SQLite + WAL 是 V1 默认存储，但需要明确部署边界：

| 部署组合 | V1 建议 | 说明 |
| --- | --- | --- |
| 单进程 supervisor + SQLite 本地文件 | 推荐 | Gateway、Console、Worker 由同一 supervisor 管理，最适合 desktop / single binary |
| 同机多进程 + SQLite 本地文件 | 支持但需限制写入压力 | 适合轻量 server；Gateway 是高频写入 owner，Worker 避免大批量长事务 |
| Docker 单机 volume + SQLite | 谨慎支持 | 只建议本机 volume；不建议网络文件系统 |
| 多主机 / 多 Gateway + SQLite | 不支持 | 应切换 Postgres，并引入共享限流状态 |
| 高并发 server / 长期运行服务 | 建议 Postgres | SQLite 可作为本地默认，不作为高并发 server 默认 |

### 8.7 后续扩展路径

当部署形态从单机自托管扩展到 server / multi-instance，可以增加：

- Postgres：替代 SQLite 作为 server 模式 canonical database。
- Redis：用于分布式 rate limit、并发计数、pub/sub 热加载通知。
- Object storage：用于长期归档大量 request content 或导出文件。

这些是扩展选项，不进入 V1 默认依赖。

## 9. 推荐项目目录结构

以下是目标代码目录结构，当前仓库不需要一次性创建全部文件；后续实现时可以按模块逐步落地。

```text
LLMIngress/
├── apps/
│   ├── gateway/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── main.ts
│   │       ├── server.ts
│   │       ├── public-api/
│   │       │   ├── openai.routes.ts
│   │       │   ├── anthropic.routes.ts
│   │       │   ├── models.routes.ts
│   │       │   └── errors.ts
│   │       ├── pipeline/
│   │       │   ├── request-context.ts
│   │       │   ├── authentication.ts
│   │       │   ├── authorization.ts
│   │       │   ├── protocol-normalizer.ts
│   │       │   ├── token-estimator.ts
│   │       │   ├── budget-reservation.ts
│   │       │   └── limits.ts
│   │       ├── runtime/
│   │       │   ├── config-snapshot.ts
│   │       │   ├── config-loader.ts
│   │       │   ├── router-runtime.ts
│   │       │   ├── fallback-runtime.ts
│   │       │   ├── provider-runtime.ts
│   │       │   ├── runtime-counters.ts
│   │       │   ├── usage-recorder.ts
│   │       │   └── cost-recorder.ts
│   │       ├── control-plane/
│   │       │   ├── internal-auth.ts
│   │       │   ├── reload.routes.ts
│   │       │   ├── status.routes.ts
│   │       │   ├── provider-check.routes.ts
│   │       │   └── playground-simulation.routes.ts
│   │       └── observability/
│   │           ├── logger.ts
│   │           ├── metrics.ts
│   │           └── tracing.ts
│   │
│   ├── worker/
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── main.ts
│   │       ├── scheduler.ts
│   │       ├── jobs/
│   │       │   ├── model-refresh.job.ts
│   │       │   ├── provider-health.job.ts
│   │       │   ├── price-sync.job.ts
│   │       │   ├── billing-reconciliation.job.ts
│   │       │   ├── alert-evaluation.job.ts
│   │       │   ├── retention-cleanup.job.ts
│   │       │   ├── jsonl-export.job.ts
│   │       │   └── backup-before-upgrade.job.ts
│   │       └── dispatchers/
│   │           ├── desktop-notification.ts
│   │           ├── email.ts
│   │           └── webhook.ts
│   │
│   ├── console/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── app/
│           │   ├── layout.tsx
│           │   ├── page.tsx
│           │   ├── agents/
│           │   ├── providers/
│           │   ├── models/
│           │   ├── routes/
│           │   ├── activity/
│           │   ├── usage/
│           │   ├── limits/
│           │   ├── runtime/
│           │   ├── playground/
│           │   └── settings/
│           ├── features/
│           │   ├── agents/
│           │   ├── providers/
│           │   ├── models/
│           │   ├── route-policies/
│           │   ├── activity/
│           │   ├── usage/
│           │   ├── limits/
│           │   ├── runtime/
│           │   └── jobs/
│           ├── server/
│           │   ├── console-api.ts
│           │   ├── auth.ts
│           │   ├── gateway-connector.ts
│           │   ├── config-publisher.ts
│           │   ├── job-client.ts
│           │   └── import-export.ts
│           └── components/
│               ├── navigation/
│               ├── tables/
│               ├── forms/
│               ├── charts/
│               └── runtime-status/
│
│   └── desktop-shell/
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── main.ts
│           ├── process-supervisor.ts
│           ├── tray.ts
│           ├── keychain.ts
│           └── first-run.ts
│
├── packages/
│   ├── domain/
│   │   └── src/
│   │       ├── agents/
│   │       ├── providers/
│   │       ├── models/
│   │       ├── route-policies/
│   │       ├── limits/
│   │       └── usage/
│   │
│   ├── db/
│   │   └── src/
│   │       ├── schema/
│   │       ├── migrations/
│   │       ├── repositories/
│   │       ├── connection.ts
│   │       └── schema-version.ts
│   │
│   ├── protocol/
│   │   └── src/
│   │       ├── openai/
│   │       ├── anthropic/
│   │       ├── provider/
│   │       └── normalized/
│   │
│   ├── routing/
│   │   └── src/
│   │       ├── policy-types.ts
│   │       ├── policy-compiler.ts
│   │       ├── rule-engine.ts
│   │       ├── model-selector.ts
│   │       └── route-reason.ts
│   │
│   ├── providers/
│   │   └── src/
│   │       ├── provider-adapter.ts
│   │       ├── openai/
│   │       ├── anthropic/
│   │       ├── google/
│   │       ├── openrouter/
│   │       └── ollama/
│   │
│   ├── security/
│   │   └── src/
│   │       ├── api-key.ts
│   │       ├── secret-encryption.ts
│   │       ├── master-key.ts
│   │       ├── internal-control-token.ts
│   │       ├── console-auth.ts
│   │       └── permissions.ts
│   │
│   ├── observability/
│   │   └── src/
│   │       ├── activity-events.ts
│   │       ├── usage-events.ts
│   │       ├── metrics.ts
│   │       ├── traces.ts
│   │       ├── webhook-events.ts
│   │       └── jsonl-logs.ts
│   │
│   ├── jobs/
│   │   └── src/
│   │       ├── job-types.ts
│   │       ├── job-lease.ts
│   │       ├── job-runner.ts
│   │       └── job-results.ts
│   │
│   ├── billing/
│   │   └── src/
│   │       ├── cost-estimator.ts
│   │       ├── price-registry.ts
│   │       └── reconciliation.ts
│   │
│   ├── notifications/
│   │   └── src/
│   │       ├── alert-rules.ts
│   │       ├── notification-events.ts
│   │       └── delivery-targets.ts
│   │
│   ├── config/
│   │   └── src/
│   │       ├── config-version.ts
│   │       ├── config-validation.ts
│   │       ├── dependency-check.ts
│   │       └── runtime-settings.ts
│   │
│   └── ui/
│       └── src/
│           ├── components/
│           ├── hooks/
│           └── styles/
│
├── docs/
│   ├── PRODUCT.md
│   └── ARCHITECTURE.md
│
├── scripts/
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

`apps/gateway` 负责 HTTP 服务、请求 pipeline、streaming、Provider 调用、热加载和运行数据写入。领域规则尽量放在 `packages/routing`、`packages/domain`、`packages/providers` 中，避免 Gateway app 变成大而全的业务仓库。

### 10.2 Console app 只做控制面体验

`apps/console` 负责页面、表单、配置操作、Activity / Usage 展示、Worker job 状态和 Runtime 状态查看。依赖检查、配置发布、导入导出等控制面逻辑可以放在 Console server 层，但共享类型和领域规则仍应放在 packages 中。

### 10.3 Worker app 承载异步任务

`apps/worker` 负责周期任务和异步任务执行，包括模型刷新、Provider 健康探测、价格同步、账单对账、告警评估、通知投递、日志保留和备份任务。Worker 可以使用 `packages/providers` 和 `packages/security` 解密并调用 Provider，但不能承接 Agent 的同步模型请求。

### 10.4 Desktop shell 只做本机进程管理

`apps/desktop-shell` 承载菜单栏 / 托盘、首次初始化、master key 加载、进程 supervisor 和本地通知桥接。它不承载 Gateway 路由规则，也不承载 Console 页面业务。

### 10.5 Shared packages 保持协议稳定

Agent 协议、Provider 协议、Route Policy、配置校验、数据库 schema 和安全工具都应作为共享 package 管理。这样 Gateway 与 Console 对同一个配置对象使用同一套类型定义和校验规则。

## 11. 部署形态

### 11.1 Local / Desktop

- Gateway 默认监听 `127.0.0.1`。
- Console 默认只允许本机访问。
- Worker 由同一个 desktop supervisor 启动和监控。
- Desktop shell 负责托盘状态、首次初始化、master key 加载和本地通知桥接。
- SQLite 数据文件保存在用户选择的数据目录。
- Provider Key 加密存储。
- 适合个人电脑、菜单栏或托盘运行形态。

### 11.2 Docker / Server

- Gateway、Console 和 Worker 可以作为多个进程运行，也可以由同一个 supervisor 管理。
- 非 localhost 监听必须启用 Console 登录。
- internal control API 只允许 Console / Worker 或本机访问，并必须使用 internal control token。
- 数据目录挂载到宿主机 volume。
- SQLite 只建议挂载本机 volume；如果需要多实例或更高写入并发，应切换 Postgres。

### 11.3 Single Binary

- 后续可以把 Gateway、Console 静态资源、Worker、migration 和 runtime supervisor 打包成单个分发物。
- 架构上仍保留 Gateway 数据面和 Console 控制面的边界。

## 12. 关键架构决策

- TypeScript 贯穿 Gateway、Console 和共享 packages，减少协议与配置类型漂移。
- Gateway 使用 Fastify，优先满足 streaming、低延迟、内部控制 API 和插件化请求 pipeline。
- Console 使用 Next.js，优先满足本地管理控制台、表单配置、数据展示和鉴权引导。
- Background Worker 承载模型发现、价格同步、账单对账、告警通知、日志保留、JSONL / webhook export 和备份任务。
- SQLite + WAL 作为 V1 默认 canonical database，Postgres / Redis 作为未来 server / multi-instance 扩展。
- Console 通过配置版本驱动 Gateway 热加载，主动通知是 fast path，Gateway 周期 reconcile 是 safety path。
- Gateway 使用 immutable config snapshot，新请求即时使用新配置，进行中的请求不受影响。
- Console 不进入 Agent 请求路径，Gateway 在 Console 暂时不可用时仍应能继续处理请求。
- Playground 使用 internal simulation endpoint 以 `agent_api_key_id` 模拟身份，不依赖 Agent API Key 明文。
- Gateway 拥有同步限流、预算预留和并发计数状态；数据库保存可恢复的窗口与预算周期累计。
- master key 存储在数据库之外，由 Gateway、Console、Worker 共享加载；internal control token 与 master key 分离。
- Migration 和升级前备份是部署期 / supervisor 关注点，不属于 Console 私有服务。
- Provider Key 加密存储，Agent API Key hash 存储，prompt / response 默认不落库。
