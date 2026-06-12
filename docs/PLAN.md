# LLMIngress Implementation PLAN

> 本文从 `docs/PRODUCT.md` 拆出版本实现规划，用于指导 MVP 到 V3 的阶段化开发。产品定义仍以 `docs/PRODUCT.md` 为准；架构边界仍以 `docs/ARCHITECTURE.md` 为准；版本范围以本文为唯一事实源。

## 1. PLAN 原则

- 每个阶段都必须产出可运行、可测试、可回归的版本。
- 按 TDD 开发：先写失败测试，再写最小实现，再重构。
- 优先完成端到端闭环，再扩展 Provider、协议、报表和自动化能力。
- Gateway 请求路径保持低延迟；长耗时动作进入 Worker job。
- V1 之前只支持单 active Gateway；多 Gateway 属于 V3 扩展目标。

## 2. 阶段总览

| 阶段 | 目标 | 用户价值 |
| --- | --- | --- |
| MVP | 跑通个人用户基本使用闭环 | 用户能把一个 Agent 接入 LLMIngress，经 Gateway 调用真实 Provider，并在 Console 看到请求、成本和错误 |
| V1 | 完成个人自托管日常可用版本 | 支持更多 Provider、更多协议、导入导出、告警、观测和基础运维能力 |
| V2 | 增强智能路由与高级 Agent 能力 | 支持可选分类器、质量 judge、语义缓存、订阅 Provider 探索和更完整 Agent 模板 |
| V3 | 扩展到高可用和大规模自托管 | 支持多 Gateway、共享限流状态、长期数据治理和更强扩展生态 |

## 3. MVP：基本使用闭环

MVP 的目标不是覆盖全部 Provider、全部 Agent 体验或完整自动化能力，而是验证个人用户能完成一条端到端基本使用闭环：

```text
部署 LLMIngress
  -> 登录 Console
  -> 配置至少一个 Provider 和价格来源
  -> 创建 Agent 和 Agent API Key
  -> 创建 Virtual Model / Route Policy / Limit
  -> 将 Agent 请求发送到 Gateway
  -> Gateway 完成鉴权、路由、Provider 调用和 Fallback
  -> Console 展示 Activity、Usage、Cost 和错误信息
```

### 3.0 工程底座

MVP 开发前先完成最小工程底座，保证后续功能按 TDD 推进：

- Monorepo 脚手架：Gateway、Console、Worker 和共享 packages 可以独立构建、测试和启动。
- Vitest 三层测试结构：unit tests、integration tests、端到端 smoke tests。
- Test PostgreSQL 环境和 migration fixture。
- Fake Provider：覆盖非流式响应、Streaming、Provider error、timeout、首包前失败和 Fallback 测试。
- CI：typecheck、lint、unit tests、integration tests、migration check。
- 每条 MVP 验收路径先落失败测试，再实现最小可用功能。

### 3.1 Gateway / API

- OpenAI-compatible `POST /v1/chat/completions`。
- OpenAI-compatible `POST /v1/responses` stateless subset。
- Anthropic-compatible `POST /v1/messages` 基本请求。
- `GET /v1/models` 返回当前 Agent API Key 可用的 Virtual Model Name。
- 请求未指定 `model` 时使用 Agent API Key 的默认 Virtual Model Name；未配置默认值时返回明确错误。
- Streaming 响应转发。
- Agent API Key 鉴权。
- Virtual Model 权限检查。
- RPM / TPM / Budget / Token Limit 检查。
- 固定模型路由、成本优先候选和 Fallback Chain。
- 请求级 Activity、Usage、Cost、baseline cost、request savings、Fallback、Error 记录；MVP 只记录 savings 字段，完整展示放到 V1。

### 3.2 Provider / Model

- OpenAI API Key Provider。
- Anthropic API Key Provider。
- 至少一个 Generic OpenAI-compatible 白名单 Provider template。
- Ollama Local Provider。
- Provider Key 加密存储。
- 覆盖 MVP Provider 常用模型的内置静态 price registry，作为请求级 Cost 和成本预算的默认价格来源。
- 用户手动覆盖或补充模型价格；未知价格模型需要补价格后才能开启成本 Budget。
- 模型列表刷新 `model_refresh`。
- Provider 连接测试 `provider_connectivity_check`。
- 模型不可用标记，不硬删除被引用模型。

### 3.3 Console

- 首次初始化和 Console 登录。
- Provider 创建、启用、禁用、连接测试。
- Agent 创建。
- Agent API Key 创建和轮换。
- Allowed Virtual Model Names 配置。
- Agent API Key 默认 Virtual Model Name 配置。
- Agent API Key 的 Budget / RPM / TPM / Token Limit 配置。
- Virtual Model / Route Policy 创建。
- 模型价格查看和手动覆盖。
- Activity 页面。
- Usage / Cost 基础统计。
- Gateway Runtime 基础状态。
- Playground live 测试：用户手动粘贴 Agent API Key，通过 Gateway Public API 调用。

### 3.4 Worker

- Job runner、job lease、retry / backoff。
- `model_refresh` job。
- `provider_connectivity_check` job。
- `stale_reservation_cleanup` job。
- Postgres `job_created` notification 唤醒。
- routing-visible 变更后通过 config publisher 发布 config version。

### 3.5 Data / Deployment

- Local / single-node 部署。
- 一个 active Gateway、一个 Console、一个 Worker、一个 PostgreSQL。
- PostgreSQL schema 和 migration。
- Config version + Postgres `LISTEN/NOTIFY` 热加载。
- master key 加载和 Provider Key 加密。

### 3.6 MVP 暂不包含

- 多 active Gateway 实例。
- 任意自定义 Provider endpoint。
- Subscription Provider。
- Provider 多 Key 智能负载分配。
- Prompt caching 成本核算。
- Prometheus / OpenTelemetry / Webhook export。
- 配置导入导出。
- 复杂报表、长期归档、分区表和 read replica。
- `/v1/responses` 的 `previous_response_id`、server-side `store` 或跨 Provider response state。
- Desktop app、tray、Desktop notification。
- LLM 分类器、质量 judge、Semantic cache。

### 3.7 MVP 验收标准

- 用户能在 15 分钟内完成首次本地部署和 Console 初始化。
- 用户能配置 OpenAI、Anthropic 或 Ollama Provider。
- 用户能创建 Agent API Key、Virtual Model、默认 Virtual Model 和 Limit。
- 一个真实 Agent 或 curl 请求能通过 Gateway 成功返回模型响应。
- Streaming 响应能完整转发给 Agent。
- Claude Code 风格 `/v1/messages` 请求能通过 Anthropic Provider 完成一次真实调用。
- Console 能展示该请求的 Activity、Usage、Cost、Route Reason 和错误信息。
- Console 能展示基于内置价格或手动价格计算出的请求级 Cost。
- 超出 Budget / RPM / TPM / Token Limit 时 Gateway 返回明确错误。
- Provider 首包前失败时能按 Fallback Chain 切换。

## 4. V1：个人自托管日常可用

V1 的目标是把 MVP 从“可跑通”提升到“个人日常可用”，覆盖更多 Provider、运维能力和可观测能力。

### 4.1 Gateway / API

- `POST /v1/embeddings`。
- 更完整的 Anthropic-compatible `/v1/messages` 参数透传。
- Provider 多 Key failover。
- 更完整的错误映射和 request id 追踪。
- Prompt caching token 识别和成本核算。

### 4.2 Provider / Model

- Google Gemini API Key Provider。
- OpenRouter API Key Provider。
- 长尾 OpenAI-compatible Provider template：DeepSeek、xAI、Mistral、Qwen、Moonshot / Kimi、MiniMax、Groq、Fireworks AI、Z.ai。
- Local Provider 增强：LM Studio、llama.cpp。
- 模型价格同步。
- Provider / Model health summary 展示。

### 4.3 Console

- Provider 模板选择器。
- Agent 专用接入模板：Codex、Claude Code、Cursor、OpenClaw。
- Route Policy 编辑体验增强。
- Usage / Cost breakdown：Agent、Agent API Key、Virtual Model、Provider、Model。
- Savings summary。
- 配置导入导出。
- JSONL request logs 导出。
- 成本报表导出。

### 4.4 Worker

- `price_sync` job。
- `billing_reconciliation` job。
- `retention_cleanup` job。
- `jsonl_export` job。
- `backup` job。
- Budget threshold alert evaluator。
- Rate Limit 高频触发 alert evaluator。
- Provider failure alert evaluator。
- Fallback exhaustion alert evaluator。
- Email / Webhook notification dispatcher。

### 4.5 Observability / Operations

- Prometheus metrics exporter。
- OpenTelemetry traces。
- Webhook event export。
- 日志保留周期和清理策略。
- 周期性备份。
- migration status check。

### 4.6 V1 验收标准

- 用户能稳定接入至少 OpenAI、Anthropic、Google Gemini、OpenRouter 四类远程 API Key Provider 和 2 类 Local Provider。
- Usage 页面能展示成本、节省、失败率和模型分布。
- Provider 连续失败、Budget 接近阈值、Rate Limit 高频触发、Fallback 耗尽能触发 Email / Webhook。
- 用户能导出配置、请求记录和成本报表。
- 系统能在单机自托管环境下长期运行并自动清理过期日志。

## 5. V2：智能路由与高级 Agent 能力

V2 的目标是在 V1 稳定基础上增强路由智能、缓存能力和高风险 Provider 探索。

### 5.1 Routing / Intelligence

- 可选 LLM 任务分类器。
- 可选质量 judge。
- judge / retry 策略。
- 更细粒度的 coding、repo、terminal、long context、reasoning 场景规则。
- 用户可配置分类器和 judge 的额外延迟 / 成本上限。

### 5.2 Cache / Cost

- Semantic cache。
- 更完整的 prompt caching 成本归因。
- 更细的 cached input token、reasoning token、tool call token 统计。
- 节省效果趋势分析。

### 5.3 Provider / Agent

- Subscription Provider 高风险探索：ChatGPT Plus / Pro / Team、Claude Pro / Max、GitHub Copilot、Gemini / Google sign-in 等。
- Quota-aware key balancing。
- 更多 Agent 专用接入模板。
- 单 Provider passthrough 模式下的 `/v1/responses` stateful extension 探索。

### 5.4 Console

- 路由模拟和 route explain 增强。
- judge / retry 配置页面。
- Semantic cache 管理页面。
- Subscription Provider 风险提示和开关。
- 更完整的告警规则编辑。

### 5.5 V2 验收标准

- 用户可以显式开启或关闭分类器 / judge，并看到额外成本和延迟。
- Semantic cache 可以减少重复请求成本，并在 Usage 页面展示命中效果。
- Subscription Provider 默认关闭，开启前必须展示 ToS、封号和协议变更风险。
- Quota-aware key balancing 能避免单个 key 过早耗尽。

## 6. V3：高可用和大规模自托管

V3 的目标是把 LLMIngress 从单机个人部署扩展到更高并发、更长期运行、更强运维能力的自托管形态。V3 不默认改变产品边界为多租户 SaaS。

### 6.1 Multi-Gateway / Shared Runtime State

- 多 active Gateway 实例。
- 共享 RPM / TPM / concurrency 状态。
- Redis 或 Postgres 原子状态组件。
- Gateway 实例健康检查和流量切换。
- 多 Gateway config reload 广播和状态汇总。

### 6.2 Data / Analytics

- Postgres partition / retention policy。
- Read replica 支持重报表查询。
- Object storage 归档 request content 和导出文件。
- 长期成本趋势分析。
- Provider SLA 和失败模式分析。

### 6.3 Provider Ecosystem

- 受控的社区 Provider template registry。
- Provider template 签名和版本管理。
- Template compatibility check。
- 更丰富的 local / self-hosted model runtime 支持。

### 6.4 Operations

- 更完整的备份 / 恢复演练。
- 灾难恢复流程。
- 配置版本回滚。
- 运行状态审计。
- 大规模日志和 trace 采样策略。

### 6.5 V3 验收标准

- 多 Gateway 部署下 Rate Limit、Budget、Usage 统计保持一致。
- 单个 Gateway 实例故障不影响整体服务可用性。
- 长期运行数据可以按保留策略自动分区、归档和清理。
- Provider template 可以安全升级和回滚。
