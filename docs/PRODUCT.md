# LLMIngress Product Design

> LLMIngress 是一个面向 AI Agent 的 AI Gateway。AI Agent 只需要接入 LLMIngress 一个统一 endpoint；LLMIngress 在后端连接多个 Provider 和模型，并根据请求参数、上下文和使用场景自动匹配合适的模型。

## 1. 产品定位

LLMIngress 是用户部署的 AI Agent 模型入口层。用户把 Codex、Claude Code、Cursor、OpenCode、Hermes 等不同 AI Agent 的模型请求接入 LLMIngress，再由 LLMIngress 统一完成 Provider 接入、模型选择、Fallback、成本记录和用量控制。

核心目标：

- 统一 AI Agent 接入入口：让 Codex、Claude Code、Cursor、OpenCode、Hermes 等不同 AI Agent 只接入一个 LLMIngress Gateway。
- 自动匹配合适模型：根据请求参数、上下文长度、任务类型、工具调用、模型能力和使用场景选择真实 Provider 与模型。
- 多 Provider / 多模型统一管理：集中管理 API Key、订阅额度和本地模型，让多个 AI Agent 复用同一套模型资源。
- 面向 AI Agent 的路由策略：围绕 coding、repo 理解、terminal / shell、long context、reasoning、tool calling 等 Agent 高频场景设计路由规则。
- 提升请求稳定性：当 Provider 限流、失败、超时或模型不可用时，自动切换到备用模型，减少 AI Agent 工作流中断。
- Agent 级可观测性：按 Agent、Agent API Key 和 Virtual Model Name 查看请求、模型命中、Tokens、成本、失败原因、Fallback 情况和延迟表现。
- 降低接入配置成本：为每个 Agent 提供清晰的 Gateway URL、API Key、Virtual Model Name 和配置示例，让接入过程尽量简单。
- 用户自主管理部署与数据：支持部署在个人电脑、本地服务器或云端服务器，由用户掌控 Provider Key、模型配置、请求日志和数据存储位置。

## 2. 产品范围

### 2.1 核心范围

- AI Agent 统一接入：为多个 AI Agent 提供统一 Gateway endpoint、Agent API Key 和可用 Virtual Model Name。
- 自动模型路由：通过 Virtual Model Name / Route Policy，基于请求参数、上下文长度、任务类型、工具调用、模型能力和使用场景选择真实 Provider 与模型。
- Provider 与模型资源管理：集中管理 API Key、订阅额度、本地模型和多个 Provider 下的模型列表。
- Agent 场景路由策略：覆盖 coding、repo 理解、terminal / shell、long context、reasoning、tool calling 等 AI Agent 高频场景。
- 稳定性与 Fallback：在 Provider 限流、失败、超时或模型不可用时自动切换备用模型。
- Agent 级可观测性：按 Agent、Agent API Key 和 Virtual Model Name 记录请求、模型命中、Tokens、成本、失败原因、Fallback 情况和延迟表现。
- 接入配置引导：为不同 Agent 提供 Gateway URL、API Key、Virtual Model Name 和配置示例，降低接入成本。
- 用户自主管理部署与数据：支持部署在个人电脑、本地服务器或云端服务器，并由用户掌控 Provider Key、模型配置、请求日志和数据存储位置。

## 3. 目标用户

### 3.1 Primary User

个人开发者、AI power user、独立开发者、重度 AI Agent 用户。

典型特征：

- 同时使用多个 AI coding agent 或 desktop agent。
- 有多个模型账号或订阅，例如 OpenAI、Claude、Gemini、Copilot、本地模型。
- 经常切换模型或 Provider。
- 想知道每个 Agent 花了多少钱、用了多少 Token、失败率如何。
- 希望简单请求走便宜模型，复杂任务走强模型。

### 3.2 典型 Agent

优先面向这些 AI Agent：

- Codex。
- Claude Code。
- Cursor。
- OpenCode。
- Hermes。
- OpenClaw。
- GitHub Copilot。
- 其他可配置 OpenAI-compatible endpoint 的 AI Agent。

首批支持范围以各 Agent 实际可配置 endpoint 能力为准；如果某个 Agent 的官方闭源能力不支持自定义 Gateway，则只支持其可开放配置的模型请求路径。

## 4. 核心用户故事

### 4.1 统一接入多个 AI Agent

作为个人 AI Agent 用户，我希望把 Codex、Claude Code、Cursor、OpenCode、Hermes、OpenClaw、GitHub Copilot 等 Agent 接到同一个 Gateway，这样真实 Provider、Provider API Key 和真实模型只需要在 LLMIngress 中集中维护；每个 Agent 只需要配置 Gateway URL、Agent API Key，并在 `model` 字段选择 LLMIngress 暴露的 Virtual Model Name。

### 4.2 统一管理模型资源

作为个人 AI Agent 用户，我希望在一个地方配置 OpenAI、Anthropic、Google、OpenRouter、GitHub Copilot 和本地 Ollama，这样所有 Agent 都可以复用同一套模型资源、订阅额度和本地模型能力。

### 4.3 任务感知的模型选择

作为个人 AI Agent 用户，我希望 LLMIngress 能根据我当前任务的复杂度、上下文长度、工具调用、响应质量要求和使用场景，自动选择最合适的真实模型，这样我不需要每次手动判断该用哪个模型。

### 4.4 成本优化

作为个人 AI Agent 用户，我希望简单任务、小改动和低风险请求优先使用低成本模型、本地模型或订阅内模型，只有复杂推理、长上下文分析、关键代码修改等任务才使用更强模型，这样可以避免每次都默认使用最贵最强的模型，减少不必要的模型费用。

### 4.5 质量兜底与自动切换

作为个人 AI Agent 用户，我希望当路由规则在请求前判断低成本模型不适合当前任务，或请求失败、Provider 限流、模型不可用时，Agent 请求能自动切换到更合适的备用模型，避免当前工作流中断，并提升关键任务的完成稳定性。

V1 不承诺对已生成结果进行自动质量判断后再升级模型；质量驱动升级可作为 V2 能力，由用户显式开启 judge / retry 策略。

### 4.6 看清选择原因和节省效果

作为个人 AI Agent 用户，我希望按 Agent 查看每次请求命中的模型、选择原因、Tokens、成本、Fallback 情况和相对固定使用高价模型的节省效果，这样我能理解 LLMIngress 如何帮我平衡质量和费用。

### 4.7 控制预算

作为个人 AI Agent 用户，我希望给单个 Agent API Key 设置成本或 Token 上限，并选择允许使用的 Virtual Model Name，这样可以避免某个 Agent 因循环调用、错误配置或过度使用高价模型造成过量消耗。

## 5. 产品信息架构

LLMIngress 由两大一级产品模块组成：

- Gateway Service：运行时网关服务，负责接收 AI Agent 请求、执行路由策略、转发到真实 Provider，并把 Provider 返回结果交还给 Agent。
- Console：管理控制台，负责 Agent 接入、Provider 配置、模型管理、路由策略、请求观测、成本分析和预算控制。

### 5.1 Gateway Service

Gateway Service 是 LLMIngress 的运行时模块，也是实际处理 Agent 请求的数据面。它可以部署在个人电脑、本地服务器或云端服务器上，对外提供统一 Gateway endpoint。

Gateway Service 包含以下核心能力：

- 接收来自不同 AI Agent 的请求，优先提供 OpenAI-compatible API。
- 识别请求来自哪个 Agent，并校验 Agent API Key。
- 兼容不同 Agent 的请求协议，并统一转发到后端 Provider。
- 根据 Agent API Key、Virtual Model Name、任务类型、复杂度、上下文长度、工具调用和成本偏好匹配 Route Policy。
- 为每次请求选择真实 Provider 和真实模型。
- 把请求转发到 OpenAI、Anthropic、Google、OpenRouter、GitHub Copilot、Ollama。
- 支持流式响应，并把 Provider 返回结果转发给原始 Agent。
- 当 Provider 失败、限流、超时或模型不可用时，自动切换备用模型。
- 记录 Agent、Agent API Key、Virtual Model Name / Route Policy、实际命中的 Provider、实际命中的 Model、Tokens、成本、延迟、失败原因和 Fallback 过程。
- 检查 Agent API Key 级 Token 限制、成本限制、Rate Limit 和预算策略。
- Console 中的配置修改在 Gateway 热加载成功后对新请求生效。
- 展示 Gateway 健康状态、Provider 连通性、运行地址、版本和最近错误。

### 5.2 Console

Console 是 LLMIngress 的管理模块，也是用户配置和观察 Gateway 行为的控制面。Console 不直接处理 Agent 请求，而是管理 Gateway Service 所需的配置，并展示 Gateway Service 产生的运行数据。

Console 包含以下一级模块：

- Overview：查看 Gateway 状态、今日请求量、今日成本、失败率、节省效果和活跃 Agent。
- Agents：管理接入的 AI Agent，包括 Agent 类型、Gateway URL、Agent API Key、Allowed Virtual Model Names、Budget / Limit 和接入说明。
- Providers：配置 OpenAI、Anthropic、Google、OpenRouter、GitHub Copilot、Ollama。
- Models：管理可用模型、模型能力、上下文长度、价格、Provider 归属和是否参与自动路由。
- Virtual Models / Routes：管理全局 Virtual Model Name，并为每个 Virtual Model Name 配置对应 Route Policy、Provider 范围、模型范围、Fallback Chain 和成本偏好。
- Activity：查看每次请求的 Agent、Agent API Key、Virtual Model Name、Provider、命中模型、延迟、Tokens、成本、失败原因和 Fallback 过程。
- Usage & Cost：按 Agent、Agent API Key、Virtual Model Name、Provider、Model 和时间维度分析 Tokens、成本、模型分布和节省效果。
- Limits：配置 Agent API Key 级 Token 上限、成本上限、小时 / 日 / 周 / 月预算、RPM、TPM、并发请求数和超限处理方式。
- Gateway Runtime：查看 Gateway Service 的运行地址、版本、健康检查、Provider 连通性和最近运行错误。
- Playground：使用 Gateway Public API 真实测试 Agent 请求，查看请求会被路由到哪个 Provider 和模型，并查看选择原因。
- Settings：管理服务端口、数据目录、日志保留、安全设置、导入导出和部署相关配置。

### 5.3 模块关系

- 用户在 Console 中创建 Agent，并获得 Gateway URL、Agent API Key 和可用 Virtual Model Name。
- AI Agent 把模型请求发送到 Gateway Service。
- Gateway Service 先通过 Agent API Key 识别身份、权限和预算限制，再通过请求中的 `model` 字段识别 Virtual Model Name / Route Policy。
- Gateway Service 根据 Console 配置的 Providers、Models、Virtual Models / Routes 和 Limits 执行请求转发。
- Provider 返回结果后，Gateway Service 将结果返回给原始 AI Agent。
- Gateway Service 记录请求日志、用量、成本和错误信息，Console 负责展示和分析这些数据。

### 5.4 核心配置关系

LLMIngress 的核心配置关系为：

```text
User
├── AI Agent
│   └── Agent API Key
│       ├── Budget / Limit
│       ├── Usage Attribution
│       └── Allowed Virtual Model Names
│
└── Virtual Model Name / Route Policy
    ├── Provider 范围
    ├── Model 范围
    ├── 成本偏好
    ├── 任务类型规则
    ├── 复杂度规则
    ├── 上下文长度规则
    ├── 工具调用规则
    └── Fallback Chain
```

核心规则：

- Agent API Key 负责身份识别、权限控制、用量归属、Budget 和 Limit。
- Virtual Model Name 负责路由策略选择。
- Virtual Model Name 与 Route Policy 一一对应。
- 用户创建一套路由策略时，会生成或指定一个 Virtual Model Name。
- 相同 Virtual Model Name 始终对应同一套 Route Policy。
- 一个 Agent API Key 可以被授权使用多个 Virtual Model Name。
- 多个 Agent API Key 可以使用同一个 Virtual Model Name。
- Fallback Chain 是 Route Policy 的一部分。
- Provider / Model 是 Route Policy 选择和调用的目标资源。

## 6. Agent 接入能力

### 6.1 Agent 管理

- 创建 Agent。
- 设置 Agent 名称。
- 设置 Agent 类型。
- 设置 Agent 接入平台。
- 查看 Agent 列表。
- 查看 Agent 状态。
- 重命名 Agent。
- 删除 Agent。
- 复制 Agent 配置。
- 为 Agent 生成专属 API Key。
- 轮换 Agent API Key。
- 开启或关闭 Agent 请求记录。

### 6.2 Agent 类型

Agent 分类围绕 AI Agent 的使用形态：

- Coding Agent。
- Desktop Agent。
- Terminal Agent。
- IDE Agent。
- Other Agent。

### 6.3 首批接入对象

- Codex
- Claude Code
- Cursor
- OpenCode
- GitHub Copilot
- Hermes
- OpenClaw
- 其他可配置 OpenAI-compatible endpoint 的 AI Agent。

### 6.4 Agent 接入方式

每个 Agent 接入 LLMIngress 时需要配置：

- Gateway Base URL。
- Agent 专属 API Key。
- 一个或多个被授权使用的 Virtual Model Name。

Agent API Key 用于识别请求来自哪个 Agent，并承载该 Agent 的权限、Budget、Limit 和用量归属。Virtual Model Name 用于指定本次请求采用哪一套路由策略。

控制台需要为不同 Agent 输出接入说明，并支持复制 Gateway URL、Agent API Key 和可用 Virtual Model Name。

能力包括：

- 复制配置片段。
- 校验 Agent 是否已经成功发起请求。
- 查看当前 Agent API Key 可使用的 Virtual Model Name。
- 设置 Agent API Key 的默认 Virtual Model Name。

### 6.5 Agent 状态

- 未配置。
- 已创建但未连接。
- 已连接。
- 最近有请求。
- 最近请求失败。
- Provider 不可用。
- 超出预算限制。

## 7. Gateway 能力

### 7.1 统一入口

- 提供 OpenAI-compatible endpoint。
- 支持 `POST /v1/chat/completions`。
- 支持 `POST /v1/responses`。
- 支持 `POST /v1/messages`。
- 支持 `POST /v1/embeddings`。
- 支持 `GET /v1/models`。
- 优先保证主流 Agent 能够用 OpenAI-compatible 方式接入。
- 为支持 Claude Code，Anthropic-compatible `/v1/messages` endpoint 属于核心接入能力。
- `GET /v1/models` 返回当前 Agent API Key 被授权使用的 Virtual Model Name 列表，而不直接暴露真实 Provider 模型列表。

### 7.2 Virtual Model 抽象

- Agent 请求中的 `model` 字段填写的是 Virtual Model Name。
- Virtual Model Name 就是 Route Policy 的用户可见名称。
- 每个 Virtual Model Name 唯一对应一套 Route Policy。
- 每套 Route Policy 对外暴露为一个 Virtual Model Name。
- 相同 Virtual Model Name 始终对应同一套 Route Policy。
- Virtual Model Name 应在同一个 LLMIngress 实例内保持唯一。
- Agent API Key 可以被授权使用多个 Virtual Model Name。
- Gateway 根据 Agent API Key 识别 Agent，再根据 Virtual Model Name 找到对应 Route Policy。
- 如果请求未指定 `model`，可以使用该 Agent API Key 的默认 Virtual Model Name。

### 7.3 请求能力

- 支持普通文本请求。
- 支持 streaming 响应。
- 支持 tools / function calling 透传。
- 支持常用采样参数透传。
- 支持 max tokens、temperature、top p 等参数。
- 支持 provider-specific 参数。
- 支持请求超时控制。
- 支持客户端主动取消请求。

### 7.4 响应元数据

每次请求的路由过程对用户完全可追溯：通过响应附带的元数据和 Activity 记录，可以看到命中模型、路由原因、Tokens 和成本。响应中不回传完整 API Key，只展示 key prefix。

- Agent。
- Agent API Key prefix。
- Virtual Model Name。
- Route Policy。
- 实际命中的 Provider。
- 实际命中的模型。
- 路由 tier。
- 路由原因。
- Fallback 命中情况。
- 估算输入 Tokens。
- 估算输出 Tokens。
- 估算成本。
- 请求耗时。

### 7.5 Gateway 鉴权

- 每个 Agent 使用独立 API Key。
- API Key 只用于 LLMIngress Gateway。
- API Key 负责身份识别、权限控制、Budget、Limit 和用量归属。
- API Key 可以绑定允许使用的 Virtual Model Name 列表。
- Key 前缀建议使用 `llmi_`。
- Dashboard 显示 key prefix。
- 支持 key 轮换。
- 支持禁用旧 key。

### 7.6 错误反馈

- Gateway 返回统一格式的错误，Agent 端可以区分错误类别。
- 错误至少可区分：Key 无效、无权使用该 Virtual Model、超出预算、超出频率限制、上游 Provider 不可用、Fallback 全部失败、请求超时。
- 每个错误附带 request id，可在 Activity 中定位到对应请求。

### 7.7 Observability Export

- Prometheus metrics。
- OpenTelemetry traces。
- Webhook events。
- JSONL request logs。

## 8. Provider 能力

### 8.1 Provider 类型

支持 AI Agent 常见 Provider 来源：

- API Key Provider。
- Subscription Provider。
- Local Provider。

### 8.2 API Key Provider

支持个人用户输入自己的模型 API Key：

- OpenAI。
- Anthropic。
- Google Gemini。
- OpenRouter。
- DeepSeek。
- xAI。
- Mistral。
- Qwen。
- Moonshot / Kimi。
- MiniMax。
- Groq。
- Fireworks AI。
- Z.ai。

### 8.3 Subscription Provider

支持复用个人已有订阅或 Token Plan：

- ChatGPT Plus / Pro / Team。
- Claude Pro / Max。
- GitHub Copilot。
- Gemini / Google sign-in。
- Kimi Coding Plan。
- GLM Coding Plan。
- OpenCode Go。

Subscription Provider 属于 V2 高风险探索能力，不进入 MVP / V1 范围。涉及 ChatGPT Plus / Pro、Claude Pro / Max、GitHub Copilot 等消费级订阅时，必须明确标注 ToS、封号和协议变更风险。若 Provider 不允许 API 转发，系统应禁用该 Provider 类型，并降级使用官方 API Key Provider 或 Local Provider。

### 8.4 Local Provider

支持本地或自托管模型服务：

- Ollama。
- LM Studio。
- llama.cpp。

### 8.5 Provider 管理

- 添加 Provider。
- 删除 Provider。
- 启用或禁用 Provider。
- 刷新模型列表。
- 查看 Provider 可用模型。
- 查看 Provider 最近连接状态。
- 为同一 Provider 保存多个 Key。
- 给 Key 设置 label。
- 调整 Key 优先级。
- 查看 Key prefix，不展示完整密钥。

同一 Provider 多 Key 支持：

- 同一 Provider 可保存多个 Key，按优先级自动切换，失败的 Key 自动跳过。
- 更智能的多 Key 分配，例如按额度或按负载分配，作为后续增强能力。

### 8.6 Provider 依赖检查

当用户禁用或删除 Provider、Provider Key 或模型时，系统需要先检查依赖关系。

检查范围包括：

- 是否被任意 Virtual Model Name / Route Policy 引用。
- 是否出现在任意 Route Policy 的 Fallback Chain 中。
- 是否被固定模型路由引用。
- 是否参与成本优先、本地优先或质量优先策略的候选模型集合。

如果存在依赖，系统应阻止直接禁用或删除，并展示受影响的 Virtual Model Name / Route Policy，以及当前有权限使用这些 Virtual Model Name 的 Agent API Key 和 Agent。

## 9. 模型发现与模型库

### 9.1 模型发现

- 连接 Provider 后自动拉取模型列表。
- 支持手动刷新模型。
- 支持本地模型同步。
- 支持手动补充已支持 Provider 下的模型元数据。
- 支持模型不可用提示。

### 9.2 模型元数据

每个模型应尽量展示：

- Provider。
- Model ID。
- Display name。
- Context window。
- 输入价格。
- 输出价格。
- 是否支持 streaming。
- 是否支持 tools。
- 是否适合 coding。
- 是否适合 reasoning。
- 是否支持多模态输入。

### 9.3 模型价格

- 展示模型价格。
- 标记免费模型。
- 标记本地模型成本为 0。
- 用价格估算 Agent 消费。
- 用价格参与路由建议。
- 支持内置价格表。
- 支持用户手动覆盖价格。
- 支持从 Provider 或模型 registry 同步价格。
- 未知价格模型不参与成本优化路由，除非用户手动确认价格。

## 10. Virtual Model / Routing 能力

### 10.1 Virtual Model Name

Virtual Model Name 是 Agent 请求中填写的模型名，也是 Route Policy 的用户可见入口。

每个 Virtual Model Name 对应：

- 一套 Route Policy。
- 可用 Provider 范围。
- 可用模型范围。
- 成本偏好：省钱优先、平衡、质量优先。
- 任务类型规则。
- 复杂度规则。
- 上下文长度规则。
- 工具调用规则。
- Fallback Chain。
- 是否启用。

### 10.2 Agent API Key 与 Virtual Model 权限

- 每个 Agent API Key 可以被授权使用多个 Virtual Model Name。
- Agent 请求中的 API Key 决定身份、权限、Budget、Limit 和用量归属。
- Agent 请求中的 `model` 字段决定使用哪套 Route Policy。
- 如果 Virtual Model Name 不存在、已禁用，或当前 API Key 无权使用，Gateway 应拒绝请求并返回明确错误。
- 如果 Agent 未指定 `model`，可以使用该 Agent API Key 的默认 Virtual Model Name。

### 10.3 Route Policy

Route Policy 是 Virtual Model Name 背后的真实路由规则。

Route Policy 支持：

- 按任务复杂度选择模型。
- 按上下文长度选择模型。
- 按工具调用需求选择模型。
- 按 coding、reasoning、long context、terminal / shell 等任务类型选择模型。
- 按成本优先级选择低成本模型、本地模型或订阅内模型。
- 固定到某个 Provider / Model。
- 配置备用 Provider / Model。
- 配置请求超时、重试和 Fallback 行为。

Route Policy 不承载 Budget / Limit。Budget / Limit 配置在 Agent API Key 上。

### 10.4 路由决策机制

V1 路由采用确定性规则引擎，不默认额外调用 LLM 分类器。V2 可加入可选任务分类器或 judge，但必须展示额外延迟和成本。

信号来源：

- Agent 类型。
- Agent API Key。
- Virtual Model Name。
- 请求协议。
- 输入 token 估算。
- 是否包含 tools / function calling。
- 是否包含 repo、terminal、shell、diff、测试日志等特征。
- 用户显式配置的 task hint。
- Route Policy 中的固定规则。

成本偏好语义：

- 省钱优先：在满足请求的基本要求，例如上下文长度和工具调用能力的前提下，优先最低成本模型。
- 平衡：综合模型能力、价格、延迟和健康状态。
- 质量优先：优先高能力模型，仅在成本或预算受限时降级。

路由行为承诺：

- 用户固定指定的模型永远优先于自动路由。
- 自动路由永远不会选中不满足请求要求的模型，例如上下文不够或不支持工具调用。
- 每次路由结果都附带用户可读的选择原因。
- V1 路由是确定性的：同样的请求和配置得到同样的路由结果。

### 10.5 运行时逻辑

1. 请求进入 Gateway。
2. 通过 API Key 识别 Agent / API Key。
3. 检查 API Key 是否可用、是否超出 Budget / Limit / Rate Limit。
4. 读取请求里的 `model` 字段。
5. 根据 `model` 找到对应 Virtual Model Name / Route Policy。
6. 检查该 API Key 是否有权限使用这个 Virtual Model Name。
7. 执行 Route Policy，选择真实 Provider / Model。
8. 请求真实 Provider。
9. 记录 Usage 到 Agent API Key，同时记录本次请求使用的 Virtual Model Name / Route Policy、实际命中的 Provider、实际命中的 Model、Tokens、成本、延迟、Fallback 情况和失败原因。
10. 将 Provider 返回结果返回给原始 AI Agent。

## 11. Fallback 能力

### 11.1 Fallback Chain

- Fallback Chain 是 Route Policy 的一部分。
- 每个 Virtual Model Name / Route Policy 可配置独立 Fallback Chain。
- Fallback 按顺序尝试。
- 每条链最多建议 5 个备用模型。
- 可混合 API Key Provider、Subscription Provider、本地模型。
- Fallback 过程需要记录原始失败 Provider / Model、最终成功 Provider / Model 和每次失败原因。

### 11.2 触发条件

Fallback 只在首包前失败时自动切换备用模型。首包后 streaming 中断时，V1 不自动重放请求，避免 Agent 收到重复或冲突内容；中断会被完整记录在 Activity 中，用户能看到失败发生在响应中途。

- Provider 5xx。
- Provider 429。
- Provider timeout。
- Provider 认证失败。
- 模型不可用。
- 请求被 Provider 拒绝。
- Streaming 首包前失败。

不属于 V1 自动 Fallback：

- 模型回答质量不佳。
- 用户不满意输出。
- 首包后已产生部分内容的流式失败。

### 11.3 用户可见结果

- 展示原始失败模型。
- 展示最终成功模型。
- 展示 fallback 次数。
- 展示每次失败原因。
- 在 Activity 中记录 fallback 事件。

## 12. 用量与预算

成本统计优先采用 Provider 实际计费数据；无法获得实际数据时使用估算值，估算值在界面上明确标注。

### 12.1 Agent / API Key 用量统计

- 按 Agent 统计请求数、Tokens、成本、失败率和平均延迟。
- 按 Agent API Key 统计请求数、Tokens、成本、失败率和平均延迟。
- 按 Agent API Key 记录 Budget / Limit 使用情况。
- 单独记录 Prompt caching、cached input token 和 reasoning token。

### 12.2 Virtual Model / Provider / Model 统计

- 按 Virtual Model Name / Route Policy 查看请求数、Tokens、成本、失败率和平均延迟。
- 按实际命中的 Provider 查看成本。
- 按实际命中的 Model 查看成本。
- 查看最常用模型。
- 查看最贵模型。
- 查看失败最多的模型。

### 12.3 预算限制

- 给单个 Agent API Key 设置 Token 上限。
- 给单个 Agent API Key 设置成本上限。
- 支持小时、天、周、月周期。
- 支持达到阈值后提醒。
- 支持达到阈值后阻断请求。
- 支持手动重置或修改限制。
- 支持限制 Agent API Key 可使用的 Virtual Model Name。

### 12.4 Rate Limiting

除 Budget / Token Limit 外，Agent API Key 支持 RPM、TPM 和并发请求数限制。

- RPM：限制每分钟请求数。
- TPM：限制每分钟 token 估算消耗。
- Concurrency：限制同一 Agent API Key 的并发请求。
- 超限时返回频率限制错误。
- Rate Limit 用于快速阻断 Agent 循环调用；Budget 用于控制成本上限。

### 12.5 成本节省

- 估算 auto routing 相比用户指定基线模型节省的成本。
- 若用户未指定基线模型，则使用该 Virtual Model Name 的质量优先默认模型作为基线，并在 Usage 页面明确展示基线模型名称。
- 展示节省金额。
- 展示节省百分比。
- 展示低成本模型命中比例。
- 按 Agent API Key 和 Virtual Model Name 展示节省效果。

## 13. Activity / Logs

### 13.1 请求日志

- 查看所有 Agent 请求。
- 按 Agent 筛选。
- 按 Agent API Key 筛选。
- 按 Virtual Model Name / Route Policy 筛选。
- 按实际命中的 Provider 筛选。
- 按实际命中的 Model 筛选。
- 按状态筛选。
- 按时间范围筛选。
- 按成本范围筛选。
- 按 routing tier 或 route reason 筛选。

### 13.2 请求详情

详情页展示：

- Agent。
- Agent API Key prefix。
- Virtual Model Name。
- Route Policy。
- 实际命中的 Provider。
- 实际命中的 Model。
- Routing tier。
- Routing reason。
- Fallback 信息。
- Tokens。
- Cost。
- Latency。
- Status。
- Error message。
- Request metadata。
- Response metadata。

### 13.3 内容记录

- 默认可只记录 metadata。
- 用户可选择是否记录 prompt / response 内容。
- 可按 Agent 或 Agent API Key 开关内容记录。
- 可删除单条记录。
- 可一键清空某个 Agent 的记录。

## 14. Console 页面与功能

### 14.1 首页

- 显示 Gateway 状态。
- 显示最近请求。
- 显示今日成本。
- 显示今日 Tokens。
- 显示活跃 Agent。
- 显示 Provider 健康状态。

### 14.2 Agents 页面

- Agent 列表。
- 创建 Agent。
- Agent 连接状态。
- Agent API Key。
- Agent API Key 的 Allowed Virtual Model Names。
- Agent API Key 的 Budget / Limit。
- Agent 接入说明。
- Agent 用量摘要。
- Agent 设置入口。

### 14.3 Providers 页面

- Provider 列表。
- 添加 Provider。
- Provider Key 管理。
- 本地模型状态。
- 模型列表刷新。
- Provider 连接测试。

### 14.4 Virtual Models / Routes 页面

- 全局 Virtual Model Name 列表。
- 创建 Virtual Model Name。
- 绑定或编辑 Route Policy。
- 配置省钱优先、平衡、质量优先策略。
- 配置任务类型规则。
- 配置复杂度规则。
- 配置上下文长度规则。
- 配置工具调用规则。
- 配置可用 Provider 范围。
- 配置可用模型范围。
- 配置 Fallback Chain。
- Model picker。
- Provider picker。
- 查看该 Virtual Model Name 的请求量、成本、命中模型和失败率。
- 检查 Provider / Model 依赖关系。
- 禁用或删除 Virtual Model Name。

### 14.5 Usage 页面

- Token chart。
- Cost chart。
- Agent cost breakdown。
- Agent API Key cost breakdown。
- Virtual Model Name cost breakdown。
- Model cost breakdown。
- Provider cost breakdown。
- Savings summary。

### 14.6 Activity 页面

- 请求列表。
- 请求详情。
- Fallback 事件。
- Error 事件。
- Recording 管理。

### 14.7 Limits 页面

- Agent API Key limit rules。
- 成本限制。
- Token 限制。
- RPM / TPM 限制。
- 并发请求数限制。
- Allowed Virtual Model Names。
- 通知配置。
- 阻断策略。

V1 通知渠道支持：

- Email。
- Webhook。

Desktop notification / 本机系统通知暂不纳入 V1；后续如需支持，再单独定义。

告警事件包括：

- Provider 连续失败。
- Fallback Chain 耗尽。
- Budget 接近阈值。
- Rate Limit 高频触发。

### 14.8 Playground 页面

- 在浏览器中通过 Gateway Public API 测试 prompt。
- 用户手动粘贴 Agent API Key；该 key 只保存在页面内存中，不由 Console 后端保存或代发。
- 根据用户输入的 Agent API Key 调用 `GET /v1/models`，展示该 key 被授权使用的 Virtual Model Name。
- 选择 Virtual Model Name 作为请求中的 `model`。
- 查看模型响应、routing metadata、request id 和成本 / token 信息。
- 可以对比不同 Virtual Model Name / Route Policy 的输出，但每次测试都是 live 请求，会产生真实 Provider 成本，并计入该 Agent API Key 的 Budget / Rate Limit / Usage。

由于 Agent API Key 只保存 hash，Console 不能在 Playground 中直接使用已有 key 明文。创建或轮换 Agent API Key 时用户需要自行复制保存；后续 Playground 测试需要再次粘贴。

## 15. 部署与数据

### 15.1 Gateway 部署

- LLMIngress 可以运行在个人电脑、本地服务器或云端服务器上。
- 个人电脑部署时默认监听 localhost；服务器部署时可按需绑定内网或公网地址。
- 默认不暴露到公网。
- 支持自定义端口。
- 支持开机自启。
- V1 默认一个 active Gateway 进程处理请求；多 Gateway 实例属于后续扩展能力。

部署形态：

- Local / single-node：面向个人电脑或本地服务器，默认监听 `127.0.0.1`，需要连接 PostgreSQL。
- Docker / server：面向本地服务器或云服务器，默认不暴露公网。
- Single binary：面向轻量自托管部署，但仍需要外部 PostgreSQL 或由 supervisor / compose 管理的 PostgreSQL sidecar，不是零依赖单文件数据库形态。

开源许可、商业许可和分发方式由 README / LICENSE 单独定义，PRODUCT.md 不默认承诺。

### 15.2 数据存储

- 保存 Agent 配置。
- 保存 Agent API Key 配置。
- 保存 Agent API Key 的 Allowed Virtual Model Names 和 Budget / Limit。
- 保存 Provider 配置。
- 保存 Virtual Model Name / Route Policy 配置。
- 保存模型缓存。
- 保存请求 metadata。
- 保存可选请求内容。
- 保存统计数据。

### 15.3 数据导出与清理

- 导出请求记录。
- 导出成本报表。
- 导出 Provider / Model / Route Policy 配置。
- 导入配置备份。
- 升级前自动备份配置数据库。
- 提供数据迁移机制。
- 支持日志保留周期和日志轮转。
- 清空日志。
- 清空 prompt / response 内容但保留 metadata。
- 删除 Agent 数据。
- 删除 Provider 凭据。

## 16. 安全与隐私

### 16.1 凭据保护

- Provider API Key 加密存储。
- Subscription Token 加密存储。
- Agent API Key hash 存储。
- Agent API Key 明文只在创建或轮换时展示一次；Playground 测试需要用户重新粘贴明文 key。
- Dashboard 不默认展示完整 Provider Key。
- 支持轮换 Agent Key。

### 16.2 用户自主管理

- 配置和日志保存在用户选择的部署环境中。
- 本地模型请求不离开用户配置的本地或自托管模型服务。
- 用户可选择是否记录 prompt / response。
- 默认不上传请求内容。

### 16.3 网络安全

- 个人电脑部署默认只监听 `127.0.0.1`；服务器部署可显式配置监听地址。
- 用户显式配置后才允许 LAN 或公网访问。
- Cloud Provider 请求只发送到用户配置的 Provider。

### 16.4 Console 鉴权

Console 必须支持访问控制，尤其是服务器或公网部署场景。

- 本地 localhost 模式可允许首次无密码引导。
- 非 localhost 监听必须启用 Console 登录。
- 支持设置管理员密码。
- 支持禁用公网访问。
- 所有 Provider Key、Subscription Token、Agent API Key 操作需要鉴权。

## 17. 非功能需求、成功指标与版本规划

### 17.1 非功能需求

- V1 路由决策不额外调用 LLM。
- Gateway 规则路由额外延迟目标：p95 小于 100ms，不包含上游 Provider 延迟。
- Streaming 首包代理额外延迟目标：p95 小于 200ms，不包含上游 Provider 首包时间。
- 配置修改经 Gateway 热加载成功后对新请求近实时生效，不影响进行中的请求。
- 服务器部署必须支持 Console 鉴权。
- 默认不记录 prompt / response 内容。

### 17.2 成功指标

- 首个 Agent 接入耗时。
- 请求成功率。
- Fallback 成功率。
- Fallback Chain 耗尽率。
- Route Policy 命中解释覆盖率。
- 相比基线模型的成本节省比例。
- Budget / Rate Limit 阻断次数。
- Provider 平均延迟和失败率。

### 17.3 版本规划

MVP：

- OpenAI-compatible `/v1/chat/completions`、`/v1/responses`。
- Anthropic-compatible `/v1/messages`。
- Agent API Key。
- Virtual Model Name / Route Policy。
- API Key Provider。
- Local Provider。
- 确定性规则路由。
- Fallback Chain。
- Usage / Cost / Activity。
- Budget、Token Limit、RPM、TPM。
- Console 鉴权。

V1：

- Embeddings endpoint。
- Provider 多 Key failover。
- Prometheus / OpenTelemetry / Webhook export。
- 配置导入导出。
- Prompt caching 成本核算。
- 首批 Agent 专用接入模板，例如 Codex、Claude Code、Cursor、OpenClaw 等。

V2：

- 可选 LLM 分类器。
- 可选质量 judge。
- Semantic cache。
- Subscription Provider（高风险探索能力）。
- Quota-aware key balancing。
- 更多 Agent 专用接入模板。

## 18. 产品边界

LLMIngress 是单用户 AI Agent Gateway。产品优先解决个人开发者在多个 AI Agent、多个 Provider 和多个模型之间的接入、路由、Fallback、成本控制和可观测性问题。

产品焦点：

- 让 AI Agent 通过一个统一 endpoint 接入模型能力。
- 在 Gateway 后方统一管理多个 Provider 和模型。
- 根据请求参数、上下文、任务类型、工具调用和模型能力自动匹配合适模型。
- 为 AI Agent 提供 Fallback、用量统计、成本控制、Rate Limit 和请求可观测性。
- 保持用户自主管理的数据与凭据方式。

Non-goals：

- 不做团队协作和多租户权限系统。
- 不做 prompt 管理平台。
- 不做 fine-tuning 平台。
- 不做模型训练或模型托管平台。
- 不支持 Custom Provider / 任意自定义 endpoint。
- 不默认代理图像、音频、视频生成端点。
- 不绕过 Provider ToS 或反爬限制。
- 不保证所有商业 Agent 的全部原生功能可通过 Gateway endpoint 保留；支持范围以各 Agent 可配置 endpoint 能力为准。
