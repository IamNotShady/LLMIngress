# Manifest Product Capability Map

> 本文基于 Manifest 官网、官方文档，以及 `mnfst/manifest` 代码库当前 `main` 快照整理。目标是只梳理产品功能能力，不展开工程实现、CI、测试、发布流水线等非产品内容。

## 1. 产品定位

Manifest 是一个面向 AI agents、AI applications、coding assistants 和自动化工作流的 AI Gateway / LLM Router。它位于客户端和模型供应商之间，把调用统一接入到 Manifest，再由 Manifest 根据路由规则、模型成本、任务类型、可用性和限额策略决定实际请求哪个模型。

核心产品目标：

- 降低 AI inference 成本。
- 复用已有的 API key、订阅计划、本地模型和自定义模型服务。
- 为不同 agent / app / coding assistant 提供统一的模型接入层。
- 在一个 Dashboard 中配置路由、Provider、Fallback、Limits、Playground、模型价格和调用记录。
- 支持 Cloud 版和 Self-hosted 版。

## 2. Gateway / Proxy 能力

### 2.1 统一 AI Gateway 入口

- 提供 OpenAI-compatible Chat Completions 入口：`POST /v1/chat/completions`。
- 提供 OpenAI Responses 入口：`POST /v1/responses`。
- 提供 Anthropic Messages 入口：`POST /v1/messages`。
- 提供模型列表入口：`GET /v1/models`，返回 Manifest Auto 模型。
- 客户端可以使用 `manifest/auto` 或 `auto`，由 Manifest 在后端解析真实模型。
- 同一个 Gateway 可以代理 API key provider、subscription provider、custom provider 和 local provider。
- 支持把 OpenAI 形状请求转发到 Anthropic-only 模型，也支持 Anthropic 形状请求转发到对应供应商。

### 2.2 请求透传

- 支持标准 OpenAI 请求字段透传，例如 `temperature`、`max_tokens`、`tools`、`tool_choice`、`response_format`、`stream`。
- 支持 Anthropic Messages API 所需的 `anthropic-version`。
- 支持工具调用相关字段。
- 支持 provider-specific 请求参数配置。
- 支持 buffered 和 stream 两种响应模式。

### 2.3 Streaming

- 支持流式响应。
- OpenAI endpoint 返回 OpenAI 风格 SSE chunk。
- Anthropic endpoint 返回 Anthropic event block。
- Routing 和 Fallback 可以与 streaming 一起工作。
- 如果主模型在第一个 chunk 前失败，可以切换 fallback。
- 如果主模型在 stream 中途失败，不做静默中途重试，连接会关闭。

### 2.4 Gateway 鉴权

- 每个 agent 有自己的 Manifest API key。
- Gateway 请求使用 `Authorization: Bearer mnfst_...`。
- 支持创建 agent 时生成 key。
- 支持查看 key prefix。
- 支持在可解密时返回完整 agent key。
- 支持 rotate agent key。
- Agent key 存储包含 hash、prefix、active 状态、过期时间和 last-used 时间。

### 2.5 Gateway 可观测响应头

每次请求可以通过响应头看到路由结果：

- `X-Manifest-Tier`：最终复杂度 tier。
- `X-Manifest-Model`：实际服务请求的模型。
- `X-Manifest-Provider`：实际供应商。
- `X-Manifest-Confidence`：路由置信度。
- `X-Manifest-Reason`：路由原因。
- `X-Manifest-Specificity`：任务类型路由分类。
- `X-Manifest-Fallback-From`：fallback 成功时的原始失败模型。
- `X-Manifest-Fallback-Index`：fallback 链中命中的序号。
- `X-Manifest-Fallback-Exhausted`：fallback 全部失败时标记。

### 2.6 Gateway 错误体系

产品侧有明确错误分类：

- 认证错误：缺失 Authorization、空 Bearer token、key 格式错误、key 过期、key 不存在。
- Provider 错误：缺少 provider key、未配置 provider。
- Limits 错误：使用量超限、用户/IP rate limit、并发超限。
- 请求校验错误：缺少 messages、messages 过长。
- 服务端错误：内部错误。

## 3. Agent / Client 接入能力

### 3.1 Agent 创建与管理

- 创建 agent。
- Agent 名称自动 slug 化。
- 设置 display name。
- 设置 agent category。
- 设置 agent platform。
- 查看 agent 列表。
- 查看单个 agent 信息。
- 重命名 agent。
- 修改 agent 类型。
- 删除 agent。
- 复制 agent，并复制相关配置。
- 创建 agent 时生成 API key。
- 旋转 agent API key。
- 单个 agent 可独立配置 provider、routing、limits、recording。

### 3.2 Agent 分类

内置三类 agent：

- AI agents。
- App AI SDK。
- Coding Assistant。

### 3.3 内置接入平台

代码中内置的接入平台：

- OpenClaw。
- Hermes Agent。
- Nanobot。
- Craft Agent。
- Claude Code。
- OpenCode。
- OpenAI SDK。
- Anthropic SDK。
- Vercel AI SDK。
- LangChain。
- cURL。
- Other。

### 3.4 接入引导

Dashboard 中有 Connect Agent / setup 类页面和组件，面向不同 agent 或 SDK 生成接入说明，包括：

- OpenClaw setup。
- Hermes setup。
- Nanobot setup。
- Craft setup。
- Claude Code setup。
- OpenCode setup。
- OpenAI SDK / Anthropic SDK / Vercel AI SDK / LangChain / cURL snippets。
- API key 展示和复制。

## 4. Provider 接入能力

### 4.1 Provider 类型

Manifest 支持四类 provider：

- API key provider：用户使用自己的 provider API key。
- Subscription provider：复用已有付费订阅或 token plan。
- Custom provider：接入 OpenAI-compatible 或 Anthropic-compatible 私有/第三方 endpoint。
- Local provider：接入本机或自托管环境中的本地模型服务。

### 4.2 内置 Provider Registry

代码库当前内置 provider：

- Alibaba Cloud / Qwen。
- Anthropic。
- BytePlus。
- DeepSeek。
- Fireworks AI。
- Groq。
- Kilo。
- GitHub Copilot。
- Command Code。
- Google。
- Kiro。
- MiniMax。
- Xiaomi MiMo。
- Mistral。
- Moonshot / Kimi。
- NVIDIA NIM。
- llama.cpp。
- LM Studio。
- Ollama。
- Ollama Cloud。
- OpenAI。
- OpenCode Go。
- OpenCode Zen。
- OpenRouter。
- xAI。
- Z.ai。

### 4.3 Provider 连接管理

- 为指定 agent 添加 provider。
- 保存 provider credential。
- Provider credential 支持加密存储。
- 返回 provider 状态时不暴露原始密钥。
- 查看已连接 providers。
- 查看 provider 是否 active。
- 查看 provider key prefix。
- 查看 provider label。
- 查看 provider priority。
- 查看 provider region。
- 查看 model fetch 时间和 cached model count。
- 删除 provider。
- 一键 deactivate 当前 agent 所有 providers。
- 支持同一个 provider 下多 key / 多 credential。
- 支持 provider key 重命名。
- 支持 provider key 排序。
- 支持不同 auth type：`api_key`、`subscription`、`local`。

### 4.4 API Key Provider

- 支持输入 provider API key。
- 支持 key prefix / key length 等基本校验提示。
- 支持连接后自动发现模型。
- 支持连接后重新计算 tier assignment。
- 支持刷新单个 provider 的模型列表。
- 支持刷新当前 agent 下全部 provider 的模型列表。

### 4.5 Subscription Provider

可复用订阅或 token plan，把订阅额度作为 primary route，再用 API key provider 做 fallback。

代码中存在订阅配置的 provider 包括：

- Anthropic / Claude Max 或 Pro。
- BytePlus / ModelArk Coding Plan。
- OpenAI / ChatGPT Plus、Pro、Team。
- MiniMax Coding Plan。
- Xiaomi MiMo Token Plan。
- Qwen Token Plan。
- Moonshot / Kimi Coding Plan。
- Ollama Cloud。
- Kiro subscription。
- Z.ai / GLM Coding Plan。
- OpenCode Go。
- Gemini / Google sign-in。
- xAI / Grok subscription。
- GitHub Copilot subscription。
- Command Code subscription。

订阅接入模式包括：

- OAuth popup。
- Device code。
- Subscription token。
- Provider-specific token。

### 4.6 Custom Provider

- 支持添加自定义 provider。
- 支持 OpenAI-compatible `POST /v1/chat/completions`。
- 支持 Anthropic-compatible `POST /v1/messages`。
- 支持配置 base URL。
- 支持配置 provider name。
- 支持可选 API key。
- 支持探测模型列表。
- 支持手动保存模型列表。
- 支持更新自定义 provider。
- 支持删除自定义 provider。
- 支持把 custom provider 当成普通 route / fallback 使用。
- 支持自定义 provider 的模型显示名。
- 自定义 provider 请求仍会记录 token、latency 等指标；未知模型 cost 可能为 0。

### 4.7 Local Model Provider

自托管场景支持本地模型：

- Ollama。
- LM Studio。
- llama.cpp。

能力包括：

- 探测本地服务。
- 获取本地模型列表。
- 同步 Ollama 模型。
- 将本地模型绑定到 tier、specificity 或 fallback。
- 与 cloud provider 混用。
- 本地模型 API cost 记录为 0。
- 本地请求不需要离开用户机器或基础设施。

### 4.8 Model Discovery

- 连接 provider 后自动发现可用模型。
- 支持按 agent 获取 available models。
- 支持 provider model cache。
- 支持模型价格、上下文窗口、quality score、capabilities、input modalities。
- 支持从 provider 原生模型列表、OpenRouter pricing cache、models.dev、内置 fallback 数据中合并模型信息。
- 支持 OpenCode Go 等 gateway model 映射到底层模型身份。
- 支持模型能力标记，例如 reasoning、code、stream、tools、text/image/audio/video modality。

### 4.9 Model Prices

- Dashboard 可查看模型价格。
- 后端提供 `GET /api/v1/model-prices`。
- 支持 pricing health。
- 支持手动刷新 pricing cache。
- 支持按模型展示 input/output token 价格。
- 支持 provider/model 价格用于成本统计和路由参考。

### 4.10 Free Models

- Dashboard 有 Free Models 页面。
- 后端提供 free models 数据接口。
- 支持展示免费模型及免费 provider。
- 支持把免费模型与付费模型混合进 routing 和 fallback。

## 5. Routing 能力

### 5.1 Default Routing

- 每个 agent 有 default model。
- 当 complexity routing 关闭，或没有命中其他路由规则时走 default。
- Dashboard 可切换 default route。
- Default route 可作为最终兜底。

### 5.2 Complexity Routing

支持按请求复杂度自动路由到不同 tier：

- Simple。
- Standard。
- Complex。
- Reasoning。

能力包括：

- 对每个 incoming prompt 打分。
- 根据分数映射到 tier。
- 每个 tier 可绑定不同 primary model。
- 简单请求路由到便宜模型。
- 复杂请求路由到高质量模型。
- 支持开启/关闭 complexity routing。
- 支持查看当前 complexity routing 状态。
- 支持 reset all tier overrides。

### 5.3 Scoring

文档说明 scoring 覆盖 23 个维度，源码中也有独立 scoring 模块。能力包括：

- Keyword-based signals。
- Structural signals。
- Contextual signals。
- 复杂度关键词识别。
- token count、嵌套深度、code/prose ratio、条件逻辑、constraint density 等结构信号。
- expected output length、repetition、tool count、conversation depth 等上下文信号。
- 返回 tier、score、confidence、reason。

### 5.4 Session Momentum

- 记录最近 tier 分配。
- 短 follow-up 消息可继承上一轮上下文 momentum。
- 避免 `"yes"`、`"do it"` 等短消息被错误降级到过低 tier。

### 5.5 Tier Override

- 每个 tier 可手动绑定指定 model route。
- 可设置 provider。
- 可设置 auth type。
- 可指定 provider key label。
- 可清除 tier override。
- 可为每个 tier 设置 response mode。
- 可为每个 tier 设置 fallback chain。

### 5.6 Task-specific / Specificity Routing

在 complexity 之上，支持任务类型路由。内置任务类型：

- Coding。
- Web browsing。
- Data analysis。
- Image generation。
- Video generation。
- Social media。
- Email management。
- Calendar management。
- Trading。

能力包括：

- 根据关键词和工具名检测任务类型。
- 每个 category 可单独启用或关闭。
- 每个 category 可绑定指定 model route。
- 每个 category 可配置 response mode。
- 每个 category 可配置 fallback chain。
- 每个 category 可清除 override。
- 支持 reset all specificity settings。
- 用户可以在消息记录中标记 miscategorized，用于反馈分类错误。

### 5.7 Header / Custom Routing

Manifest 支持基于 HTTP header 的自定义路由。产品能力包括：

- 创建 header tier。
- 配置 header key。
- 配置 header value。
- 设置 header tier 名称。
- 设置 badge color。
- 启用/禁用 header tier。
- 更新 header tier。
- 删除 header tier。
- 对 header tier 排序。
- 为 header tier 设置 model override。
- 为 header tier 设置 response mode。
- 为 header tier 设置 fallback chain。
- 清除 header tier override。
- 清除 header tier fallbacks。
- 查看已见过的 headers。
- 支持跨 agent 复用 seen headers。

### 5.8 Request Header Override

客户端可直接通过 request header 强制路由：

- `x-manifest-tier`：强制指定 complexity tier。
- `x-manifest-specificity`：强制指定任务类型。
- Header override 会跳过自动 scoring / detection。
- Header override 的 confidence 为 1.0。

### 5.9 Response Mode

- 当前支持 `buffered`。
- 当前支持 `stream`。
- Tier、specificity、header tier 都可以配置 response mode。

### 5.10 Output Modality

- 当前共享类型中默认 output modality 为 text。
- 模型 discovery 中会识别 input modality 和模型 capability。
- 当前 route 输出侧产品能力主要聚焦文本响应。

## 6. Fallback 能力

### 6.1 Fallback Chain

- 每个 tier 可配置 fallback models。
- 每个 specificity category 可配置 fallback models。
- 每个 header tier 可配置 fallback models。
- Fallback 按配置顺序执行。
- 官方文档说明每个 tier 最多可配置 5 个 fallback model。
- Fallback model 可以来自不同 provider。
- Local model 和 cloud model 可混合在同一 chain。
- Subscription primary 可搭配 API key provider fallback。

### 6.2 Fallback 触发条件

- Provider 返回 HTTP 4xx 或 5xx 时可触发 fallback。
- Rate limit、provider outage、bad request、overload 等都可触发。
- 424 表示 Manifest 自己的 fallback chain exhausted，不再触发新的 fallback。
- Provider 连接打开但超时，也可通过 per-attempt timeout 进入 fallback。

### 6.3 Fallback 结果记录

- 记录 primary failure。
- 记录 fallback success。
- 响应头展示 fallback 来源和命中序号。
- Fallback 全部失败时返回 424 并带 exhausted 标记。

## 7. Limits / Notifications 能力

### 7.1 Usage Limits

可按 agent 设置用量规则：

- Metric：tokens。
- Metric：cost。
- Period：hour。
- Period：day。
- Period：week。
- Period：month。
- Threshold：用户自定义阈值。

### 7.2 Rule Action

规则 action 支持：

- `notify`：发送通知。
- `block`：达到阈值后阻断请求。
- `both`：通知并阻断。

### 7.3 Hard Limit

- Hard limit 命中后，后续 proxy 请求返回 HTTP 429。
- block 规则在每次请求时检查。
- block 在下一个周期重置。

### 7.4 Email Alert

- 支持配置通知邮箱。
- 支持邮件服务商配置。
- 支持测试邮件服务商配置。
- 支持测试已保存配置。
- 支持删除邮件服务商配置。
- 支持查看 notification logs。
- 支持手动触发 threshold check。

### 7.5 Email Provider

邮件发送 provider 支持：

- Resend。
- Mailgun。
- SendGrid。

## 8. Observability / Analytics 能力

### 8.1 Overview Dashboard

Dashboard 概览能力包括：

- 今日 token。
- 今日 cost。
- message 数量。
- token usage timeseries。
- cost usage timeseries。
- message usage timeseries。
- cost by model。
- recent activity。
- active skills / active activity。
- 是否已有数据。
- 是否已连接 provider。

### 8.2 Token Analytics

- 支持按时间范围查看 token 使用。
- 支持 hourly 和 daily token timeseries。
- 支持 input tokens 和 output tokens 拆分。
- 支持与上一周期计算 trend percentage。
- 支持按 agent 过滤。

### 8.3 Cost Analytics

- 支持按时间范围查看 cost。
- 支持 hourly 和 daily cost timeseries。
- 支持 cost by model。
- 支持 weekly cost summary。
- 支持 trend percentage。
- 支持按 agent 过滤。

### 8.4 Savings Analytics

- 支持 savings 汇总。
- 支持 savings timeseries。
- 支持 baseline candidates。
- 支持指定 baseline 计算节省。
- 支持按 agent 过滤。

### 8.5 Agent-level Analytics API

- Agent 可用自己的 API key 查询 usage。
- Agent 可用自己的 API key 查询 costs。
- 返回当前 agentName。

### 8.6 Public Stats

可选公开统计接口，默认关闭：

- public usage。
- public free models。
- provider tokens。
- agent tokens。
- free providers。

该能力主要用于 Manifest Cloud / 官网展示类场景。

### 8.7 Real-time Dashboard Updates

- Dashboard 通过 SSE 接收事件。
- 支持 agent、ingest 等事件类型。
- 兼容 legacy ping 事件。
- 用于让 Dashboard 在 agent/provider/message 状态变化后刷新。

## 9. Messages / Recording 能力

### 9.1 Message Log

Dashboard 支持消息日志查询：

- 按时间范围筛选。
- 按 provider 筛选。
- 按 service type 筛选。
- 按 cost min / max 筛选。
- 按状态筛选。
- 按是否 recorded 筛选。
- 按 routing tier 筛选。
- 按 specificity category 筛选。
- 按 header tier 筛选。
- Cursor pagination。
- 单页 limit 上限保护。

### 9.2 Message Details

- 查看单条 message details。
- 查看请求/响应相关记录。
- 查看 routing metadata。
- 查看 provider、model、tier、cost、tokens、latency 等信息。

### 9.3 Message Recording

- 每个 agent 可开启或关闭 record messages。
- Proxy 请求时可捕获请求与响应内容。
- Dashboard 有 recorded message drawer / viewer。
- 支持删除单条 message recording。

### 9.4 Message Feedback

- 支持对 message 设置 feedback rating。
- 支持 feedback tags。
- 支持 feedback details。
- 支持清除 feedback。

### 9.5 Specificity Feedback

- 支持标记某条消息任务分类错误。
- 支持清除 miscategorized 标记。

## 10. Playground 能力

### 10.1 Playground Run

- Dashboard 内置 Playground。
- 支持从 Playground 发起模型请求。
- Playground 请求走 Manifest routing 能力。
- 支持 streaming run。
- 支持自定义 request headers。
- 支持展示响应 headers。
- Playground run 会被记录为 playground tier。

### 10.2 Playground Columns

- 支持多列对比式 Playground。
- 支持为不同 column 选择模型或 route。
- 支持运行结果对比。

### 10.3 Playground History

- 查看 Playground run 历史。
- 查看单次 run 详情。
- Star / unstar run。
- 标记 best column。

## 11. Model Parameter 能力

### 11.1 Provider-specific 参数

Manifest 有模型参数 schema 能力，支持给 route 配置 provider/model 兼容参数。

参数分组包括：

- generation_length。
- sampling。
- reasoning。
- tooling。
- output_format。
- observability。
- provider_metadata。

### 11.2 参数配置范围

- 可查询某个 provider/auth/model 的参数规格。
- 可查询有哪些模型支持可配置参数。
- 可列出当前 agent 已配置的 model params。
- 可为 route 保存 model params。
- 可删除 route 的 model params。
- 保存时会校验参数是否为 JSON object。
- 保存时会按 provider/model specs 裁剪不兼容参数。
- 保存时会校验 boolean、enum、integer、number、string 等类型。

## 12. Dashboard / 管理后台能力

### 12.1 Workspace

- 展示用户 workspace。
- 展示 agent 列表。
- 创建 agent。
- 进入指定 agent 的管理视图。

### 12.2 Routing 页面

- 配置 default route。
- 配置 complexity tiers。
- 配置 specificity routing。
- 配置 header tiers。
- 选择 model。
- 查看 provider / model capability badges。
- 配置 response mode。
- 配置 fallback list。
- 配置 model params。
- 刷新模型。
- 查看 routing status。
- 查看 connect provider 状态。

### 12.3 Provider 连接页面

- 添加 provider。
- 选择 API key tab。
- 选择 subscription tab。
- 选择 local tab。
- 连接 custom provider。
- 查看 OAuth / device code / token flow 的 detail view。
- 配置 region。
- 配置 provider key label。
- 展示 provider icon 和 provider banner。

### 12.4 Overview 页面

- 展示成本、token、message 等核心指标。
- 展示 usage chart。
- 展示 cost chart。
- 展示 cost by model。
- 展示 savings。
- 展示 recent activity。

### 12.5 Messages 页面

- 展示消息表。
- 打开消息详情。
- 展示 recorded request / response。
- 反馈消息质量。
- 标记分类错误。
- 删除 recording。

### 12.6 Limits 页面

- 展示 limit rules。
- 创建 rule。
- 编辑 rule。
- 删除 rule。
- 查看 limit history / notification logs。
- 配置 email provider。
- 配置 notification email。

### 12.7 Playground 页面

- 多列请求测试。
- 选择模型。
- 输入 prompt。
- 配置请求 headers。
- 查看响应。
- 查看 run history。
- 标记 starred / best。

### 12.8 Model Prices 页面

- 展示模型价格。
- 展示模型 provider。
- 支持模型价格筛选。

### 12.9 Free Models 页面

- 展示免费模型列表。
- 展示免费 provider 信息。
- 作为低成本路由选型入口。

### 12.10 Settings 页面

- Agent 相关设置。
- Agent 重命名。
- Agent 类型修改。
- Message recording 开关。
- Agent key 查看 / rotate。
- Agent 删除。

### 12.11 Account / Auth 页面

- Login。
- Register。
- Reset password。
- Account 页面。
- Setup 页面。
- First admin 创建。

## 13. Authentication / Account 能力

### 13.1 登录方式

- Email/password。
- Google OAuth。
- GitHub OAuth。
- Discord OAuth。

OAuth provider 是否启用取决于对应环境变量是否配置。

### 13.2 邮箱验证与重置密码

- 支持 signup verification email。
- 支持 reset password email。
- 是否强制 email verification 取决于生产环境和 email provider 配置。
- 支持 auto sign-in after verification。

### 13.3 首次安装 Setup

- 判断是否需要 setup。
- 第一个创建的账号成为 admin。
- Setup status 返回 self-hosted 状态。
- Setup status 返回已启用 social providers。
- Setup status 返回 Ollama 是否可用。
- Setup status 返回 local LLM host。

### 13.4 Auth Rate Limit

产品上对敏感认证接口有 rate limit：

- sign-in。
- sign-up。
- forget-password / forgot-password / reset-password。
- verify-email / send-verification-email。

## 14. Self-hosted / Cloud 能力

### 14.1 Cloud

- 用户可以使用 Manifest Cloud。
- Cloud 由 Manifest 托管，降低部署门槛。
- 官网提供 sign in / sign up。
- Cloud rate limit 与 plan 相关，并在 dashboard 中展示。

### 14.2 Self-hosted

- 支持 Docker self-hosted。
- 支持 quick install script。
- 支持 Docker Compose。
- 支持 Docker Run + BYO PostgreSQL。
- 默认端口为 2099。
- 默认绑定 localhost，避免直接暴露到 LAN。
- 支持自定义端口。
- 支持 LAN 暴露配置。
- 支持 PostgreSQL 持久化。
- 支持自动数据库迁移。
- 支持升级 Docker image 后保留数据。
- 支持本地模型 provider。

### 14.3 部署配置能力

Self-hosted / backend 支持通过环境变量配置：

- PostgreSQL。
- Auth secret。
- Public URL。
- Port。
- Bind address。
- CORS origin。
- Rate limit。
- DB pool。
- Email provider。
- OAuth login providers。
- Telemetry opt-out。
- Public stats 开关。
- Local LLM host。
- Dedicated encryption key。

### 14.4 健康检查

- 提供 `GET /api/v1/health`。
- 返回 `status: healthy`。
- 返回 uptime seconds。

## 15. Security / Privacy 相关产品能力

### 15.1 凭据保护

- Provider API key 加密存储。
- OAuth / subscription token blob 加密存储。
- Email provider API key 加密存储。
- Agent API key 以 hash + prefix 存储，同时可保存加密 key 以便展示。
- 可使用 `MANIFEST_ENCRYPTION_KEY` 作为独立加密密钥。
- 未设置独立加密密钥时可回退到 `BETTER_AUTH_SECRET`。

### 15.2 自托管隐私

- Self-hosted 请求经过用户自己的 Manifest 实例。
- Local model 请求可以留在用户机器或内网。
- Dashboard 默认同源部署，生产环境不开放泛 CORS。
- Self-hosted local/custom provider 可以访问用户基础设施内的服务。

### 15.3 Custom Provider SSRF 防护

- 自定义 provider URL 会进行校验。
- Cloud 场景下限制私有 IP 范围。
- Self-hosted 场景允许访问本地或内网 provider。

### 15.4 请求限流与并发保护

- 每个 agent 有默认 rate limit。
- 支持用户级 rate limit。
- 支持 IP 级 rate limit。
- 支持并发请求 slot 限制。
- Auth 接口有单独限流。

## 16. 主要用户场景

### 16.1 个人 Agent 成本控制

- 接入 OpenClaw / Hermes / Nanobot / Craft。
- 使用已有订阅作为 primary。
- 配置 API key provider 做 fallback。
- 为简单任务路由到免费或低价模型。
- 为复杂任务路由到高质量模型。
- 设置预算阈值和通知。

### 16.2 AI 应用统一模型层

- 应用只接入 Manifest endpoint。
- Manifest 负责 provider key、model routing、fallback、cost tracking。
- 支持 OpenAI SDK、Anthropic SDK、Vercel AI SDK、LangChain 和自定义 HTTP 客户端。
- 支持通过 header 把应用内部任务强制路由到指定模型。

### 16.3 Coding Assistant Provider 解耦

- 接入 Claude Code、OpenCode 或其他 coding assistant。
- 使用用户偏好的模型和 provider。
- 接入 GitHub Copilot、OpenCode Go、Claude、OpenAI、Gemini 等订阅或 API。
- 查看 coding assistant 的消费和消息记录。

### 16.4 企业或自托管场景

- Docker 部署到自己的机器或基础设施。
- 使用自己的 PostgreSQL。
- 连接内网自定义模型服务。
- 接入本地 Ollama / LM Studio / llama.cpp。
- 保留调用日志和 provider credentials 在自己的环境中。

## 17. 当前产品边界

- 它是 AI Gateway / Router，不是模型训练平台。
- 它不自己提供基础模型推理能力，除非连接本地模型服务或 provider。
- 它的生产 self-hosted bundle 包含 Dashboard 和 backend，但 dev-only Wingman gateway tester 在独立仓库。
- 当前共享 output modality 主要是 text；虽然模型 capability 会识别 image/audio/video 输入能力，但产品路由输出侧仍以文本响应为核心。
- 免费模型、模型价格、provider 列表和订阅支持会随上游 provider 与代码版本变化。

## 18. 来源与核对范围

官网与文档：

- `https://manifest.build/`
- `https://manifest.build/docs/introduction`
- `https://manifest.build/docs/routing`
- `https://manifest.build/docs/fallback`
- `https://manifest.build/docs/set-limits`
- `https://manifest.build/docs/providers/api-key-providers`
- `https://manifest.build/docs/providers/subscription-based-providers`
- `https://manifest.build/docs/providers/custom-providers`
- `https://manifest.build/docs/providers/local-models`
- `https://manifest.build/docs/reference/api`
- `https://manifest.build/docs/reference/headers`
- `https://manifest.build/docs/self-hosted`

源码快照：

- Repository: `https://github.com/mnfst/manifest`
- Snapshot read locally: `main` at `2670e68`
- Main product code reviewed:
  - `packages/frontend/src/pages`
  - `packages/frontend/src/components`
  - `packages/backend/src/routing`
  - `packages/backend/src/analytics`
  - `packages/backend/src/notifications`
  - `packages/backend/src/playground`
  - `packages/backend/src/model-prices`
  - `packages/backend/src/free-models`
  - `packages/backend/src/auth`
  - `packages/backend/src/setup`
  - `packages/shared/src/providers.ts`
  - `packages/shared/src/agent-type.ts`
  - `packages/shared/src/tiers.ts`
  - `packages/shared/src/specificity.ts`
  - `packages/shared/src/subscription/configs.ts`
